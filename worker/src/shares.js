import { MAX_SHARE_BYTES, SHARE_ID, SHARE_TOKEN, parseSharedBoard } from "../../share-model.js";

export async function handleShares(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.APP_URLS || "").split(",").map((value) => {
    try { return new URL(value.trim()).origin; } catch { return ""; }
  });
  // GitHub Pages can explicitly share without enabling Google OAuth there.
  allowed.push("https://kydchen.github.io");
  const cors = allowed.includes(origin) ? origin : "*";
  const reply = (value, status = 200, headers = {}) => new Response(
    value === null ? null : JSON.stringify(value), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": cors,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, If-None-Match",
        "Access-Control-Expose-Headers": "ETag",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "X-Content-Type-Options": "nosniff",
        Vary: "Origin",
        ...headers,
      },
    },
  );
  const fail = (error, status) => reply({ error }, status);
  const id = new URL(request.url).pathname.split("/")[2];
  if (!SHARE_ID.test(id || "") || new URL(request.url).pathname !== `/shares/${id}`) return fail("shareMissing", 404);
  if (!env.SHARES || !env.SHARE_WRITES || !env.SHARE_CREATES) return fail("shareUnavailable", 503);
  if (request.method === "OPTIONS") return allowed.includes(origin) ? reply(null, 204) : fail("shareForbidden", 403);
  try {
    const client = request.headers.get("CF-Connecting-IP") || "local";
    if (request.method === "GET") {
      if (!(await env.SHARE_WRITES.limit({ key: `read:${client}:${id}` })).success) return fail("shareRateLimited", 429);
      const row = await env.SHARES.prepare("SELECT payload, revision, updated_at FROM shares WHERE id = ?").bind(id).first();
      if (!row?.payload) return fail("shareMissing", 404);
      const etag = `"${row.revision}"`;
      if (request.headers.get("If-None-Match") === etag) return reply(null, 304, { ETag: etag });
      return reply({ ...JSON.parse(row.payload), updatedAt: row.updated_at }, 200, { ETag: etag });
    }
    if (!["POST", "PUT", "DELETE"].includes(request.method)) return fail("shareInvalid", 405);
    if (!allowed.includes(origin)) return fail("shareForbidden", 403);
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    if (!SHARE_TOKEN.test(token || "")) return fail("shareForbidden", 403);
    if (!(await env.SHARE_WRITES.limit({ key: `write:${client}:${id}` })).success) return fail("shareRateLimited", 429);
    const writeHash = await hashToken(token);
    const row = await env.SHARES.prepare("SELECT write_hash, payload IS NOT NULL AS active, revision FROM shares WHERE id = ?").bind(id).first();
    if (row && row.write_hash !== writeHash) return fail("shareForbidden", 403);
    if (request.method === "DELETE") {
      if (!row && !(await env.SHARE_CREATES.limit({ key: client })).success) return fail("shareRateLimited", 429);
      // Also tombstone an unconfirmed create, so losing its response is safe to recover from.
      if (row) {
        await env.SHARES.prepare("UPDATE shares SET payload = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND write_hash = ?")
          .bind(Date.now(), id, writeHash).run();
      } else {
        const result = await env.SHARES.prepare("INSERT INTO shares (id, write_hash, payload, updated_at) SELECT ?, ?, NULL, ? WHERE (SELECT COUNT(*) FROM shares) < 20000 ON CONFLICT(id) DO UPDATE SET payload = NULL, revision = revision + 1, updated_at = excluded.updated_at WHERE shares.write_hash = excluded.write_hash")
          .bind(id, writeHash, Date.now()).run();
        if (!result.meta.changes) return fail("shareCapacity", 409);
      }
      return reply(null, 204);
    }
    if (row && !row.active) return fail("shareMissing", 410);
    if (request.method === "POST" && row) return reply({ revision: row.revision }); // Idempotent create retry; never overwrite.
    if (request.method === "PUT" && !row) return fail("shareMissing", 404);
    if (request.method === "POST" && !(await env.SHARE_CREATES.limit({ key: client })).success) return fail("shareRateLimited", 429);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return fail("shareInvalid", 415);
    let payload;
    try { payload = JSON.stringify(parseSharedBoard(await limitedText(request))); }
    catch (error) { return fail(error.message === "shareTooLarge" ? "shareTooLarge" : "shareInvalid", error.message === "shareTooLarge" ? 413 : 400); }
    if (request.method === "POST") {
      // ponytail: cap anonymous storage at 1,000 active 256 KiB boards; raise after measuring demand.
      const result = await env.SHARES.prepare("INSERT INTO shares (id, write_hash, payload, updated_at) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM shares WHERE payload IS NOT NULL) < 1000 AND (SELECT COUNT(*) FROM shares) < 20000 ON CONFLICT(id) DO NOTHING")
        .bind(id, writeHash, payload, Date.now()).run();
      return result.meta.changes ? reply({ revision: 1 }, 201) : fail("shareCapacity", 409);
    }
    const expected = Number(request.headers.get("If-Match")?.replaceAll('"', ""));
    if (!Number.isSafeInteger(expected) || expected < 1) return fail("shareConflict", 409);
    const result = await env.SHARES.prepare("UPDATE shares SET payload = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND write_hash = ? AND revision = ? AND payload IS NOT NULL")
      .bind(payload, Date.now(), id, writeHash, expected).run();
    return result.meta.changes ? reply({ revision: expected + 1 }) : fail("shareConflict", 409);
  } catch {
    return fail("shareUnavailable", 503);
  }
}

async function hashToken(token) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function limitedText(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_SHARE_BYTES) throw new Error("shareTooLarge");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("shareInvalid");
  let size = 0;
  let text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > MAX_SHARE_BYTES) throw new Error("shareTooLarge");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
}

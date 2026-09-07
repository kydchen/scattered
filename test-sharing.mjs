import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { handleShares } from "./worker/src/shares.js";
import { createLiveShare } from "./live-share.js";
import { blankBoard } from "./model.js";
import { MAX_SHARE_BYTES, encodeSharedBoard } from "./share-model.js";

// Exercise the actual SQL with SQLite, rather than mocking successful database writes.
export function testEnvironment() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./worker/schema.sql", import.meta.url), "utf8"));
  return {
    db,
    APP_URLS: "https://scatterednote.space/,http://localhost:4173/",
    SHARE_WRITES: { limit: async () => ({ success: true }) },
    SHARE_CREATES: { limit: async () => ({ success: true }) },
    SHARES: {
      prepare(sql) {
        return { bind(...values) {
          return {
            first: async () => db.prepare(sql).get(...values),
            run: async () => ({ meta: { changes: db.prepare(sql).run(...values).changes } }),
          };
        } };
      },
    },
  };
}

async function checks() {
  const env = testEnvironment();
  const id = "a".repeat(32);
  const token = "b".repeat(64);
  const board = { ...blankBoard(), title: "Presentation", nodes: [{ id: "n", text: "Hello", width: 218, x: 10, y: 20, color: "plain" }] };
  const payload = encodeSharedBoard(board);
  const request = (method, { body = payload, key = token, origin = "https://scatterednote.space", revision, shareId = id, headers = {} } = {}) => handleShares(new Request(`https://sync.scatterednote.space/shares/${shareId}`, {
    method,
    headers: { Origin: origin, "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(revision ? { "If-Match": `"${revision}"` } : {}), ...headers },
    ...(["POST", "PUT"].includes(method) ? { body } : {}),
  }), env);
  assert.equal((await request("GET")).status, 404);
  assert.equal((await request("POST", { key: null })).status, 403);
  assert.equal((await request("POST", { origin: "https://evil.example" })).status, 403);
  assert.equal((await request("POST", { body: "{bad" })).status, 400);
  assert.equal((await request("POST", { body: "x".repeat(MAX_SHARE_BYTES + 1) })).status, 413);
  const malformed = JSON.parse(payload);
  malformed.board.nodes[0].x = "NaN";
  assert.equal((await request("POST", { body: JSON.stringify(malformed) })).status, 400);
  assert.equal((await request("POST")).status, 201);
  assert.equal((await request("POST", { body: encodeSharedBoard({ ...board, title: "Do not overwrite" }) })).status, 200);
  const shown = await request("GET", { key: null });
  assert.equal(shown.headers.get("Cache-Control"), "no-store");
  assert.equal(shown.headers.get("ETag"), '"1"');
  const publicData = await shown.json();
  assert.equal(publicData.board.title, "Presentation");
  assert.equal(/token|write_hash/.test(JSON.stringify(publicData)), false);
  assert.equal((await request("GET", { headers: { "If-None-Match": '"1"' } })).status, 304);
  assert.equal((await request("GET", { headers: { "If-None-Match": 'W/"1"' } })).status, 304);
  assert.equal((await request("GET", { headers: { "If-None-Match": '"0", W/"1"' } })).status, 304);
  assert.equal((await request("GET", { headers: { "If-None-Match": 'W/"0"' } })).status, 200);
  assert.equal((await request("PUT", { key: "c".repeat(64), revision: 1 })).status, 403);
  assert.equal((await request("DELETE", { key: "c".repeat(64) })).status, 403);
  assert.equal((await request("PUT")).status, 409);
  assert.equal((await request("PUT", { revision: 1, body: encodeSharedBoard({ ...board, title: "Updated" }) })).status, 200);
  assert.equal((await request("PUT", { revision: 1 })).status, 409);
  assert.equal((await (await request("GET")).json()).board.title, "Updated");
  assert.equal((await request("DELETE")).status, 204);
  assert.equal((await request("GET")).status, 404);
  assert.equal((await request("PUT", { revision: 2 })).status, 410);
  assert.equal((await request("POST")).status, 410);
  assert.equal(env.db.prepare("SELECT payload FROM shares WHERE id = ?").get(id).payload, null);
  env.SHARE_CREATES.limit = async () => ({ success: false });
  assert.equal((await request("POST", { shareId: "f".repeat(32) })).status, 429);
  env.SHARE_CREATES.limit = async () => ({ success: true });
  // Revoking an uncertain initial upload prevents its late arrival from reopening the link.
  assert.equal((await request("DELETE", { shareId: "e".repeat(32) })).status, 204);
  assert.equal((await request("POST", { shareId: "e".repeat(32) })).status, 410);
  assert.equal((await request("POST", { shareId: "d".repeat(32), origin: "https://kydchen.github.io" })).status, 201);
  env.db.exec("BEGIN");
  for (let index = 0; index < 1000; index += 1) env.db.prepare("INSERT INTO shares (id, write_hash, payload, updated_at) VALUES (?, ?, ?, ?)").run(`capacity-${index}`, "hash", payload, 0);
  assert.equal((await request("POST", { shareId: "f".repeat(32) })).status, 409);
  env.db.exec("ROLLBACK");
  // Client opts in only one board, persists capability before sending, and isolates account scopes.
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  let scope = "guest";
  let boards = [{ id: "chosen", board }, { id: "private", board: { ...board, title: "PRIVATE" } }];
  let uploads = 0;
  let online = true;
  const options = {
    apiUrl: "https://sync.scatterednote.space", storage,
    getScope: () => scope, getBoards: () => boards,
    fetcher: async (url, init) => {
      assert.ok(values.size > 0, "Write capability must already be saved");
      if (!online) throw new Error("offline");
      uploads += 1;
      assert.equal(init.body?.includes("PRIVATE") || false, false);
      return handleShares(new Request(url, { ...init, headers: { ...init.headers, Origin: "https://scatterednote.space" } }), env);
    },
  };
  let client = createLiveShare(options);
  await client.update();
  assert.equal(uploads, 0);
  await client.enable("chosen");
  const first = client.current("chosen");
  assert.equal(first.ready, true);
  const count = uploads;
  await client.update();
  boards[0].board = { ...board, view: { x: 20, y: 20, scale: .2 } };
  await client.update();
  assert.equal(uploads, count, "Panning is not a content update");
  boards[0].board = { ...board, title: "Live edit" };
  await client.update();
  assert.equal(uploads, count + 1);
  client = createLiveShare(options);
  assert.equal(client.current("chosen").id, first.id, "Reload preserves link");
  scope = "another-account";
  await client.update();
  assert.equal(client.current("chosen"), null);
  assert.equal(uploads, count + 1, "Switching accounts does not publish a different account to an existing link");
  scope = "guest";
  online = false;
  await assert.rejects(() => client.stop("chosen"));
  assert.equal(client.current("chosen").id, first.id, "Offline stop preserves management capability");
  boards[0].board = { ...board, title: "Offline edit" };
  await client.update();
  online = true;
  await client.update();
  assert.equal((await (await request("GET", { shareId: first.id })).json()).board.title, "Offline edit");
  await client.stop("chosen");
  assert.equal(client.current("chosen"), null);
  assert.equal((await request("GET", { shareId: first.id })).status, 404);
  await client.enable("chosen");
  assert.notEqual(client.current("chosen").id, first.id, "Resharing never reactivates a revoked URL");
  const removedId = client.current("chosen").id;
  boards = boards.filter((item) => item.id !== "chosen");
  await client.update();
  assert.equal((await request("GET", { shareId: removedId })).status, 404);
  const brokenStorage = createLiveShare({ ...options, storage: { getItem: () => null, setItem: () => { throw new Error("full"); } } });
  boards = [{ id: "chosen", board }];
  const beforeBroken = uploads;
  await assert.rejects(() => brokenStorage.enable("chosen"));
  assert.equal(uploads, beforeBroken, "Never upload if the management credential cannot be persisted");
  assert.doesNotMatch(readFileSync(new URL("./present.js", import.meta.url), "utf8"), /localStorage|sessionStorage|drive-sync|workspace\.js|app\.js/);
  assert.doesNotMatch(readFileSync(new URL("./present.html", import.meta.url), "utf8"), /beacon|app\.js/);
  env.db.close();
  console.log("live sharing checks passed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checks();

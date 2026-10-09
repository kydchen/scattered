import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import worker, { openSession, sealSession, signState, verifyState } from "./src/index.js";

const secret = "test-only-secret-with-at-least-32-characters";
const tamper = (value) => {
  const index = Math.floor(value.length / 2);
  return `${value.slice(0, index)}${value[index] === "a" ? "b" : "a"}${value.slice(index + 1)}`;
};
const session = await sealSession({ refreshToken: "refresh-token", issuedAt: 1 }, secret);
assert.equal((await openSession(session, secret)).refreshToken, "refresh-token");
await assert.rejects(() => openSession(tamper(session), secret));
await assert.rejects(() => openSession(session, `${secret}-wrong`));

const state = await signState({ returnTo: "https://example.com/app/", expiresAt: 2_000 }, secret);
assert.equal((await verifyState(state, secret, 1_000)).returnTo, "https://example.com/app/");
await assert.rejects(() => verifyState(tamper(state), secret, 1_000));
await assert.rejects(() => verifyState(state, secret, 3_000));

const oauthStart = await worker.fetch(new Request(
  "https://worker.example/oauth/start?return_to=https%3A%2F%2Fscatterednote.space%2F",
), {
  APP_URLS: "https://scatterednote.space/",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: secret,
});
const authorizationUrl = new URL(oauthStart.headers.get("Location"));
assert.equal(authorizationUrl.searchParams.get("prompt"), "consent select_account");
assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://worker.example/oauth/callback");

// Preview access is exact-origin only. No wildcard previews or local-only site.
const deployment = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8"));
const syncConfig = readFileSync(new URL("../sync-config.js", import.meta.url), "utf8");
const env = { ...deployment.vars, GOOGLE_CLIENT_ID: "client-id", GOOGLE_CLIENT_SECRET: "client-secret", SESSION_SECRET: secret };
for (const [origin, allowed] of [
  ["https://scatterednote.space", true], ["https://www.scatterednote.space", true],
  ["https://scattered.pages.dev", true], ["http://localhost:4173", true],
  ["https://codex-sync-preview.scattered.pages.dev", true],
  ["https://other-preview.scattered.pages.dev", false], ["https://kydchen.github.io", false],
  ["https://codex-sync-preview.scattered.pages.dev.example.com", false],
]) {
  assert.equal(deployment.vars.APP_URLS.split(",").includes(`${origin}/`), allowed);
  const configured = runInNewContext(
    `${syncConfig.replace("export const", "const")}\nDRIVE_SYNC_API`, { location: { origin } },
  );
  assert.equal(configured, allowed ? "https://sync.scatterednote.space" : "");
  const start = await worker.fetch(new Request(`https://worker.example/oauth/start?${new URLSearchParams({ return_to: `${origin}/` })}`), env);
  assert.equal(start.status, allowed ? 302 : 400);
  if (allowed) {
    const target = new URL(start.headers.get("Location"));
    assert.equal(target.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.appdata");
    assert.equal(target.searchParams.get("redirect_uri"), "https://worker.example/oauth/callback");
    assert.equal((await verifyState(target.searchParams.get("state"), secret)).returnTo, `${origin}/`);
  }
  const preflight = await worker.fetch(new Request("https://worker.example/token", { method: "OPTIONS", headers: { Origin: origin } }), env);
  assert.equal(preflight.status, allowed ? 204 : 403);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), allowed ? origin : null);
  const token = await worker.fetch(new Request("https://worker.example/token", { method: "POST", headers: { Origin: origin } }), env);
  assert.equal(token.status, allowed ? 401 : 403, "Origin permission never bypasses session authentication");
}

console.log("worker checks passed");

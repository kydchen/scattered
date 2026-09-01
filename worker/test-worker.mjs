import assert from "node:assert/strict";
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
  "https://worker.example/oauth/start?return_to=https%3A%2F%2Fscattered.pages.dev%2F",
), {
  APP_URLS: "https://scattered.pages.dev/",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  SESSION_SECRET: secret,
});
const authorizationUrl = new URL(oauthStart.headers.get("Location"));
assert.equal(authorizationUrl.searchParams.get("prompt"), "consent select_account");

console.log("worker checks passed");

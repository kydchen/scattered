import assert from "node:assert/strict";
import { openSession, sealSession, signState, verifyState } from "./src/index.js";

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

console.log("worker checks passed");

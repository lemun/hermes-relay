import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createActionCapabilityStore,
  createTotpVerifier,
} from "../lib/step-up-auth.mjs";

test("verifies the RFC 6238 SHA-1 vector with an injected clock", () => {
  const verifier = createTotpVerifier({
    secret: Buffer.from("12345678901234567890"),
    digits: 8,
    window: 0,
    clock: () => 59_000,
  });
  assert.deepEqual(verifier.verify("94287082"), { ok: true });
});

test("rejects malformed, out-of-window, and reused TOTP codes", () => {
  let now = 59_000;
  const verifier = createTotpVerifier({
    secret: Buffer.from("12345678901234567890"),
    digits: 8,
    window: 0,
    clock: () => now,
  });
  assert.deepEqual(verifier.verify("9428708"), { ok: false, reason: "malformed_code" });
  assert.deepEqual(verifier.verify("9428708x"), { ok: false, reason: "malformed_code" });
  assert.deepEqual(verifier.verify("94287082"), { ok: true });
  assert.deepEqual(verifier.verify("94287082"), { ok: false, reason: "reused_code" });
  now = 89_000;
  assert.deepEqual(verifier.verify("94287082"), { ok: false, reason: "invalid_code" });
});

test("accepts only the configured TOTP window and does not expose the secret", () => {
  const secret = Buffer.from("12345678901234567890");
  const verifier = createTotpVerifier({
    secret,
    digits: 8,
    window: 1,
    clock: () => 89_000,
  });
  assert.deepEqual(verifier.verify("94287082"), { ok: true });
  assert.equal("secret" in verifier, false);
  assert.doesNotMatch(JSON.stringify(verifier), /12345678901234567890/);
});

test("supports RFC 6238 SHA-256 and an injected replay cache", () => {
  const replayCache = new Set();
  const options = {
    secret: Buffer.from("12345678901234567890123456789012"),
    algorithm: "sha256",
    digits: 8,
    window: 0,
    clock: () => 59_000,
    replayCache,
  };
  assert.deepEqual(createTotpVerifier(options).verify("46119246"), { ok: true });
  assert.deepEqual(createTotpVerifier(options).verify("46119246"), {
    ok: false,
    reason: "reused_code",
  });
});

const binding = {
  userId: "456",
  chatId: "123",
  action: "merge",
  repo: "lemun/hermes-relay",
  target: "pull/52",
  messageId: "99",
  expectedSha: "abc123",
};

test("issues an opaque capability with at least 128 bits of randomness", () => {
  let requestedBytes = 0;
  const store = createActionCapabilityStore({
    randomBytesImpl: (size) => {
      requestedBytes = size;
      return Buffer.alloc(size, 7);
    },
    clock: () => 1_000,
    ttlMs: 30_000,
  });
  const issued = store.issue(binding);
  assert.ok(requestedBytes >= 16);
  assert.equal(issued.callbackData, issued.id);
  assert.match(issued.id, /^[A-Za-z0-9_-]{22,}$/);
  assert.deepEqual(Object.keys(issued).sort(), ["callbackData", "expiresAt", "id"]);
});

test("consumes a capability once and rejects replay within its valid window", () => {
  const store = createActionCapabilityStore({ clock: () => 1_000, ttlMs: 30_000 });
  const { id } = store.issue(binding);
  assert.deepEqual(store.consume({ id, ...binding }), { ok: true });
  assert.deepEqual(store.consume({ id, ...binding }), { ok: false, reason: "unknown_or_consumed" });
});

test("fails closed and burns a capability on every binding mismatch", () => {
  for (const [field, wrong] of [
    ["userId", "999"],
    ["chatId", "999"],
    ["action", "push"],
    ["repo", "lemun/other"],
    ["target", "pull/99"],
    ["messageId", "100"],
    ["expectedSha", "def456"],
  ]) {
    const store = createActionCapabilityStore({ clock: () => 1_000 });
    const { id } = store.issue(binding);
    assert.deepEqual(store.consume({ id, ...binding, [field]: wrong }), {
      ok: false,
      reason: "binding_mismatch",
    });
    assert.deepEqual(store.consume({ id, ...binding }), { ok: false, reason: "unknown_or_consumed" });
  }
});

test("rejects expired and malformed capabilities and binds absence of expected SHA", () => {
  let now = 1_000;
  const store = createActionCapabilityStore({ clock: () => now, ttlMs: 5_000 });
  const withoutSha = { ...binding };
  delete withoutSha.expectedSha;
  const { id } = store.issue(withoutSha);
  assert.deepEqual(store.consume({ id, ...binding }), { ok: false, reason: "binding_mismatch" });

  const expiring = store.issue(binding);
  now = 6_000;
  assert.deepEqual(store.consume({ id: expiring.id, ...binding }), { ok: false, reason: "expired" });
  assert.deepEqual(store.consume({ id: "not-a-token", ...binding }), {
    ok: false,
    reason: "unknown_or_consumed",
  });
  assert.deepEqual(store.consume(null), { ok: false, reason: "unknown_or_consumed" });
});

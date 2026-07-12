import test from "node:test";
import assert from "node:assert/strict";
import {
  assertTelegramCallbackData,
  createCallbackToken,
  validateCallbackToken,
} from "../lib/callback-tokens.mjs";
import { createTelegram } from "../lib/telegram.mjs";

const NOW = new Date("2026-07-12T12:00:00.000Z");
const randomBytesImpl = () => Buffer.from("001122334455667788", "hex");

test("callback tokens are compact, contextual, and bounded", () => {
  const context = { issueKey: "rn#39", stage: "audit", prNumber: 51, headSha: "abc" };
  const token = createCallbackToken({ context, now: () => NOW, randomBytesImpl });
  assert.deepEqual(token, {
    id: "ABEiM0RVZneI",
    createdAt: NOW.toISOString(),
    context,
  });
  assert.deepEqual(validateCallbackToken(token, {
    id: token.id, context: { headSha: "abc", prNumber: 51, stage: "audit", issueKey: "rn#39" },
    now: () => new Date(NOW.getTime() + 999), maxAgeMs: 1000,
  }), { ok: true });
  assert.equal(Buffer.byteLength(assertTelegramCallbackData(`fin:force:${token.id}:rn#39`), "utf8") <= 64, true);
});

test("callback tokens fail closed on malformed, unknown, expired, or mismatched state", () => {
  const context = { kind: "file-draft" };
  const token = createCallbackToken({ context, now: () => NOW, randomBytesImpl });
  const base = { context, now: () => NOW, maxAgeMs: 1000 };
  assert.equal(validateCallbackToken(token, { ...base, id: "bad" }).reason, "malformed");
  assert.equal(validateCallbackToken(token, { ...base, id: "___________-" }).reason, "unknown");
  assert.equal(validateCallbackToken(token, { ...base, id: token.id, context: { kind: "other" } }).reason, "context-mismatch");
  assert.equal(validateCallbackToken(token, {
    ...base, id: token.id, now: () => new Date(NOW.getTime() + 1001),
  }).reason, "expired");
  assert.equal(validateCallbackToken(null, { ...base, id: token.id }).reason, "unknown");
});

test("callback payload guard measures UTF-8 bytes", () => {
  assert.equal(assertTelegramCallbackData("x".repeat(64)), "x".repeat(64));
  assert.throws(() => assertTelegramCallbackData("🙂".repeat(17)), /exceeds 64 bytes/);
});

test("the Telegram keyboard boundary enforces 64 UTF-8 bytes for every producer", () => {
  const { kbd } = createTelegram("unused-test-token");
  assert.equal(kbd([[['ok', "x".repeat(64)]]]).inline_keyboard[0][0].callback_data.length, 64);
  assert.throws(() => kbd([[['too long', "x".repeat(65)]]]), /exceeds 64 bytes/);
});

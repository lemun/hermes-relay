// Compact, single-use callback capabilities for Telegram owner-action cards.
// These nonces are deliberately separate from askToken: callback tokens prove that a tap
// belongs to the currently displayed card, while askToken authenticates a worker session.

import { randomBytes } from "node:crypto";

export const CALLBACK_NONCE_BYTES = 9; // 12 base64url characters
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const NONCE_RE = /^[A-Za-z0-9_-]{12}$/;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createCallbackToken({ context, now = () => new Date(), randomBytesImpl = randomBytes } = {}) {
  const created = now();
  const createdAt = (created instanceof Date ? created : new Date(created)).toISOString();
  const id = randomBytesImpl(CALLBACK_NONCE_BYTES).toString("base64url");
  if (!NONCE_RE.test(id)) throw new Error("callback nonce generator returned an invalid id");
  return { id, createdAt, context };
}

export function validateCallbackToken(record, { id, context, now = () => new Date(), maxAgeMs } = {}) {
  if (!NONCE_RE.test(String(id || ""))) return { ok: false, reason: "malformed" };
  if (!record || !NONCE_RE.test(String(record.id || "")) || record.id !== id) {
    return { ok: false, reason: "unknown" };
  }
  const createdAt = Date.parse(record.createdAt);
  const current = now();
  const nowMs = (current instanceof Date ? current : new Date(current)).getTime();
  if (!Number.isFinite(createdAt) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (nowMs < createdAt || nowMs - createdAt > maxAgeMs) return { ok: false, reason: "expired" };
  if (canonical(record.context) !== canonical(context)) return { ok: false, reason: "context-mismatch" };
  return { ok: true };
}

export function assertTelegramCallbackData(data) {
  const value = String(data ?? "");
  if (Buffer.byteLength(value, "utf8") > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    throw new Error(`Telegram callback_data exceeds ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} bytes`);
  }
  return value;
}

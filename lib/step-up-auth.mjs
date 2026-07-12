import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CAPABILITY_BYTES = 16;
const DEFAULT_CAPABILITY_TTL_MS = 2 * 60 * 1000;
const MAX_CAPABILITY_TTL_MS = 5 * 60 * 1000;
const MAX_TOTP_WINDOW = 1;
const DEFAULT_MAX_CAPABILITIES = 256;

function decodeBase32(value) {
  if (typeof value !== "string") throw new TypeError("TOTP secret must be a Buffer or base32 string");
  const normalized = value.toUpperCase().replace(/=+$/, "");
  if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) throw new TypeError("TOTP secret is not valid base32");

  let bits = 0;
  let bitCount = 0;
  const bytes = [];
  for (const character of normalized) {
    bits = (bits << 5) | BASE32_ALPHABET.indexOf(character);
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  if (bytes.length === 0) throw new TypeError("TOTP secret is empty");
  return Buffer.from(bytes);
}

function secretBytes(secret) {
  const bytes = Buffer.isBuffer(secret)
    ? Buffer.from(secret)
    : secret instanceof Uint8Array
      ? Buffer.from(secret)
      : decodeBase32(secret);
  if (bytes.length === 0) throw new TypeError("TOTP secret is empty");
  return bytes;
}

function hotp(secret, counter, digits, algorithm) {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(algorithm, secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String((binary >>> 0) % (10 ** digits)).padStart(digits, "0");
}

export function createTotpVerifier({
  secret,
  clock = Date.now,
  stepSeconds = 30,
  window = 1,
  digits = 6,
  algorithm = "sha1",
  replayCache = new Set(),
} = {}) {
  const key = secretBytes(secret);
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (!Number.isInteger(stepSeconds) || stepSeconds <= 0) throw new RangeError("stepSeconds must be positive");
  if (!Number.isInteger(window) || window < 0 || window > MAX_TOTP_WINDOW) {
    throw new RangeError(`window must be between 0 and ${MAX_TOTP_WINDOW}`);
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new RangeError("digits must be between 6 and 10");
  if (!new Set(["sha1", "sha256", "sha512"]).has(algorithm)) throw new RangeError("unsupported TOTP algorithm");
  if (typeof replayCache?.has !== "function" || typeof replayCache?.add !== "function") {
    throw new TypeError("replayCache must provide has and add methods");
  }

  return Object.freeze({
    verify(code) {
      if (typeof code !== "string" || !new RegExp(`^\\d{${digits}}$`).test(code)) {
        return { ok: false, reason: "malformed_code" };
      }

      const currentCounter = Math.floor(Number(clock()) / 1000 / stepSeconds);
      if (!Number.isSafeInteger(currentCounter) || currentCounter < 0) {
        return { ok: false, reason: "invalid_clock" };
      }

      const supplied = Buffer.from(code, "ascii");
      let matchedCounter = null;
      for (let offset = -window; offset <= window; offset += 1) {
        const counter = currentCounter + offset;
        if (counter < 0) continue;
        const candidate = Buffer.from(hotp(key, counter, digits, algorithm), "ascii");
        if (timingSafeEqual(supplied, candidate)) matchedCounter ??= counter;
      }

      if (matchedCounter === null) return { ok: false, reason: "invalid_code" };
      if (replayCache.has(matchedCounter)) return { ok: false, reason: "reused_code" };
      replayCache.add(matchedCounter);
      return { ok: true };
    },
  });
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object") return null;
  const required = ["userId", "chatId", "action", "repo", "target", "messageId"];
  const normalized = {};
  for (const field of required) {
    const value = binding[field];
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") || String(value).length === 0) {
      return null;
    }
    normalized[field] = String(value);
  }
  if (Object.hasOwn(binding, "expectedSha") && binding.expectedSha !== undefined) {
    if (typeof binding.expectedSha !== "string" || binding.expectedSha.length === 0) return null;
    normalized.expectedSha = binding.expectedSha;
  }
  return normalized;
}

function sameBinding(left, right) {
  return left.userId === right.userId
    && left.chatId === right.chatId
    && left.action === right.action
    && left.repo === right.repo
    && left.target === right.target
    && left.messageId === right.messageId
    && left.expectedSha === right.expectedSha;
}

export function createActionCapabilityStore({
  clock = Date.now,
  ttlMs = DEFAULT_CAPABILITY_TTL_MS,
  randomBytesImpl = randomBytes,
  maxEntries = DEFAULT_MAX_CAPABILITIES,
} = {}) {
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  if (typeof randomBytesImpl !== "function") throw new TypeError("randomBytesImpl must be a function");
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_CAPABILITY_TTL_MS) {
    throw new RangeError(`ttlMs must be between 1 and ${MAX_CAPABILITY_TTL_MS}`);
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) {
    throw new RangeError("maxEntries must be between 1 and 4096");
  }

  const capabilities = new Map();
  const prune = (now) => {
    for (const [id, capability] of capabilities) {
      if (now >= capability.expiresAt) capabilities.delete(id);
    }
  };
  return Object.freeze({
    issue(binding) {
      const normalized = normalizeBinding(binding);
      if (!normalized) throw new TypeError("capability binding is incomplete or invalid");
      const now = Number(clock());
      if (!Number.isFinite(now)) throw new TypeError("clock returned an invalid time");
      prune(now);
      if (capabilities.size >= maxEntries) throw new Error("capability store is full");

      let id;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const entropy = randomBytesImpl(CAPABILITY_BYTES);
        if (!(entropy instanceof Uint8Array) || entropy.byteLength < CAPABILITY_BYTES) {
          throw new Error("random source returned less than 128 bits");
        }
        id = Buffer.from(entropy).toString("base64url");
        if (!capabilities.has(id)) break;
        id = undefined;
      }
      if (!id) throw new Error("could not allocate a unique capability");

      const expiresAt = now + ttlMs;
      capabilities.set(id, { binding: normalized, expiresAt });
      return { id, callbackData: id, expiresAt };
    },

    consume(request = {}) {
      if (!request || typeof request !== "object") {
        return { ok: false, reason: "unknown_or_consumed" };
      }
      const { id, ...binding } = request;
      if (typeof id !== "string") return { ok: false, reason: "unknown_or_consumed" };
      const capability = capabilities.get(id);
      if (!capability) return { ok: false, reason: "unknown_or_consumed" };
      capabilities.delete(id);

      const now = Number(clock());
      if (!Number.isFinite(now) || now >= capability.expiresAt) return { ok: false, reason: "expired" };
      const normalized = normalizeBinding(binding);
      if (!normalized || !sameBinding(capability.binding, normalized)) {
        return { ok: false, reason: "binding_mismatch" };
      }
      return { ok: true };
    },

    size() {
      const now = Number(clock());
      if (Number.isFinite(now)) prune(now);
      return capabilities.size;
    },
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createActionAuthorization,
  classifyCallbackData,
  classifyTelegramMessage,
  SecurityStateError,
} from "../lib/action-authorization.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hermes-auth-"));
const secret = Buffer.from("12345678901234567890");

function totp(counter) {
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", secret).update(input).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const value = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String((value >>> 0) % 1_000_000).padStart(6, "0");
}

function message({ chatId = 123, userId = 456, type = "private", text = "/status", messageId = 9 } = {}) {
  return { message: { message_id: messageId, chat: { id: chatId, type }, from: { id: userId }, text } };
}

function callback(data, { chatId = 123, userId = 456, type = "private", messageId = 9 } = {}) {
  return { callback_query: { id: "cq", data, from: { id: userId }, message: { message_id: messageId, chat: { id: chatId, type } } } };
}

function guard(overrides = {}) {
  const { unlock = true, ...options } = overrides;
  const authorization = createActionAuthorization({
    configuredChatId: 123,
    configuredUserId: 456,
    totpSecret: secret,
    stateFile: path.join(tmp(), "state", "hermes-security.json"),
    clock: () => 59_000,
    ...options,
  });
  if (unlock) authorization.unlockLocal();
  return authorization;
}

test("route classification is explicit for live command and callback surfaces", () => {
  assert.equal(classifyTelegramMessage({ text: "/dispatch rn#42" }), "hub.dispatch");
  assert.equal(classifyTelegramMessage({ text: "/ops resume sess-1" }), "hub.ops");
  assert.equal(classifyTelegramMessage({ text: "owner reply", awaitingAnswer: true }), "hub.answer");
  assert.equal(classifyTelegramMessage({ text: "hello" }), "help");
  assert.equal(classifyTelegramMessage({ text: "/accept HOM-27" }), null);
  assert.equal(classifyTelegramMessage({ text: "/future-mutator" }), null);
  assert.equal(classifyCallbackData("code:push"), "coding.push");
  assert.equal(classifyCallbackData("fin:force:token:rn#42"), "hub.finisher");
  assert.equal(classifyCallbackData("act:go:retired"), null);
  assert.equal(classifyCallbackData("pcard:accept:27:retired"), null);
  assert.equal(classifyCallbackData("unknown:new-action"), null);
});

test("strict identity rejects groups, wrong chats, and wrong senders", () => {
  const auth = guard();
  assert.equal(auth.authorizeIdentity(message()).ok, true);
  assert.equal(auth.authorizeIdentity(message({ type: "group" })).ok, false);
  assert.equal(auth.authorizeIdentity(message({ chatId: 999 })).ok, false);
  assert.equal(auth.authorizeIdentity(message({ userId: 999 })).ok, false);
});

test("mutations require step-up and TOTP replay remains blocked after restart", () => {
  const stateFile = path.join(tmp(), "state", "hermes-security.json");
  const first = guard({ stateFile });
  assert.deepEqual(first.authorizeAction("hub.dispatch"), { ok: false, reason: "step_up_required" });
  assert.deepEqual(first.verifyStepUp(totp(1)), { ok: true });
  assert.equal(first.authorizeCommand(message({ text: "/dispatch rn#42" }), "hub.dispatch").ok, true);
  assert.equal(first.authorizeAction("hub.dispatch").reason, "step_up_required", "a grant authorizes only one command");

  const restarted = guard({ stateFile });
  assert.deepEqual(restarted.verifyStepUp(totp(1)), { ok: false, reason: "reused_code" });
  assert.deepEqual(restarted.authorizeAction("hub.dispatch"), { ok: false, reason: "step_up_required" });
});

test("capabilities are private, single-use, bound, stale-safe, and restart-safe", () => {
  const stateFile = path.join(tmp(), "state", "hermes-security.json");
  let now = 59_000;
  const first = guard({ stateFile, clock: () => now });
  assert.equal(first.verifyStepUp(totp(1)).ok, true);
  const data = first.issueCallback({ originalData: "code:push", chatId: 123, messageId: 9 });
  assert.match(data, /^sec:[A-Za-z0-9_-]{22}$/);
  assert.equal(JSON.stringify(callback(data)).includes("code:push"), false);

  const restarted = guard({ stateFile, clock: () => now });
  assert.equal(restarted.consumeCallback(callback(data)).reason, "step_up_required");
  assert.equal(restarted.consumeCallback(callback(data)).reason, "step_up_required", "missing step-up does not strand the button");

  now = 89_000;
  assert.equal(restarted.verifyStepUp(totp(2)).ok, true);
  const bound = restarted.issueCallback({ originalData: "code:push", chatId: 123, messageId: 9 });
  assert.equal(restarted.consumeCallback(callback(bound, { type: "group" })).ok, false);
  assert.equal(restarted.consumeCallback(callback(bound, { messageId: 10 })).reason, "capability_binding_mismatch");
  assert.equal(restarted.consumeCallback(callback(bound)).reason, "unknown_capability");

  const stale = restarted.issueCallback({ originalData: "code:push", chatId: 123, messageId: 9 });
  now += 120_001;
  assert.equal(restarted.consumeCallback(callback(stale)).reason, "unknown_capability");
});

test("remote lock is enforced at deferred boundaries and remote unlock is impossible", () => {
  const auth = guard();
  assert.equal(auth.lockRemote().ok, true);
  assert.equal(auth.isLocked(), true);
  assert.equal(auth.authorizeRuntimeAction("hub.runtime.spawn"), false);
  assert.equal(auth.authorizeAction("status").ok, true);
  assert.deepEqual(auth.unlockRemote(), { ok: false, mode: "locked", reason: "local_unlock_required" });
  assert.equal(auth.unlockLocal().ok, true);
  assert.equal(auth.isLocked(), false);
});

test("a step-up grant is invalidated by cross-process lockdown transitions", () => {
  const stateFile = path.join(tmp(), "state", "hermes-security.json");
  const botProcess = guard({ stateFile });
  assert.equal(botProcess.verifyStepUp(totp(1)).ok, true);
  const allowed = botProcess.authorizeCommand(message({ text: "/dispatch rn#42" }), "hub.dispatch");
  assert.equal(allowed.ok, true);

  const controlProcess = guard({ stateFile, unlock: false });
  assert.equal(controlProcess.lockRemote().ok, true);
  assert.equal(
    botProcess.runWithAuthorization(allowed.generation, () => botProcess.authorizeCurrentRuntimeAction("hub.runtime.mutate")),
    false,
    "a remote lock cannot mint fresh background authority",
  );
  assert.equal(controlProcess.unlockLocal().ok, true);

  assert.equal(botProcess.authorizeAction("hub.dispatch").reason, "step_up_required");
  assert.equal(
    botProcess.runWithAuthorization(allowed.generation, () => botProcess.authorizeRuntimeAction("hub.runtime.spawn")),
    false,
    "deferred work retains and rechecks the generation that authorized it",
  );
  assert.equal(
    botProcess.runWithAuthorization(allowed.generation, () => botProcess.authorizeCurrentRuntimeAction("hub.runtime.mutate")),
    true,
    "an explicit local unlock mints the fresh generation used by deferred recovery",
  );
  assert.equal(botProcess.authorizeRuntimeAction("hub.runtime.spawn"), true, "unprompted appliance work uses current state");
});

test("atomic state updates preserve a concurrent lockdown and fail closed on a busy lock", () => {
  const stateFile = path.join(tmp(), "state", "hermes-security.json");
  const auth = guard({ stateFile });
  assert.equal(auth.lockRemote().ok, true);
  assert.equal(auth.verifyStepUp(totp(1)).ok, true, "step-up recording is allowed but cannot unlock");
  auth.issueCallback({ originalData: "code:push", chatId: 123, messageId: 9 });
  assert.equal(auth.inspectState().lockdown, "locked");

  fs.writeFileSync(`${stateFile}.lock`, "busy", { mode: 0o600 });
  assert.throws(() => auth.issueCallback({ originalData: "code:push", chatId: 123, messageId: 10 }), /busy or unavailable/);
  assert.equal(auth.inspectState().lockdown, "locked");
});

test("crash-residue security locks refuse startup before a normal state can become write-enabled", () => {
  const stateFile = path.join(tmp(), "state", "hermes-security.json");
  guard({ stateFile });
  fs.writeFileSync(`${stateFile}.lock`, "crashed writer", { mode: 0o600 });

  assert.throws(
    () => guard({ stateFile, unlock: false }),
    /lock requires operator recovery; refusing startup/,
  );
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).lockdown, "normal");
  assert.equal(fs.readFileSync(`${stateFile}.lock`, "utf8"), "crashed writer", "startup must not guess that a lock is stale and unlink it");
});

test("unsafe security lock paths refuse startup without following or removing them", () => {
  const stateFile = path.join(tmp(), "state", "hermes-security.json");
  guard({ stateFile });
  const target = path.join(tmp(), "lock-target");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, `${stateFile}.lock`);

  assert.throws(() => guard({ stateFile, unlock: false }), /lock path is unsafe; refusing startup/);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");
  assert.equal(fs.lstatSync(`${stateFile}.lock`).isSymbolicLink(), true);
});

test("callback capabilities bind trusted target context", () => {
  const stateFile = path.join(tmp(), "state", "hermes-security.json");
  let target = "session-1";
  const auth = guard({ stateFile, resolveCallbackBinding: () => ({ repo: "rn", target }) });
  assert.equal(auth.verifyStepUp(totp(1)).ok, true);
  const data = auth.issueCallback({ originalData: "code:push", chatId: 123, messageId: 9 });
  target = "session-2";
  assert.equal(auth.consumeCallback(callback(data)).reason, "capability_target_mismatch");
  assert.equal(auth.consumeCallback(callback(data)).reason, "unknown_capability");
});

test("unknown actions and malformed or unwritable security state fail closed", () => {
  const auth = guard();
  assert.deepEqual(auth.authorizeAction("future.action"), { ok: false, reason: "unknown_action" });
  const stateFile = path.join(tmp(), "state.json");
  fs.writeFileSync(stateFile, "{bad", { mode: 0o600 });
  assert.throws(() => guard({ stateFile }), SecurityStateError);

  const target = path.join(tmp(), "target");
  const symlink = path.join(tmp(), "security.json");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, symlink);
  assert.throws(() => guard({ stateFile: symlink }), /unsafe/i);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");

  assert.throws(() => guard({ totpSecret: "not-valid-base32!" }), /TOTP configuration is invalid/);
});

test("missing security state bootstraps locked and requires explicit local unlock", () => {
  const auth = guard({ unlock: false });
  assert.equal(auth.isLocked(), true);
  assert.equal(auth.authorizeRuntimeAction("hub.runtime.spawn"), false);
  assert.equal(auth.unlockLocal().ok, true);
  assert.equal(auth.isLocked(), false);
});

test("legacy normal state without a local-unlock stamp stays migration-locked", () => {
  const stateFile = path.join(tmp(), "state", "hermes-security.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    lockdown: "normal",
    lockdownGeneration: 9,
    totpCounters: [],
    capabilities: [],
  }), { mode: 0o600 });
  const auth = createActionAuthorization({
    configuredChatId: 123,
    configuredUserId: 456,
    totpSecret: secret,
    stateFile,
    clock: () => 59_000,
  });

  assert.equal(auth.isLocked(), true, "unstamped normal must be treated as locked during migration");
  assert.equal(auth.authorizeRuntimeAction("hub.runtime.mutate"), false);
  assert.equal(auth.authorizeCurrentRuntimeAction("hub.runtime.mutate"), false);
  assert.equal(auth.authorizeAction("status").ok, true, "read/control posture remains available");
  assert.equal(auth.unlockLocal().ok, true);
  assert.equal(auth.isLocked(), false);
  assert.equal(auth.inspectState().localUnlockGeneration, 10);
  assert.equal(auth.authorizeCurrentRuntimeAction("hub.runtime.mutate"), true);
});

test("capability persistence is bounded", () => {
  const auth = guard();
  for (let index = 0; index < 256; index += 1) {
    auth.issueCallback({ originalData: "code:push", chatId: 123, messageId: index + 1 });
  }
  assert.throws(
    () => auth.issueCallback({ originalData: "code:push", chatId: 123, messageId: 999 }),
    /full/,
  );
  assert.equal(auth.inspectState().capabilities.length, 256);
});

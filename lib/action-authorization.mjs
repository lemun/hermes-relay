import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { authorizeTelegramIdentity } from "./telegram-identity.mjs";
import { createTotpVerifier } from "./step-up-auth.mjs";
import { LOCKDOWN_MODES, evaluateLockdown, transitionLockdown } from "./lockdown.mjs";
import { ensurePrivateDirectory, writePrivateJsonAtomic } from "./private-storage.mjs";

const STATE_VERSION = 1;
const DEFAULT_GRANT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_CAPABILITY_TTL_MS = 2 * 60 * 1000;
const MAX_CAPABILITIES = 256;
const MAX_REPLAY_COUNTERS = 64;
const MAX_SECURITY_STATE_BYTES = 1024 * 1024;

export const ACTION_POLICIES = Object.freeze({
  "auth.step_up": { classification: "control", stepUp: false },
  lock: { classification: "control", stepUp: false },
  unlock: { classification: "control", stepUp: false },
  status: { classification: "read", stepUp: false },
  help: { classification: "read", stepUp: false },
  stop: { classification: "control", stepUp: false },
  "telegram.noop": { classification: "read", stepUp: false },
  "coding.status": { classification: "read", stepUp: false },
  "ops.read": { classification: "read", stepUp: false },
  "settings.read": { classification: "read", stepUp: false },
  "coding.configure": { classification: "mutate", stepUp: true },
  "coding.start": { classification: "session", stepUp: true },
  "coding.resume": { classification: "session", stepUp: true },
  "coding.push": { classification: "mutate", stepUp: true },
  "board.act": { classification: "mutate", stepUp: true },
  "hub.answer": { classification: "session", stepUp: true },
  "hub.auto": { classification: "mutate", stepUp: true },
  "hub.settings": { classification: "mutate", stepUp: true },
  "hub.file": { classification: "session", stepUp: true },
  "hub.chat": { classification: "session", stepUp: true },
  "hub.dispatch": { classification: "session", stepUp: true },
  "hub.ops": { classification: "mutate", stepUp: true },
  "hub.finisher": { classification: "mutate", stepUp: true },
  "concierge.session": { classification: "session", stepUp: true },
  "prefs.mutate": { classification: "mutate", stepUp: true },
  "hub.runtime.spawn": { classification: "session", stepUp: false },
  "hub.runtime.mutate": { classification: "mutate", stepUp: false },
});

export class SecurityStateError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SecurityStateError";
  }
}

function freshState() {
  // Missing state is a security event, not a reset to normal. A local operator
  // must explicitly unlock after first bootstrap or state loss.
  return {
    version: STATE_VERSION,
    lockdown: LOCKDOWN_MODES.LOCKED,
    lockdownGeneration: 0,
    localUnlockGeneration: null,
    totpCounters: [],
    capabilities: [],
  };
}

function validState(value) {
  return value && value.version === STATE_VERSION
    && Object.values(LOCKDOWN_MODES).includes(value.lockdown)
    && Number.isSafeInteger(value.lockdownGeneration)
    && value.lockdownGeneration >= 0
    && (value.localUnlockGeneration === undefined
      || value.localUnlockGeneration === null
      || (Number.isSafeInteger(value.localUnlockGeneration)
        && value.localUnlockGeneration >= 0
        && value.localUnlockGeneration <= value.lockdownGeneration))
    && Array.isArray(value.totpCounters)
    && value.totpCounters.length <= MAX_REPLAY_COUNTERS
    && value.totpCounters.every((counter) => Number.isSafeInteger(counter) && counter >= 0)
    && Array.isArray(value.capabilities)
    && value.capabilities.length <= MAX_CAPABILITIES
    && value.capabilities.every((entry) => entry
      && /^[A-Za-z0-9_-]{22}$/.test(entry.id)
      && typeof entry.originalData === "string"
      && Buffer.byteLength(entry.originalData, "utf8") <= 64
      && actionPolicy(entry.action)
      && typeof entry.repo === "string" && entry.repo.length > 0
      && typeof entry.target === "string" && entry.target.length > 0
      && (entry.expectedSha === null || typeof entry.expectedSha === "string")
      && typeof entry.userId === "string" && entry.userId.length > 0
      && typeof entry.chatId === "string" && entry.chatId.length > 0
      && typeof entry.messageId === "string" && entry.messageId.length > 0
      && Number.isFinite(entry.createdAt)
      && Number.isFinite(entry.expiresAt)
      && entry.expiresAt > entry.createdAt);
}

function effectiveLockdownMode(state) {
  // Version-1 states written before localUnlockGeneration existed may say
  // "normal" without proving that a local operator minted that generation.
  // Treat them as locked in memory until `security:control -- unlock` stamps a
  // fresh generation; keep the stored state readable so that migration works.
  if (state.lockdown === LOCKDOWN_MODES.NORMAL
    && state.localUnlockGeneration !== state.lockdownGeneration) {
    return LOCKDOWN_MODES.LOCKED;
  }
  return state.lockdown;
}

function actionPolicy(action) {
  return Object.hasOwn(ACTION_POLICIES, action) ? ACTION_POLICIES[action] : null;
}

export function classifyTelegramMessage({ text, hasVoice = false, awaitingAnswer = false, wizardStep, awaitingBoardReason = false } = {}) {
  const value = typeof text === "string" ? text.trim() : "";
  const [rawCommand, ...rest] = value.split(/\s+/);
  const command = rawCommand.toLowerCase();
  const arg = rest.join(" ");
  if (command === "/auth") return "auth.step_up";
  if (command === "/lock") return "lock";
  if (command === "/unlock") return "unlock";
  if (["/help", "/start"].includes(command)) return "help";
  if (command === "/status") return "status";
  if (["/me", "/codestatus"].includes(command)) return command === "/codestatus" ? "coding.status" : "settings.read";
  if (command === "/stop") return "stop";
  if (awaitingAnswer) return "hub.answer";
  if (wizardStep === "prompt") return "coding.start";
  if (wizardStep === "resumePrompt") return "coding.resume";
  if (awaitingBoardReason) return "board.act";
  if (!value) return hasVoice ? "concierge.session" : "telegram.noop";
  if (command === "/code") return /^again\b/i.test(arg) ? "coding.resume" : "coding.start";
  if (["/new", "/lang", "/model"].includes(command)) return "prefs.mutate";
  if (command === "/again") return "concierge.session";
  if (command === "/auto") return arg ? "hub.auto" : "status";
  if (command === "/tiers") return arg ? "hub.settings" : "settings.read";
  if (["/ops", "/doctor"].includes(command)) return arg ? "hub.ops" : "ops.read";
  if (command === "/file") return "hub.file";
  if (command === "/gh") return "hub.chat";
  if (command === "/dispatch") return "hub.dispatch";
  if (/^\/?(?:accept|approve|reject)\b/i.test(value)) return "board.act";
  if (value.startsWith("/")) return null;
  return "concierge.session";
}

export function classifyCallbackData(data) {
  if (typeof data !== "string") return null;
  if (/^code:push$/.test(data)) return "coding.push";
  if (/^code:go$/.test(data)) return "coding.start";
  if (/^code:iterate$/.test(data)) return "coding.resume";
  if (/^code:(?:repo|model|effort):/.test(data) || data === "code:cancel") return "coding.configure";
  if (/^act:/.test(data) || /^pcard:(?:accept|reject):/.test(data)) return "board.act";
  if (/^pcard:info:/.test(data)) return "hub.chat";
  if (/^ask:(?:yes|other):/.test(data)) return "hub.answer";
  if (/^ask:explain:/.test(data)) return "hub.chat";
  if (/^fin:/.test(data)) return "hub.finisher";
  if (/^file:repo:/.test(data)) return "hub.file";
  if (/^disp:go:/.test(data)) return "hub.dispatch";
  return null;
}

export function createActionAuthorization({
  configuredChatId,
  configuredUserId,
  totpSecret,
  stateFile,
  clock = Date.now,
  fsImpl = fs,
  randomBytesImpl = crypto.randomBytes,
  resolveCallbackBinding = (originalData) => ({ repo: "telegram", target: originalData }),
  grantTtlMs = DEFAULT_GRANT_TTL_MS,
  capabilityTtlMs = DEFAULT_CAPABILITY_TTL_MS,
} = {}) {
  if (!stateFile) throw new TypeError("stateFile is required");
  if (!Number.isInteger(grantTtlMs) || grantTtlMs < 1 || grantTtlMs > 5 * 60 * 1000) throw new RangeError("invalid grant TTL");
  if (!Number.isInteger(capabilityTtlMs) || capabilityTtlMs < 1 || capabilityTtlMs > 5 * 60 * 1000) throw new RangeError("invalid capability TTL");
  if (totpSecret !== undefined && totpSecret !== "") {
    try { createTotpVerifier({ secret: totpSecret, window: 1 }); }
    catch (error) { throw new SecurityStateError("TOTP configuration is invalid", { cause: error }); }
  }
  let grantExpiresAt = 0;
  let grantLockdownGeneration = -1;
  const authorizationContext = new AsyncLocalStorage();
  const lockFile = `${stateFile}.lock`;

  const assertNoStartupLock = () => {
    let stat;
    try { stat = fsImpl.lstatSync(lockFile); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw new SecurityStateError("security state lock is unavailable; refusing startup", { cause: error });
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new SecurityStateError("security state lock path is unsafe; refusing startup");
    }
    // O_EXCL lock ownership cannot be proven after a crash because the legacy
    // lock contains no owner or process-start identity. Never unlink it based
    // on age or PID guesses: refusing startup keeps a previously normal state
    // from coming back write-enabled while emergency /lock is unavailable.
    throw new SecurityStateError("security state lock requires operator recovery; refusing startup");
  };

  const saveUnlocked = (state) => {
    ensurePrivateDirectory(path.dirname(stateFile), { fsImpl });
    writePrivateJsonAtomic(stateFile, state, { fsImpl });
  };
  const readExisting = () => {
    let text;
    try {
      const stat = fsImpl.lstatSync(stateFile);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new SecurityStateError("security state path is unsafe");
      if (stat.size > MAX_SECURITY_STATE_BYTES) throw new SecurityStateError("security state is too large");
      text = fsImpl.readFileSync(stateFile, "utf8");
    }
    catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SecurityStateError) throw error;
      throw new SecurityStateError("security state is unavailable", { cause: error });
    }
    try {
      const state = JSON.parse(text);
      if (!validState(state)) throw new Error("invalid security state shape");
      return state;
    } catch (error) {
      throw new SecurityStateError("security state is malformed", { cause: error });
    }
  };
  const update = (mutator) => {
    ensurePrivateDirectory(path.dirname(stateFile), { fsImpl });
    let descriptor;
    try {
      descriptor = fsImpl.openSync(
        lockFile,
        fsImpl.constants.O_WRONLY | fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL | (fsImpl.constants.O_NOFOLLOW || 0),
        0o600,
      );
      fsImpl.fchmodSync(descriptor, 0o600);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fsImpl.closeSync(descriptor); } catch { /* preserve */ }
        try { fsImpl.unlinkSync(lockFile); } catch { /* preserve */ }
      }
      throw new SecurityStateError("security state update is busy or unavailable", { cause: error });
    }
    try {
      const current = readExisting() || freshState();
      const outcome = mutator(current) || {};
      const next = outcome.state || current;
      if (!validState(next)) throw new SecurityStateError("security state update is invalid");
      saveUnlocked(next);
      return outcome.result;
    } finally {
      let cleanupError;
      try { fsImpl.closeSync(descriptor); } catch (error) { cleanupError = error; }
      try { fsImpl.unlinkSync(lockFile); } catch (error) { cleanupError ||= error; }
      if (cleanupError) throw new SecurityStateError("security state lock cleanup failed", { cause: cleanupError });
    }
  };
  const load = () => {
    const state = readExisting();
    if (state) return state;
    return update((initial) => ({ state: initial, result: initial }));
  };
  assertNoStartupLock();
  load();

  const identity = (update) => authorizeTelegramIdentity({ update, configuredChatId, configuredUserId });
  const now = () => {
    const value = Number(clock());
    if (!Number.isFinite(value) || value < 0) throw new SecurityStateError("security clock is invalid");
    return value;
  };
  const pruneCapabilities = (state, at) => ({
    ...state,
    capabilities: state.capabilities.filter((entry) => entry && Number(entry.expiresAt) > at).slice(-MAX_CAPABILITIES),
  });

  function authorizeAction(action, { requireStepUp = true } = {}) {
    const policy = actionPolicy(action);
    if (!policy) return { ok: false, reason: "unknown_action" };
    const state = load();
    const lockdown = evaluateLockdown({ mode: effectiveLockdownMode(state), action, classification: policy.classification });
    if (!lockdown.allowed) return { ok: false, reason: lockdown.reason };
    if (requireStepUp && policy.stepUp
      && (now() >= grantExpiresAt || grantLockdownGeneration !== state.lockdownGeneration)) {
      grantExpiresAt = 0;
      grantLockdownGeneration = -1;
      return { ok: false, reason: "step_up_required" };
    }
    return { ok: true, policy, generation: state.lockdownGeneration };
  }

  function authorizeCommand(updateValue, action) {
    const checkedIdentity = identity(updateValue);
    if (!checkedIdentity.ok) return checkedIdentity;
    const allowed = authorizeAction(action);
    if (!allowed.ok) return allowed;
    if (allowed.policy.stepUp) {
      grantExpiresAt = 0;
      grantLockdownGeneration = -1;
    }
    return { ok: true, action, identity: checkedIdentity.identity, generation: allowed.generation };
  }

  function verifyStepUp(code) {
    if (!totpSecret) return { ok: false, reason: "totp_not_configured" };
    const generationAtStart = load().lockdownGeneration;
    const replayCache = {
      has(counter) { return load().totpCounters.includes(counter); },
      add(counter) {
        update((state) => {
          if (state.lockdownGeneration !== generationAtStart) {
            throw new SecurityStateError("security state changed during step-up");
          }
          return {
            state: {
              ...state,
              totpCounters: [...new Set([...state.totpCounters, counter])].sort((a, b) => a - b).slice(-MAX_REPLAY_COUNTERS),
            },
          };
        });
      },
    };
    let result;
    try {
      result = createTotpVerifier({ secret: totpSecret, clock, window: 1, replayCache }).verify(String(code || ""));
    } catch (error) {
      throw new SecurityStateError("TOTP configuration is invalid", { cause: error });
    }
    if (result.ok) {
      grantExpiresAt = now() + grantTtlMs;
      grantLockdownGeneration = generationAtStart;
    }
    return result;
  }

  function setLockdown(operation, source) {
    const next = update((state) => {
      const transition = transitionLockdown({ mode: state.lockdown, operation, source });
      if (!transition.ok) return { state, result: transition };
      const lockdownGeneration = state.lockdownGeneration + 1;
      return {
        state: {
          ...state,
          lockdown: transition.mode,
          lockdownGeneration,
          localUnlockGeneration: operation === "unlock" && source === "local"
            ? lockdownGeneration
            : (state.localUnlockGeneration ?? null),
        },
        result: transition,
      };
    });
    grantExpiresAt = 0;
    grantLockdownGeneration = -1;
    return next;
  }

  function issueCallback({ originalData, chatId, messageId }) {
    const action = classifyCallbackData(originalData);
    if (!actionPolicy(action)) throw new SecurityStateError("callback action is unknown");
    const at = now();
    return update((current) => {
      const state = pruneCapabilities(current, at);
      if (state.capabilities.length >= MAX_CAPABILITIES) throw new SecurityStateError("capability store is full");
      let id;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = Buffer.from(randomBytesImpl(16));
        if (candidate.byteLength !== 16) throw new SecurityStateError("capability entropy is invalid");
        id = candidate.toString("base64url");
        if (!state.capabilities.some((entry) => entry.id === id)) break;
        id = undefined;
      }
      if (!id) throw new SecurityStateError("could not allocate a unique capability");
      const binding = resolveCallbackBinding(originalData) || {};
      const entry = {
        id,
        originalData,
        action,
        repo: String(binding.repo || "telegram"),
        target: String(binding.target || originalData),
        expectedSha: binding.expectedSha == null ? null : String(binding.expectedSha),
        userId: String(configuredUserId),
        chatId: String(chatId),
        messageId: String(messageId),
        expiresAt: at + capabilityTtlMs,
        createdAt: at,
      };
      return { state: { ...state, capabilities: [...state.capabilities, entry] }, result: `sec:${id}` };
    });
  }

  function consumeCallback(updateValue) {
    const checkedIdentity = identity(updateValue);
    if (!checkedIdentity.ok) return checkedIdentity;
    const data = updateValue?.callback_query?.data;
    const match = /^sec:([A-Za-z0-9_-]{22})$/.exec(data || "");
    if (!match) return { ok: false, reason: "unknown_capability" };
    const at = now();
    const entry = load().capabilities.find((item) => item.id === match[1]);
    if (!entry || at >= entry.expiresAt) {
      update((state) => ({ state: pruneCapabilities(state, at) }));
      return { ok: false, reason: "unknown_capability" };
    }
    const current = checkedIdentity.identity;
    if (entry.userId !== current.userId || entry.chatId !== current.chatId || entry.messageId !== current.messageId) {
      update((state) => ({ state: { ...state, capabilities: state.capabilities.filter((item) => item.id !== entry.id) } }));
      return { ok: false, reason: "capability_binding_mismatch" };
    }
    if (classifyCallbackData(entry.originalData) !== entry.action) {
      update((state) => ({ state: { ...state, capabilities: state.capabilities.filter((item) => item.id !== entry.id) } }));
      return { ok: false, reason: "capability_action_mismatch" };
    }
    const binding = resolveCallbackBinding(entry.originalData) || {};
    if (entry.repo !== String(binding.repo || "telegram")
      || entry.target !== String(binding.target || entry.originalData)
      || entry.expectedSha !== (binding.expectedSha == null ? null : String(binding.expectedSha))) {
      update((state) => ({ state: { ...state, capabilities: state.capabilities.filter((item) => item.id !== entry.id) } }));
      return { ok: false, reason: "capability_target_mismatch" };
    }
    const allowed = authorizeAction(entry.action);
    if (!allowed.ok) return allowed;
    const consumed = update((state) => {
      const live = state.capabilities.find((item) => item.id === entry.id);
      const policy = actionPolicy(entry.action);
      const lockdown = evaluateLockdown({ mode: state.lockdown, action: entry.action, classification: policy.classification });
      if (!live || !lockdown.allowed
        || (policy.stepUp && state.lockdownGeneration !== grantLockdownGeneration)) {
        return { state, result: false };
      }
      return { state: { ...state, capabilities: state.capabilities.filter((item) => item.id !== entry.id) }, result: true };
    });
    if (!consumed) return { ok: false, reason: "security_state_changed" };
    if (allowed.policy.stepUp) {
      grantExpiresAt = 0;
      grantLockdownGeneration = -1;
    }
    return {
      ok: true,
      originalData: entry.originalData,
      action: entry.action,
      identity: current,
      generation: allowed.generation,
      binding: { repo: entry.repo, target: entry.target, expectedSha: entry.expectedSha },
    };
  }

  return Object.freeze({
    authorizeIdentity: identity,
    authorizeAction,
    authorizeCommand,
    verifyStepUp,
    issueCallback,
    consumeCallback,
    lockRemote: () => setLockdown("lock", "telegram"),
    unlockRemote: () => setLockdown("unlock", "telegram"),
    unlockLocal: () => setLockdown("unlock", "local"),
    isLocked: () => effectiveLockdownMode(load()) === LOCKDOWN_MODES.LOCKED,
    runWithAuthorization: (generation, callback) => {
      if (!Number.isSafeInteger(generation) || typeof callback !== "function") {
        throw new SecurityStateError("authorized execution context is invalid");
      }
      return authorizationContext.run(generation, callback);
    },
    authorizeRuntimeAction: (action) => {
      const allowed = authorizeAction(action, { requireStepUp: false });
      if (!allowed.ok) return false;
      const authorizedGeneration = authorizationContext.getStore();
      return authorizedGeneration === undefined || authorizedGeneration === allowed.generation;
    },
    // Deferred appliance work must not inherit the Telegram command/callback's
    // AsyncLocalStorage generation forever. This deliberately exits that context,
    // but only a generation minted by an explicit local unlock can authorize it.
    // Remote lock/unlock traffic therefore cannot turn stale command authority into
    // fresh background authority.
    authorizeCurrentRuntimeAction: (action) => authorizationContext.exit(() => {
      const allowed = authorizeAction(action, { requireStepUp: false });
      if (!allowed.ok) return false;
      const state = load();
      return state.lockdownGeneration === allowed.generation
        && state.localUnlockGeneration === allowed.generation;
    }),
    inspectState: () => load(),
  });
}

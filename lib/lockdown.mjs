export const LOCKDOWN_MODES = Object.freeze({
  NORMAL: "normal",
  LOCKED: "locked",
});

const ALWAYS_AVAILABLE_WHILE_LOCKED = new Set(["status", "help", "stop", "lock"]);
const ACTION_CLASSIFICATIONS = new Set(["read", "mutate", "session", "control"]);

export function evaluateLockdown({ mode, action, classification } = {}) {
  if (!Object.values(LOCKDOWN_MODES).includes(mode)) {
    return { allowed: false, reason: "invalid_lockdown_state" };
  }
  if (typeof action !== "string" || action.length === 0) {
    return { allowed: false, reason: "invalid_action" };
  }
  if (!ACTION_CLASSIFICATIONS.has(classification)) {
    return { allowed: false, reason: "unknown_action_classification" };
  }
  if (mode === LOCKDOWN_MODES.NORMAL) return { allowed: true };
  if (ALWAYS_AVAILABLE_WHILE_LOCKED.has(action) || classification === "read") {
    return { allowed: true };
  }
  return { allowed: false, reason: "lockdown_read_only" };
}

export function transitionLockdown({ mode, operation, source } = {}) {
  if (!Object.values(LOCKDOWN_MODES).includes(mode)) {
    return { ok: false, mode: LOCKDOWN_MODES.LOCKED, reason: "invalid_lockdown_state" };
  }
  if (operation === "lock") return { ok: true, mode: LOCKDOWN_MODES.LOCKED };
  if (operation !== "unlock") return { ok: false, mode, reason: "invalid_lockdown_operation" };
  if (source !== "local") return { ok: false, mode, reason: "local_unlock_required" };
  return { ok: true, mode: LOCKDOWN_MODES.NORMAL };
}

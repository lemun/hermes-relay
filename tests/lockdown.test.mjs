import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCKDOWN_MODES,
  evaluateLockdown,
  transitionLockdown,
} from "../lib/lockdown.mjs";

test("normal mode permits ordinary actions", () => {
  assert.deepEqual(evaluateLockdown({ mode: LOCKDOWN_MODES.NORMAL, action: "merge" }), {
    allowed: true,
  });
});

test("locked mode preserves only status, help, stop, and idempotent lock", () => {
  for (const action of ["status", "help", "stop", "lock"]) {
    assert.deepEqual(evaluateLockdown({ mode: LOCKDOWN_MODES.LOCKED, action }), {
      allowed: true,
    });
  }
});

test("locked mode remains read-only for explicitly classified ordinary reads", () => {
  assert.deepEqual(evaluateLockdown({
    mode: LOCKDOWN_MODES.LOCKED,
    action: "explain",
    classification: "read",
  }), { allowed: true });
});

test("locked mode denies mutating, session-spawning, and unknown actions", () => {
  for (const action of ["merge", "push", "enable_autopilot", "start_coding", "resume_coding", "board_write", "unknown"]) {
    assert.deepEqual(evaluateLockdown({ mode: LOCKDOWN_MODES.LOCKED, action }), {
      allowed: false,
      reason: "lockdown_read_only",
    });
  }
});

test("lock can be requested remotely but unlock requires a local operation", () => {
  assert.deepEqual(transitionLockdown({
    mode: LOCKDOWN_MODES.NORMAL,
    operation: "lock",
    source: "telegram",
  }), { ok: true, mode: LOCKDOWN_MODES.LOCKED });

  assert.deepEqual(transitionLockdown({
    mode: LOCKDOWN_MODES.LOCKED,
    operation: "unlock",
    source: "telegram",
  }), { ok: false, mode: LOCKDOWN_MODES.LOCKED, reason: "local_unlock_required" });

  assert.deepEqual(transitionLockdown({
    mode: LOCKDOWN_MODES.LOCKED,
    operation: "unlock",
    source: "local",
  }), { ok: true, mode: LOCKDOWN_MODES.NORMAL });
});

test("invalid modes and transitions fail closed", () => {
  assert.deepEqual(evaluateLockdown({ mode: "maybe", action: "status" }), {
    allowed: false,
    reason: "invalid_lockdown_state",
  });
  assert.deepEqual(transitionLockdown({ mode: LOCKDOWN_MODES.LOCKED, operation: "toggle", source: "local" }), {
    ok: false,
    mode: LOCKDOWN_MODES.LOCKED,
    reason: "invalid_lockdown_operation",
  });
});

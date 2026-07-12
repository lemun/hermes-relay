import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOCKDOWN_MODES,
  evaluateLockdown,
  transitionLockdown,
} from "../lib/lockdown.mjs";

test("normal mode permits explicitly classified ordinary actions", () => {
  assert.deepEqual(evaluateLockdown({ mode: LOCKDOWN_MODES.NORMAL, action: "merge", classification: "mutate" }), {
    allowed: true,
  });
});

test("locked mode preserves only status, help, stop, and idempotent lock", () => {
  for (const action of ["status", "help", "stop", "lock"]) {
    assert.deepEqual(evaluateLockdown({ mode: LOCKDOWN_MODES.LOCKED, action, classification: "control" }), {
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

test("locked mode denies mutating and session-spawning actions", () => {
  for (const [action, classification] of [["merge", "mutate"], ["push", "mutate"], ["start_coding", "session"]]) {
    assert.deepEqual(evaluateLockdown({ mode: LOCKDOWN_MODES.LOCKED, action, classification }), {
      allowed: false,
      reason: "lockdown_read_only",
    });
  }
});

test("missing and unknown classifications fail closed in both modes", () => {
  for (const mode of [LOCKDOWN_MODES.NORMAL, LOCKDOWN_MODES.LOCKED]) {
    assert.equal(evaluateLockdown({ mode, action: "future" }).allowed, false);
    assert.equal(evaluateLockdown({ mode, action: "future", classification: "future" }).allowed, false);
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
  assert.deepEqual(evaluateLockdown({ mode: "maybe", action: "status", classification: "read" }), {
    allowed: false,
    reason: "invalid_lockdown_state",
  });
  assert.deepEqual(transitionLockdown({ mode: LOCKDOWN_MODES.LOCKED, operation: "toggle", source: "local" }), {
    ok: false,
    mode: LOCKDOWN_MODES.LOCKED,
    reason: "invalid_lockdown_operation",
  });
});

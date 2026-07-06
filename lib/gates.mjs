// Hermes v2 autopilot gates — the load/idle/budget checks that decide whether autopilot may
// dispatch another session right now. evaluateGates is pure (unit-tested exhaustively);
// gatherGateInputs is the thin impure wrapper that actually reads the machine (ioreg/os), kept
// separate and injectable so the decision logic never needs a real machine to test.
// See docs/architecture.md "Config" (hermes.autopilot) and ADR-0005 (single codex slot).

import os from "node:os";
import { exec } from "./proc.mjs";

// Parse `ioreg -c IOHIDSystem -d 4` output for the first `"HIDIdleTime" = <nanoseconds>` entry,
// returning idle seconds (may be fractional). Null if not found — a parse failure must not be
// treated as "idle" or "not idle"; evaluateGates fails OPEN on that gate alone (see below).
export function parseHidIdleSeconds(ioregText) {
  if (!ioregText) return null;
  const m = ioregText.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!m) return null;
  return Number(m[1]) / 1e9;
}

const DEFAULT_MAX_LOAD_PER_CORE = 0.8;
const DEFAULT_MIN_FREE_MEM_MB = 1024;
const DEFAULT_HID_IDLE_MINUTES = 10;

// Pure autopilot gate decision. Collects EVERY deny reason that applies (not just the first)
// so the /auto status surface can show the owner the full picture in one shot.
export function evaluateGates({
  enabled,
  loadavg1,
  cpuCount,
  freeMemMB,
  hidIdleSec,
  runningCount,
  sessionCap,
  codexBusy,
  wantsCodex,
  dispatchedToday,
  dailyBudget,
  cfg = {},
}) {
  const reasons = [];
  const maxLoadPerCore = cfg.maxLoadPerCore ?? DEFAULT_MAX_LOAD_PER_CORE;
  const minFreeMemMB = cfg.minFreeMemMB ?? DEFAULT_MIN_FREE_MEM_MB;
  const hidIdleMinutes = cfg.hidIdleMinutes ?? DEFAULT_HID_IDLE_MINUTES;

  if (!enabled) reasons.push("autopilot off");

  if (typeof runningCount === "number" && typeof sessionCap === "number" && runningCount >= sessionCap) {
    reasons.push(`session cap reached (${runningCount}/${sessionCap})`);
  }

  // ADR-0005: only one codex process may run at a time (shared ~/.codex/auth.json token
  // refresh races otherwise), so a codex-bound dispatch is gated on the single global slot —
  // claude-engine dispatches are unaffected even while codex is busy.
  if (wantsCodex && codexBusy) reasons.push("codex slot busy");

  if (typeof loadavg1 === "number" && typeof cpuCount === "number" && cpuCount > 0) {
    const perCore = loadavg1 / cpuCount;
    if (perCore > maxLoadPerCore) reasons.push(`load too high (${perCore.toFixed(2)} per core)`);
  }

  if (typeof freeMemMB === "number" && freeMemMB < minFreeMemMB) {
    reasons.push(`low memory (${Math.round(freeMemMB)} MB free)`);
  }

  // HID idle gate is a courtesy ("Shai at keyboard -> yield"), not a safety gate: when ioreg
  // parsing fails we have no signal either way, so we fail OPEN here rather than blocking
  // autopilot on a flaky/unavailable idle read.
  if (hidIdleSec !== null && hidIdleSec !== undefined && hidIdleSec < hidIdleMinutes * 60) {
    reasons.push(`owner at keyboard (idle ${Math.round(hidIdleSec)}s)`);
  }

  if (typeof dispatchedToday === "number" && typeof dailyBudget === "number" && dispatchedToday >= dailyBudget) {
    reasons.push(`daily dispatch budget spent (${dispatchedToday}/${dailyBudget})`);
  }

  return { ok: reasons.length === 0, reasons };
}

// Parse `vm_stat` output into RECLAIMABLE megabytes: free + inactive + purgeable +
// speculative pages. On macOS, os.freemem() reports only "Pages free", which a healthy
// Mac keeps near zero (everything else is instantly-reclaimable cache) — a gate fed
// os.freemem() denies autopilot forever (observed live: 130MB "free" on an idle mini).
// Returns null when the text doesn't look like vm_stat output.
export function parseVmStatAvailableMB(vmStatText) {
  if (typeof vmStatText !== "string") return null;
  const pageSize = Number((/page size of (\d+) bytes/.exec(vmStatText) || [])[1]) || 16384;
  let pages = 0, matched = 0;
  for (const name of ["free", "inactive", "purgeable", "speculative"]) {
    const m = new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(vmStatText);
    if (m) { pages += Number(m[1]); matched++; }
  }
  if (!matched) return null;
  return (pages * pageSize) / (1024 * 1024);
}

// Impure gatherer: reads the real machine (ioreg + vm_stat + os.loadavg/cpus) and returns the
// subset of evaluateGates' inputs it can supply on its own (enabled/runningCount/sessionCap/
// codexBusy/wantsCodex/dispatchedToday/dailyBudget/cfg are caller state, not machine state).
// execImpl/osImpl are injectable so tests never shell out or read the real OS.
export async function gatherGateInputs({ execImpl = exec, osImpl = os } = {}) {
  const ioreg = await execImpl("ioreg", ["-c", "IOHIDSystem", "-d", "4"]);
  const hidIdleSec = ioreg.code === 0 ? parseHidIdleSeconds(ioreg.stdout) : null;
  // Prefer vm_stat's reclaimable figure (see parseVmStatAvailableMB); fall back to
  // os.freemem() where vm_stat is unavailable (non-Darwin, e.g. CI).
  const vmStat = await execImpl("vm_stat", []);
  const availableMB = vmStat.code === 0 ? parseVmStatAvailableMB(vmStat.stdout) : null;
  return {
    loadavg1: osImpl.loadavg()[0],
    cpuCount: osImpl.cpus().length,
    freeMemMB: availableMB ?? osImpl.freemem() / (1024 * 1024),
    hidIdleSec,
  };
}

// Roll the daily dispatch counter forward: same day -> +1; a new day -> reset to 1 on `now`'s
// date. Pure; `state` is the persisted { date, count } shape from hermes-autopilot.json.
export function budgetAfterDispatch(state, now) {
  const today = now.toISOString().slice(0, 10);
  if (state?.date === today) {
    return { date: today, count: (state.count || 0) + 1 };
  }
  return { date: today, count: 1 };
}

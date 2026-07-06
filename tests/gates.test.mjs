import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHidIdleSeconds,
  evaluateGates,
  gatherGateInputs,
  budgetAfterDispatch,
  parseVmStatAvailableMB,
} from "../lib/gates.mjs";

// ── parseHidIdleSeconds ──────────────────────────────────────────────────────

test("parseHidIdleSeconds: parses a real-looking ioreg snippet", () => {
  const ioreg = `
+-o IOHIDSystem  <class IOHIDSystem, id 0x100000275, registered, matched, active, busy 0 (0 ms), retain 6>
    {
      "HIDIdleTime" = 3735928559000000
      "HIDActivity" = 1
    }
`;
  // HIDIdleTime is nanoseconds (verified against a live `ioreg -c IOHIDSystem -d 4` read on
  // this machine); 3735928559000000 ns = 3735928.559 s. The task brief's worked example
  // ("~3735.9s") appears to divide by 1e12 instead of 1e9 — flagged as a conflict in the report;
  // this test follows the documented nanosecond unit and the real ioreg reading, not that example.
  const sec = parseHidIdleSeconds(ioreg);
  assert.ok(Math.abs(sec - 3735928.559) < 0.001);
});

test("parseHidIdleSeconds: returns null when not found", () => {
  assert.equal(parseHidIdleSeconds("no such key here"), null);
  assert.equal(parseHidIdleSeconds(""), null);
  assert.equal(parseHidIdleSeconds(null), null);
});

// ── evaluateGates ─────────────────────────────────────────────────────────────

const BASE = {
  enabled: true,
  loadavg1: 1.0,
  cpuCount: 8,
  freeMemMB: 4096,
  hidIdleSec: 20 * 60, // 20 min idle, well past the 10 min default
  runningCount: 1,
  sessionCap: 6,
  codexBusy: false,
  wantsCodex: false,
  dispatchedToday: 2,
  dailyBudget: 10,
  cfg: {},
};

test("evaluateGates: all-pass case returns ok with no reasons", () => {
  const r = evaluateGates(BASE);
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test("evaluateGates: autopilot off", () => {
  const r = evaluateGates({ ...BASE, enabled: false });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ["autopilot off"]);
});

test("evaluateGates: session cap reached", () => {
  const r = evaluateGates({ ...BASE, runningCount: 6, sessionCap: 6 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ["session cap reached (6/6)"]);
});

test("evaluateGates: codex slot busy only blocks when wantsCodex is true", () => {
  const busyButNotWanted = evaluateGates({ ...BASE, codexBusy: true, wantsCodex: false });
  assert.deepEqual(busyButNotWanted, { ok: true, reasons: [] });

  const busyAndWanted = evaluateGates({ ...BASE, codexBusy: true, wantsCodex: true });
  assert.equal(busyAndWanted.ok, false);
  assert.deepEqual(busyAndWanted.reasons, ["codex slot busy"]);

  const wantedButFree = evaluateGates({ ...BASE, codexBusy: false, wantsCodex: true });
  assert.deepEqual(wantedButFree, { ok: true, reasons: [] });
});

test("evaluateGates: load too high (default 0.8 per core)", () => {
  const r = evaluateGates({ ...BASE, loadavg1: 8.1, cpuCount: 8 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ["load too high (1.01 per core)"]);
});

test("evaluateGates: low memory (default 1024 MB)", () => {
  const r = evaluateGates({ ...BASE, freeMemMB: 512 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ["low memory (512 MB free)"]);
});

test("evaluateGates: owner at keyboard (default 10 min idle threshold)", () => {
  const r = evaluateGates({ ...BASE, hidIdleSec: 30 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ["owner at keyboard (idle 30s)"]);
});

test("evaluateGates: hidIdleSec null fails OPEN (does not block, no reason added)", () => {
  const r = evaluateGates({ ...BASE, hidIdleSec: null });
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test("evaluateGates: daily dispatch budget spent", () => {
  const r = evaluateGates({ ...BASE, dispatchedToday: 10, dailyBudget: 10 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ["daily dispatch budget spent (10/10)"]);
});

test("evaluateGates: multiple deny reasons accumulate (all collected, not just the first)", () => {
  const r = evaluateGates({
    ...BASE,
    enabled: false,
    runningCount: 6, sessionCap: 6,
    loadavg1: 16, cpuCount: 8,
    freeMemMB: 100,
    hidIdleSec: 5,
    dispatchedToday: 10, dailyBudget: 10,
    wantsCodex: true, codexBusy: true,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, [
    "autopilot off",
    "session cap reached (6/6)",
    "codex slot busy",
    "load too high (2.00 per core)",
    "low memory (100 MB free)",
    "owner at keyboard (idle 5s)",
    "daily dispatch budget spent (10/10)",
  ]);
});

test("evaluateGates: cfg overrides the default thresholds", () => {
  const r = evaluateGates({
    ...BASE,
    loadavg1: 1.5, cpuCount: 8, // 0.1875 per core
    cfg: { maxLoadPerCore: 0.1, minFreeMemMB: 8192, hidIdleMinutes: 60 },
    hidIdleSec: 20 * 60,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, [
    "load too high (0.19 per core)",
    "low memory (4096 MB free)",
    "owner at keyboard (idle 1200s)",
  ]);
});

// ── gatherGateInputs (injectable) ────────────────────────────────────────────

test("gatherGateInputs: wires ioreg parsing + os stats through injected impls", async () => {
  const execImpl = async (bin, args) => {
    if (bin === "ioreg") {
      assert.deepEqual(args, ["-c", "IOHIDSystem", "-d", "4"]);
      return { code: 0, stdout: '"HIDIdleTime" = 5000000000\n', stderr: "" };
    }
    assert.equal(bin, "vm_stat"); // the only other machine probe
    return { code: 1, stdout: "", stderr: "unavailable" }; // → freemem fallback
  };
  const osImpl = {
    loadavg: () => [2.4, 2.1, 1.9],
    cpus: () => Array.from({ length: 4 }, () => ({})),
    freemem: () => 2 * 1024 * 1024 * 1024,
  };
  const inputs = await gatherGateInputs({ execImpl, osImpl });
  assert.equal(inputs.loadavg1, 2.4);
  assert.equal(inputs.cpuCount, 4);
  assert.equal(inputs.freeMemMB, 2048);
  assert.equal(inputs.hidIdleSec, 5);
});

test("gatherGateInputs: a failed ioreg exec yields null hidIdleSec, not a thrown error", async () => {
  const execImpl = async () => ({ code: 1, stdout: "", stderr: "no such device" });
  const osImpl = { loadavg: () => [0], cpus: () => [{}], freemem: () => 0 };
  const inputs = await gatherGateInputs({ execImpl, osImpl });
  assert.equal(inputs.hidIdleSec, null);
});

// ── budgetAfterDispatch ───────────────────────────────────────────────────────

test("budgetAfterDispatch: increments count on the same day", () => {
  const now = new Date("2026-07-06T12:00:00Z");
  assert.deepEqual(budgetAfterDispatch({ date: "2026-07-06", count: 3 }, now), { date: "2026-07-06", count: 4 });
});

test("budgetAfterDispatch: rolls to a new day and resets count to 1", () => {
  const now = new Date("2026-07-07T00:05:00Z");
  assert.deepEqual(budgetAfterDispatch({ date: "2026-07-06", count: 9 }, now), { date: "2026-07-07", count: 1 });
});

test("budgetAfterDispatch: missing/empty prior state starts a fresh day at count 1", () => {
  const now = new Date("2026-07-06T12:00:00Z");
  assert.deepEqual(budgetAfterDispatch(undefined, now), { date: "2026-07-06", count: 1 });
  assert.deepEqual(budgetAfterDispatch({}, now), { date: "2026-07-06", count: 1 });
});

test("parseVmStatAvailableMB: counts reclaimable pages, not just free (macOS gate fix)", () => {
  const sample = [
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
    "Pages free:                                     4469.",
    "Pages active:                                 175537.",
    "Pages inactive:                               172254.",
    "Pages speculative:                              2725.",
    "Pages throttled:                                   0.",
    "Pages wired down:                             310362.",
    "Pages purgeable:                                   6.",
  ].join("\n");
  const mb = parseVmStatAvailableMB(sample);
  // (4469 + 172254 + 2725 + 6) * 16384 bytes ≈ 2804 MB — an order of magnitude above
  // the 130MB os.freemem() reported on the same machine at the same moment.
  assert.ok(Math.abs(mb - 2804) < 5, `expected ~2804MB, got ${mb}`);
  assert.equal(parseVmStatAvailableMB("not vm_stat output"), null);
  assert.equal(parseVmStatAvailableMB(null), null);
});

test("gatherGateInputs: prefers vm_stat reclaimable MB, falls back to os.freemem", async () => {
  const osImpl = { loadavg: () => [1], cpus: () => Array(8), freemem: () => 512 * 1024 * 1024 };
  const withVm = await gatherGateInputs({
    execImpl: async (bin) => bin === "vm_stat"
      ? { code: 0, stdout: "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 65536.\n", stderr: "" }
      : { code: 1, stdout: "", stderr: "" },
    osImpl,
  });
  assert.equal(withVm.freeMemMB, 1024); // 65536 pages * 16KB = 1GB
  const noVm = await gatherGateInputs({
    execImpl: async () => ({ code: 1, stdout: "", stderr: "" }),
    osImpl,
  });
  assert.equal(noVm.freeMemMB, 512);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTOPILOT_FILE,
  loadAutopilot,
  saveAutopilot,
  setAutopilot,
  pickNextDispatch,
  autopilotStatusText,
} from "../lib/autopilot.mjs";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "hermes-autopilot-")), "state.json");

// ── AUTOPILOT_FILE constant ──────────────────────────────────────────────────────────────────

test("AUTOPILOT_FILE points at state/hermes-autopilot.json", () => {
  assert.match(AUTOPILOT_FILE, /state[\\/]hermes-autopilot\.json$/);
});

// ── load/save round-trip + corrupt tolerance ────────────────────────────────────────────────

test("loadAutopilot tolerates a missing file, returning a safe-off default shape", () => {
  const data = loadAutopilot({ file: path.join(tmpdir(), "does-not-exist-xyz.json") });
  assert.deepEqual(data, { enabled: false, dispatched: { date: "", count: 0 } });
});

test("loadAutopilot tolerates a corrupt file", () => {
  const file = tmpFile();
  writeFileSync(file, "{not json");
  const data = loadAutopilot({ file });
  assert.deepEqual(data, { enabled: false, dispatched: { date: "", count: 0 } });
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("loadAutopilot tolerates a partially-shaped file (missing dispatched)", () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ enabled: true }));
  const data = loadAutopilot({ file });
  assert.deepEqual(data, { enabled: true, dispatched: { date: "", count: 0 } });
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("saveAutopilot round-trips through loadAutopilot", () => {
  const file = tmpFile();
  const data = { enabled: true, dispatched: { date: "2026-07-06", count: 3 } };
  saveAutopilot(data, { file });
  assert.deepEqual(loadAutopilot({ file }), data);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

// ── setAutopilot ─────────────────────────────────────────────────────────────────────────────

test("setAutopilot flips enabled without touching dispatched (pure copy)", () => {
  const before = { enabled: false, dispatched: { date: "2026-07-06", count: 5 } };
  const after = setAutopilot(before, true);
  assert.deepEqual(after, { enabled: true, dispatched: { date: "2026-07-06", count: 5 } });
  assert.equal(before.enabled, false); // original untouched
});

test("setAutopilot(false) also preserves dispatched", () => {
  const before = { enabled: true, dispatched: { date: "2026-07-06", count: 5 } };
  const after = setAutopilot(before, false);
  assert.deepEqual(after.dispatched, before.dispatched);
  assert.equal(after.enabled, false);
});

// ── pickNextDispatch ─────────────────────────────────────────────────────────────────────────

const issue = (number, over = {}) => ({
  number, repoKey: "rn", labels: [], title: `issue ${number}`, ...over,
});

const OK_GATES = { ok: true, reasons: [] };
const emptySessions = { sessions: [] };

test("pickNextDispatch: gates-deny short-circuits with the gates' reasons", () => {
  const gatesResult = { ok: false, reasons: ["autopilot off", "load too high (1.20 per core)"] };
  const r = pickNextDispatch({ readyIssues: [issue(1)], sessionsData: emptySessions, gatesResult });
  assert.deepEqual(r, { issue: null, reasons: ["autopilot off", "load too high (1.20 per core)"] });
});

test("pickNextDispatch: no ready issues", () => {
  const r = pickNextDispatch({ readyIssues: [], sessionsData: emptySessions, gatesResult: OK_GATES });
  assert.equal(r.issue, null);
  assert.deepEqual(r.reasons, ["no ready issues"]);
});

test("pickNextDispatch: FIFO order picks the OLDEST (lowest-numbered) issue first", () => {
  const readyIssues = [issue(30), issue(5), issue(17)];
  const r = pickNextDispatch({ readyIssues, sessionsData: emptySessions, gatesResult: OK_GATES });
  assert.equal(r.issue.number, 5);
  assert.equal(r.engine, "codex");
});

test("pickNextDispatch: engine label override picks claude for engine:claude issues", () => {
  const readyIssues = [issue(1, { labels: [{ name: "engine:claude" }] })];
  const r = pickNextDispatch({ readyIssues, sessionsData: emptySessions, gatesResult: OK_GATES });
  assert.equal(r.engine, "claude");
});

test("pickNextDispatch: defaultEngine is overridable", () => {
  const readyIssues = [issue(1)];
  const r = pickNextDispatch({ readyIssues, sessionsData: emptySessions, gatesResult: OK_GATES, defaultEngine: "claude" });
  assert.equal(r.engine, "claude");
});

test("pickNextDispatch: skips issues with an already-running session (repoKey+issue dedup)", () => {
  const readyIssues = [issue(1), issue(2)];
  // engine: claude here so the dedup is isolated from the ADR-0005 codex-slot gate (covered
  // separately below) — otherwise issue 2 (also codex by default) would ALSO be skipped for a
  // different reason (codex slot busy), muddying what this test is asserting.
  const sessionsData = { sessions: [{ status: "running", repoKey: "rn", issue: 1, engine: "claude" }] };
  const r = pickNextDispatch({ readyIssues, sessionsData, gatesResult: OK_GATES });
  assert.equal(r.issue.number, 2);
});

test("pickNextDispatch: dedup only matches on repoKey+issue, not issue number alone", () => {
  const readyIssues = [issue(1, { repoKey: "next" }), issue(1, { repoKey: "rn" })];
  // A running session for rn#1 should NOT block next#1. engine: claude to isolate from the
  // codex-slot gate, same reasoning as the test above.
  const sessionsData = { sessions: [{ status: "running", repoKey: "rn", issue: 1, engine: "claude" }] };
  const r = pickNextDispatch({ readyIssues, sessionsData, gatesResult: OK_GATES });
  assert.equal(r.issue.repoKey, "next");
});

test("pickNextDispatch: a non-running session for the same issue does NOT dedup it out", () => {
  const readyIssues = [issue(1)];
  const sessionsData = { sessions: [{ status: "done", repoKey: "rn", issue: 1, engine: "codex" }] };
  const r = pickNextDispatch({ readyIssues, sessionsData, gatesResult: OK_GATES });
  assert.equal(r.issue.number, 1);
});

test("pickNextDispatch: ADR-0005 codex slot busy blocks a codex-engine issue but a LATER claude issue IS picked", () => {
  const readyIssues = [issue(1), issue(2, { labels: [{ name: "engine:claude" }] })];
  const sessionsData = { sessions: [{ status: "running", repoKey: "other", issue: 99, engine: "codex" }] };
  const r = pickNextDispatch({ readyIssues, sessionsData, gatesResult: OK_GATES });
  assert.equal(r.issue.number, 2);
  assert.equal(r.engine, "claude");
});

test("pickNextDispatch: codex slot busy with only codex issues in queue yields null with reasons", () => {
  const readyIssues = [issue(1), issue(2)];
  const sessionsData = { sessions: [{ status: "running", repoKey: "other", issue: 99, engine: "codex" }] };
  const r = pickNextDispatch({ readyIssues, sessionsData, gatesResult: OK_GATES });
  assert.equal(r.issue, null);
  assert.deepEqual(r.reasons, ["codex slot busy", "codex slot busy"]);
});

test("pickNextDispatch: codex slot busy does NOT block a claude issue even when claude is head-of-queue (isn't blocked either way)", () => {
  const readyIssues = [issue(1, { labels: [{ name: "engine:claude" }] }), issue(2)];
  const sessionsData = { sessions: [{ status: "running", repoKey: "other", issue: 99, engine: "codex" }] };
  const r = pickNextDispatch({ readyIssues, sessionsData, gatesResult: OK_GATES });
  assert.equal(r.issue.number, 1);
  assert.equal(r.engine, "claude");
});

test("pickNextDispatch: running claude sessions do not occupy the codex slot", () => {
  const readyIssues = [issue(1)]; // codex by default
  const sessionsData = { sessions: [{ status: "running", repoKey: "other", issue: 99, engine: "claude" }] };
  const r = pickNextDispatch({ readyIssues, sessionsData, gatesResult: OK_GATES });
  assert.equal(r.issue.number, 1);
  assert.equal(r.engine, "codex");
});

test("pickNextDispatch: never reorders among same-engine issues (codex-blocked head skips to next codex issue only if pickable)", () => {
  // Both issue 1 and issue 3 are codex; codex slot is busy, so BOTH are skipped in order,
  // and issue 2 (claude) — despite being in the middle — is picked without reordering the
  // codex issues relative to each other in the reasons trace.
  const readyIssues = [issue(1), issue(2, { labels: [{ name: "engine:claude" }] }), issue(3)];
  const sessionsData = { sessions: [{ status: "running", repoKey: "other", issue: 99, engine: "codex" }] };
  const r = pickNextDispatch({ readyIssues, sessionsData, gatesResult: OK_GATES });
  assert.equal(r.issue.number, 2);
});

test("pickNextDispatch: omitted gatesResult is treated as passing (caller always supplies it in practice)", () => {
  const r = pickNextDispatch({ readyIssues: [issue(1)], sessionsData: emptySessions });
  assert.equal(r.issue.number, 1);
});

// ── autopilotStatusText ──────────────────────────────────────────────────────────────────────

test("autopilotStatusText mentions ON/OFF and the daily budget", () => {
  const onText = autopilotStatusText({
    enabled: true, dispatched: { date: "2026-07-06", count: 3 }, dailyBudget: 10, running: [], pendingQuestions: [],
  });
  assert.match(onText, /Autopilot: ON/);
  assert.match(onText, /3\/10/);

  const offText = autopilotStatusText({
    enabled: false, dispatched: { date: "", count: 0 }, dailyBudget: 10, running: [], pendingQuestions: [],
  });
  assert.match(offText, /Autopilot: OFF/);
  assert.match(offText, /0\/10/);
});

test("autopilotStatusText reports running sessions and pending questions", () => {
  const text = autopilotStatusText({
    enabled: true,
    dispatched: { date: "2026-07-06", count: 1 },
    dailyBudget: 10,
    running: [{ id: "sess-a" }, { id: "sess-b" }],
    pendingQuestions: [{ id: "q-1" }],
  });
  assert.match(text, /Running: 2/);
  assert.match(text, /Waiting on you: 1 question/);
});

test("autopilotStatusText handles zero running / zero pending gracefully", () => {
  const text = autopilotStatusText({
    enabled: false, dispatched: { date: "", count: 0 }, dailyBudget: 10, running: [], pendingQuestions: [],
  });
  assert.match(text, /Running: none/);
  assert.doesNotMatch(text, /Waiting on you/);
});

test("autopilotStatusText also accepts plain counts (not just arrays) for running/pendingQuestions", () => {
  const text = autopilotStatusText({
    enabled: true, dispatched: { date: "2026-07-06", count: 2 }, dailyBudget: 10, running: 3, pendingQuestions: 2,
  });
  assert.match(text, /Running: 3/);
  assert.match(text, /Waiting on you: 2 questions/);
});

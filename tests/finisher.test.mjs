import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newFinisherState,
  oppositeEngine,
  nextFinisherStep,
  applyAuditVerdict,
  applyMergeResult,
  applyOwnerMergeDecision,
  parkState,
  buildAuditPrompt,
  parseAuditVerdict,
  buildFixupPrompt,
  buildConflictPrompt,
  finisherLabelTransitions,
  describeFinisherStep,
} from "../lib/finisher.mjs";

// Deep-freeze a plain object graph (arrays + plain objects only — good enough for FinisherState).
function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.values(obj).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

const NOW = new Date("2026-07-06T12:00:00Z");

// ── newFinisherState / oppositeEngine ───────────────────────────────────────────────────────

test("newFinisherState builds the fresh shape at stage conflicts", () => {
  const s = newFinisherState({ issue: 42, repoKey: "rn", prNumber: 7, now: NOW });
  assert.deepEqual(s, {
    issue: 42,
    repoKey: "rn",
    prNumber: 7,
    stage: "conflicts",
    attempts: {},
    auditVerdict: null,
    skipAudit: false,
    startedAt: "2026-07-06T12:00:00.000Z",
  });
});

test("newFinisherState honors skipAudit", () => {
  const s = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, skipAudit: true, now: NOW });
  assert.equal(s.skipAudit, true);
});

test("oppositeEngine flips codex<->claude", () => {
  assert.equal(oppositeEngine("codex"), "claude");
  assert.equal(oppositeEngine("claude"), "codex");
});

// ── nextFinisherStep: full happy path, one call at a time ──────────────────────────────────

test("nextFinisherStep: full happy path from conflicts through merge to done", () => {
  let state = newFinisherState({ issue: 42, repoKey: "rn", prNumber: 7, now: NOW });

  // 1. mergeable still computing -> wait, stage unchanged.
  let step = nextFinisherStep(state, { pr: { mergeable: null }, checks: {} });
  assert.equal(step.action, "wait");
  assert.equal(step.state.stage, "conflicts");
  state = step.state;

  // 2. mergeable true -> falls through to audit; auditVerdict null, first look -> spawn audit.
  step = nextFinisherStep(state, { pr: { mergeable: true }, checks: {} });
  assert.equal(step.action, "audit");
  assert.equal(step.state.stage, "audit");
  assert.equal(step.state.attempts.audit, 1);
  state = step.state;

  // 3. audit session hasn't reported back yet (still null, already tried once) -> wait.
  step = nextFinisherStep(state, { pr: { mergeable: true }, checks: {} });
  assert.equal(step.action, "wait");
  assert.equal(step.state.stage, "audit");
  state = step.state;

  // Audit session comes back with an approval.
  state = applyAuditVerdict(state, { verdict: "approve", notes: "looks good" });

  // 4. verdict approve -> falls through to ci; checks still pending -> wait.
  step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 2, pending: 1, failed: 0 } });
  assert.equal(step.action, "wait");
  assert.equal(step.state.stage, "ci");
  state = step.state;

  // 5. all green -> falls through to merge -> merge action, attempts.merge = 1.
  step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 2, pending: 0, failed: 0 } });
  assert.equal(step.action, "merge");
  assert.equal(step.state.stage, "merge");
  assert.equal(step.state.attempts.merge, 1);
  state = step.state;

  // 6. merge session reports success -> stage done.
  state = applyMergeResult(state, { merged: true, message: "merged cleanly" });
  assert.equal(state.stage, "done");

  // 7. done -> action done.
  step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 2, pending: 0, failed: 0 } });
  assert.equal(step.action, "done");
  assert.equal(step.state.stage, "done");
});

// ── conflicts: retry once then park ─────────────────────────────────────────────────────────

test("nextFinisherStep: conflicts retries once via resolve-conflicts, then parks", () => {
  let state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW });

  let step = nextFinisherStep(state, { pr: { mergeable: false }, checks: {} });
  assert.equal(step.action, "resolve-conflicts");
  assert.equal(step.state.attempts.conflicts, 1);
  assert.equal(step.state.stage, "conflicts");
  state = step.state;

  // Conflicts persist after the one retry -> park.
  step = nextFinisherStep(state, { pr: { mergeable: false }, checks: {} });
  assert.equal(step.action, "park");
  assert.match(step.reason, /merge conflicts persisted after one resolve attempt/);
  assert.equal(step.state.stage, "conflicts"); // decision table doesn't itself move to "parked"
});

// ── audit block -> ask-owner (NOT an automatic park), then both owner decisions ─────────────

test("nextFinisherStep: audit block asks the owner instead of parking automatically", () => {
  let state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW });
  state = { ...state, stage: "audit" };
  state = applyAuditVerdict(state, { verdict: "block", notes: "found a data-loss bug" });

  const step = nextFinisherStep(state, { pr: { mergeable: true }, checks: {} });
  assert.equal(step.action, "ask-owner");
  assert.match(step.reason, /found a data-loss bug/);
  assert.equal(step.state.stage, "audit"); // still parked on the decision, not moved
});

test("applyOwnerMergeDecision: proceed=true skips audit and resumes at ci", () => {
  let state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW });
  state = { ...state, stage: "audit" };
  state = applyAuditVerdict(state, { verdict: "block", notes: "minor nit" });

  const after = applyOwnerMergeDecision(state, true);
  assert.equal(after.skipAudit, true);
  assert.equal(after.stage, "ci");

  // Confirms the pipeline actually proceeds from ci now.
  const step = nextFinisherStep(after, { pr: { mergeable: true }, checks: { total: 0, pending: 0, failed: 0 } });
  assert.equal(step.action, "merge");
});

test("applyOwnerMergeDecision: proceed=false parks with the fixed reason", () => {
  let state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW });
  state = { ...state, stage: "audit" };
  state = applyAuditVerdict(state, { verdict: "block", notes: "real bug" });

  const after = applyOwnerMergeDecision(state, false);
  assert.equal(after.stage, "parked");
  assert.equal(after.parkedReason, "owner declined after audit flagged issues");

  const step = nextFinisherStep(after, { pr: {}, checks: {} });
  assert.equal(step.action, "park");
  assert.equal(step.reason, "owner declined after audit flagged issues");
});

// ── ci: fixup once then park; total===0 counts as green ─────────────────────────────────────

test("nextFinisherStep: ci failed retries once via fixup, then parks", () => {
  let state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW });
  state = { ...state, stage: "ci" };

  let step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 3, pending: 0, failed: 1 } });
  assert.equal(step.action, "fixup");
  assert.equal(step.state.attempts.fixup, 1);
  state = step.state;

  step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 3, pending: 0, failed: 1 } });
  assert.equal(step.action, "park");
  assert.match(step.reason, /CI still red after one fix-up session/);
});

test("nextFinisherStep: total===0 (no checks configured) counts as green and proceeds to merge", () => {
  let state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW });
  state = { ...state, stage: "ci" };

  const step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 0, pending: 0, failed: 0 } });
  assert.equal(step.action, "merge");
  assert.equal(step.state.stage, "merge");
});

// ── merge: fails once -> retry, fails twice -> park ─────────────────────────────────────────

test("nextFinisherStep: merge failing once retries, failing twice parks", () => {
  let state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW });
  state = { ...state, stage: "merge" };

  // First attempt.
  let step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 0, pending: 0, failed: 0 } });
  assert.equal(step.action, "merge");
  assert.equal(step.state.attempts.merge, 1);
  state = step.state;

  // Merge session reports failure -> stays on "merge" (per applyMergeResult contract).
  state = applyMergeResult(state, { merged: false, message: "GitHub merge API 409" });
  assert.equal(state.stage, "merge");

  // Second attempt.
  step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 0, pending: 0, failed: 0 } });
  assert.equal(step.action, "merge");
  assert.equal(step.state.attempts.merge, 2);
  state = step.state;

  state = applyMergeResult(state, { merged: false, message: "GitHub merge API 409 again" });

  // Third look -> attempts.merge already 2 -> park.
  step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 0, pending: 0, failed: 0 } });
  assert.equal(step.action, "park");
  assert.match(step.reason, /merge failed twice/);
});

// ── parkState helper ─────────────────────────────────────────────────────────────────────────

test("parkState sets stage parked with the given reason (pure copy)", () => {
  const state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW });
  const parked = parkState(state, "GitHub API returned an unrecoverable error");
  assert.equal(parked.stage, "parked");
  assert.equal(parked.parkedReason, "GitHub API returned an unrecoverable error");
  assert.equal(state.stage, "conflicts"); // original untouched

  const step = nextFinisherStep(parked, { pr: {}, checks: {} });
  assert.equal(step.action, "park");
  assert.equal(step.reason, "GitHub API returned an unrecoverable error");
});

// ── skipAudit path ────────────────────────────────────────────────────────────────────────────

test("nextFinisherStep: skipAudit=true jumps straight from audit stage into ci logic", () => {
  let state = newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, skipAudit: true, now: NOW });
  state = { ...state, stage: "audit" };

  const step = nextFinisherStep(state, { pr: { mergeable: true }, checks: { total: 0, pending: 0, failed: 0 } });
  assert.equal(step.state.stage, "merge");
  assert.equal(step.action, "merge");
});

// ── prompts ──────────────────────────────────────────────────────────────────────────────────

test("buildAuditPrompt includes issue/PR/repo, the gh pr diff command, decisions, and json contract", () => {
  const prompt = buildAuditPrompt({
    issue: 42,
    repoSlug: "lemun/example-app",
    prNumber: 7,
    decisions: ["use zustand for state", "no new deps"],
    handoffNote: "touched src/screens/Home.tsx only",
  });
  assert.match(prompt, /auditing PR #7 implementing issue #42 in lemun\/example-app/);
  assert.match(prompt, /gh pr diff 7 --repo lemun\/example-app/);
  assert.match(prompt, /use zustand for state/);
  assert.match(prompt, /no new deps/);
  assert.match(prompt, /touched src\/screens\/Home\.tsx only/);
  assert.match(prompt, /correctness bugs/);
  assert.match(prompt, /security issues or data loss/);
  assert.match(prompt, /CI-likely failures/);
  assert.match(prompt, /Do NOT flag style nits/);
  assert.match(prompt, /```json/);
  assert.match(prompt, /"verdict": "approve"/);
});

test("buildAuditPrompt tolerates missing decisions/handoffNote", () => {
  const prompt = buildAuditPrompt({ issue: 1, repoSlug: "lemun/x", prNumber: 2 });
  assert.match(prompt, /_none recorded_/);
});

test("buildFixupPrompt names the failing checks and the json contract", () => {
  const prompt = buildFixupPrompt({ prNumber: 9, repoSlug: "lemun/x", failedCheckNames: ["lint", "typecheck"] });
  assert.match(prompt, /PR #9/);
  assert.match(prompt, /lint, typecheck/);
  assert.match(prompt, /Do NOT push/);
  assert.match(prompt, /"done": true/);
});

test("buildConflictPrompt names the base branch and preserves-both-intents instruction", () => {
  const prompt = buildConflictPrompt({ prNumber: 9, baseBranch: "main" });
  assert.match(prompt, /origin\/main/);
  assert.match(prompt, /PR #9/);
  assert.match(prompt, /Preserve BOTH intents/);
  assert.match(prompt, /Do NOT push/);
});

// ── parseAuditVerdict: happy + hostile ──────────────────────────────────────────────────────

test("parseAuditVerdict: happy path parses verdict + notes from the last fenced block", () => {
  const text = 'Some prose.\n```json\n{"verdict": "approve", "notes": "all good"}\n```\n';
  assert.deepEqual(parseAuditVerdict(text), { verdict: "approve", notes: "all good" });
});

test("parseAuditVerdict: takes the LAST fenced json block when multiple are present", () => {
  const text = '```json\n{"verdict": "block", "notes": "draft"}\n```\nMore thinking...\n```json\n{"verdict": "approve", "notes": "final"}\n```';
  assert.deepEqual(parseAuditVerdict(text), { verdict: "approve", notes: "final" });
});

test("parseAuditVerdict: hostile/malformed inputs all fail closed to null", () => {
  assert.equal(parseAuditVerdict(""), null);
  assert.equal(parseAuditVerdict(undefined), null);
  assert.equal(parseAuditVerdict("no fenced block here"), null);
  assert.equal(parseAuditVerdict("```json\nnot even json\n```"), null);
  assert.equal(parseAuditVerdict('```json\n{"verdict": "maybe"}\n```'), null); // invalid verdict
  assert.equal(parseAuditVerdict('```json\n{"notes": "no verdict field"}\n```'), null);
  assert.equal(parseAuditVerdict('```json\n"just a string"\n```'), null);
  assert.equal(parseAuditVerdict('```json\n[1,2,3]\n```'), null);
});

test("parseAuditVerdict: defaults notes to empty string when absent but verdict is valid", () => {
  assert.deepEqual(parseAuditVerdict('```json\n{"verdict": "approve"}\n```'), { verdict: "approve", notes: "" });
});

// ── label transitions ────────────────────────────────────────────────────────────────────────

test("finisherLabelTransitions: start adds finishing and removes pr-open", () => {
  assert.deepEqual(finisherLabelTransitions("start"), { add: ["finishing"], remove: ["pr-open"] });
});

test("finisherLabelTransitions: done removes finishing and adds nothing (PR merge closes the issue)", () => {
  assert.deepEqual(finisherLabelTransitions("done"), { add: [], remove: ["finishing"] });
});

test("finisherLabelTransitions: parked adds blocked and removes finishing", () => {
  assert.deepEqual(finisherLabelTransitions("parked"), { add: ["blocked"], remove: ["finishing"] });
});

test("finisherLabelTransitions: unknown stage is a safe no-op", () => {
  assert.deepEqual(finisherLabelTransitions("bogus"), { add: [], remove: [] });
});

// ── describeFinisherStep ─────────────────────────────────────────────────────────────────────

test("describeFinisherStep renders one phone-friendly line per action", () => {
  assert.match(describeFinisherStep({ action: "resolve-conflicts", reason: "merge conflicts detected" }), /Resolving merge conflicts/);
  assert.match(describeFinisherStep({ action: "audit", reason: "spawning cross-engine audit session" }), /cross-engine audit/);
  assert.match(describeFinisherStep({ action: "fixup", reason: "CI has failing checks" }), /CI fix-up session/);
  assert.match(describeFinisherStep({ action: "merge", reason: "all gates green" }), /Merging now/);
  assert.match(describeFinisherStep({ action: "wait", reason: "CI running" }), /Waiting/);
  assert.match(describeFinisherStep({ action: "ask-owner", reason: "audit flagged issues: x" }), /Needs your call/);
  assert.match(describeFinisherStep({ action: "park", reason: "merge failed twice" }), /Parked/);
  assert.equal(describeFinisherStep({ action: "done" }), "Done — merged.");
});

// ── input-state immutability ─────────────────────────────────────────────────────────────────

test("nextFinisherStep never mutates a deep-frozen input state (throughout the whole happy path)", () => {
  let state = deepFreeze(newFinisherState({ issue: 42, repoKey: "rn", prNumber: 7, now: NOW }));

  assert.doesNotThrow(() => nextFinisherStep(state, { pr: { mergeable: null }, checks: {} }));
  let step = nextFinisherStep(state, { pr: { mergeable: true }, checks: {} });
  assert.equal(step.state.stage, "audit");

  state = deepFreeze(step.state);
  assert.doesNotThrow(() => nextFinisherStep(state, { pr: { mergeable: true }, checks: {} }));

  const blockState = deepFreeze(applyAuditVerdict(step.state, { verdict: "block", notes: "n" }));
  assert.doesNotThrow(() => nextFinisherStep(blockState, { pr: { mergeable: true }, checks: {} }));
});

test("applyAuditVerdict/applyMergeResult/applyOwnerMergeDecision/parkState never mutate a frozen input", () => {
  const base = deepFreeze(newFinisherState({ issue: 1, repoKey: "rn", prNumber: 2, now: NOW }));
  assert.doesNotThrow(() => applyAuditVerdict(base, { verdict: "approve", notes: "ok" }));
  assert.doesNotThrow(() => applyMergeResult(base, { merged: true, message: "m" }));
  assert.doesNotThrow(() => applyOwnerMergeDecision(base, true));
  assert.doesNotThrow(() => applyOwnerMergeDecision(base, false));
  assert.doesNotThrow(() => parkState(base, "reason"));
});

test("buildAuditPrompt: offline variant swaps gh for local git diff against the base", () => {
  const online = buildAuditPrompt({ issue: 42, repoSlug: "o/r", prNumber: 7, decisions: [] });
  assert.match(online, /gh pr diff 7 --repo o\/r/);
  const offline = buildAuditPrompt({ issue: 42, repoSlug: "o/r", prNumber: 7, decisions: [], offline: true, baseBranch: "develop" });
  assert.match(offline, /NO network access/);
  assert.match(offline, /git diff origin\/develop\.\.\.HEAD/);
  assert.doesNotMatch(offline, /gh pr diff/);
  assert.match(offline, /issue #42 in o\/r/);
});

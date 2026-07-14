// Autopilot (CONTEXT.md "Autopilot"; docs/architecture.md "Config") — the opt-in mode that
// drains `ready` issues on its own, subject to the gates in lib/gates.mjs. Default OFF, and idle
// truly means zero LLM tokens: with autopilot off (or nothing pickable) this module never causes
// a session to spawn — the bot's poll loop just finds `{ issue: null }` and does nothing further.
//
// pickNextDispatch is the only interesting decision here and it is pure (no I/O): the caller
// gathers readyIssues/sessionsData/gatesResult and this module picks (at most) one issue to
// dispatch, honoring ADR-0005's single global codex slot without head-of-line-blocking the whole
// FIFO queue on it (a slot-blocked codex issue must not prevent a later claude-engine issue from
// going out). State (state/hermes-autopilot.json) is a tiny on/off + daily-counter record; see
// lib/gates.mjs's budgetAfterDispatch for the counter's own roll-forward logic, which this module
// does not duplicate.

import fs from "node:fs";
import path from "node:path";
import { ROOT, writeJsonAtomic } from "./runtime.mjs";
import { LABELS } from "./labels.mjs";

export const AUTOPILOT_FILE = path.join(ROOT, "state", "hermes-autopilot.json");

// ── store — tolerant load, atomic save ──────────────────────────────────────────────────────

// Tolerant load: missing or corrupt file -> a clean, safe-by-default shape (enabled: false, so a
// half-written or deleted state file can never silently turn autopilot ON).
export function loadAutopilot({ file = AUTOPILOT_FILE } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && typeof data === "object") {
      return {
        enabled: !!data.enabled,
        dispatched: {
          date: typeof data.dispatched?.date === "string" ? data.dispatched.date : "",
          count: typeof data.dispatched?.count === "number" ? data.dispatched.count : 0,
        },
      };
    }
  } catch { /* missing or corrupt -> fresh */ }
  return { enabled: false, dispatched: { date: "", count: 0 } };
}

export function saveAutopilot(data, { file = AUTOPILOT_FILE } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, data);
}

// Pure copy — flips the on/off flag, leaving the dispatch counter untouched (toggling autopilot
// off and back on the same day must not reset the daily budget).
export function setAutopilot(data, enabled) {
  return { ...data, enabled: !!enabled };
}

// ── FIFO pick, ADR-0005 slot-aware ──────────────────────────────────────────────────────────

function issueLabelNames(issue) {
  return (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
}

function engineForIssue(issue, defaultEngine) {
  return issueLabelNames(issue).includes(LABELS.ENGINE_CLAUDE) ? "claude" : defaultEngine;
}

function hasRunningSession(sessionsData, repoKey, issueNumber) {
  const sessions = sessionsData?.sessions || [];
  return sessions.some(
    (s) => s.status === "running" && s.repoKey === repoKey && s.issue === issueNumber
  );
}

/**
 * Pick the next ready issue to dispatch, or null with human-readable reasons.
 *
 *  - gatesResult.ok === false short-circuits immediately with the gates' own reasons (load/idle/
 *    budget/codex-slot/etc. — see lib/gates.mjs evaluateGates).
 *  - readyIssues is sorted FIFO by issue number ascending (oldest first) before picking.
 *  - an issue that already has a running session (matched by repoKey+issue number against
 *    sessionsData) is skipped — never double-dispatched.
 *  - engine is `engine:claude` label -> "claude", else `defaultEngine` (docs/architecture.md:
 *    absence of an engine label means the default, currently codex).
 *  - ADR-0005: a codex-engine issue is only pickable while NO codex session is currently
 *    running (one global slot, shared auth.json token-refresh race). A claude-engine issue is
 *    never blocked by that slot. Critically, a slot-blocked codex issue at the head of the queue
 *    must NOT block a later claude-engine issue from being picked — we skip past it rather than
 *    stopping the scan — but same-engine issues are never reordered relative to each other (the
 *    scan is a single left-to-right pass over the FIFO-sorted list, so ties within an engine
 *    always resolve to the lower issue number).
 */
export function pickNextDispatch({ readyIssues, sessionsData, gatesResult, defaultEngine = "codex" } = {}) {
  if (gatesResult && gatesResult.ok === false) {
    return { issue: null, reasons: gatesResult.reasons || ["gates denied"] };
  }

  const queue = [...(readyIssues || [])].sort((a, b) => a.number - b.number);
  if (queue.length === 0) {
    return { issue: null, reasons: ["no ready issues"] };
  }

  const codexIsBusy = (sessionsData?.sessions || []).some(
    (s) => s.status === "running" && s.engine === "codex"
  );

  const reasons = [];
  for (const issue of queue) {
    const repoKey = issue.repoKey;
    if (hasRunningSession(sessionsData, repoKey, issue.number)) {
      reasons.push(`#${issue.number} already has a running session`);
      continue;
    }
    const engine = engineForIssue(issue, defaultEngine);
    if (engine === "codex" && codexIsBusy) {
      reasons.push("codex slot busy");
      continue;
    }
    return { issue, engine };
  }

  return { issue: null, reasons: reasons.length ? reasons : ["no pickable issue"] };
}

// ── phone-friendly status text ──────────────────────────────────────────────────────────────

// Plain-text status block for `/auto` with no args — on/off, today's budget usage, what's
// currently running, and any questions waiting on the owner.
export function autopilotStatusText({ enabled, dispatched, dailyBudget, running, pendingQuestions } = {}) {
  const lines = [];
  lines.push(`Autopilot: ${enabled ? "ON" : "OFF"}`);
  const count = dispatched?.count || 0;
  const budget = typeof dailyBudget === "number" ? dailyBudget : "?";
  lines.push(`Dispatched today: ${count}/${budget}`);

  const runningCount = Array.isArray(running) ? running.length : (running || 0);
  if (runningCount > 0) {
    lines.push(`Running: ${runningCount}`);
  } else {
    lines.push("Running: none");
  }

  const pendingCount = Array.isArray(pendingQuestions) ? pendingQuestions.length : (pendingQuestions || 0);
  if (pendingCount > 0) {
    lines.push(`Waiting on you: ${pendingCount} question${pendingCount === 1 ? "" : "s"}`);
  }

  return lines.join("\n");
}

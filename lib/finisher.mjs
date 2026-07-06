// The finisher pipeline (CONTEXT.md "Finisher pipeline"; docs/architecture.md label vocabulary) —
// the post-implementation lane a PR travels through once an implementer session opens it.
// ✅ Merge from the phone is an INTENT ("couch-merge"), not a git command: the owner taps merge,
// and the pipeline below does whatever is actually required (resolve conflicts, get a
// cross-engine audit, wait out CI, then merge) with the owner in the loop only where a machine
// genuinely cannot decide (an audit that flags real issues).
//
// Stages, in order: "conflicts" -> "audit" -> "ci" -> "merge" -> "done" (or "parked" at any
// retry ceiling). Each failing stage gets exactly ONE retry via a session (resolve-conflicts /
// fixup); a second failure parks the issue with a plain-language reason instead of looping
// forever and burning tokens unattended.
//
// Everything here is pure (no I/O, no spawning): nextFinisherStep is a decision table the bot
// drives with real GitHub PR/check state; the apply* helpers are pure copies the bot calls after
// a session or the owner responds. See lib/gates.mjs for the sibling pure-decision-table style
// this mirrors, and lib/griller.mjs for the fenced-json prompt/parse conventions reused below.

import { lastFencedJson } from "./fenced-json.mjs";

// ── state ────────────────────────────────────────────────────────────────────────────────

// Fresh FinisherState for a PR that just opened (label transition "pr-open" -> "finishing").
// attempts is a per-stage retry counter object, populated lazily by nextFinisherStep (absent key
// reads as 0) so a freshly-started state can be deep-frozen in tests without surprises.
export function newFinisherState({ issue, repoKey, prNumber, skipAudit = false, now } = {}) {
  const startedAt = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
  return {
    issue,
    repoKey,
    prNumber,
    stage: "conflicts",
    attempts: {},
    auditVerdict: null,
    skipAudit: !!skipAudit,
    startedAt,
  };
}

// codex<->claude — the cross-engine audit always uses the OTHER engine than the one that
// implemented the PR, so the reviewer never shares blind spots with the author.
export function oppositeEngine(engine) {
  return engine === "codex" ? "claude" : "codex";
}

// ── the decision table ──────────────────────────────────────────────────────────────────────

function withAttempt(state, key) {
  return { ...state, attempts: { ...state.attempts, [key]: (state.attempts[key] || 0) + 1 } };
}

function toStage(state, stage) {
  return { ...state, stage };
}

/**
 * Pure decision table: given the current FinisherState plus fresh `pr`/`checks` observations,
 * decide the next action. NEVER mutates `state` — every branch returns a brand-new state object
 * (even branches that don't change the stage return a shallow copy, so callers can always trust
 * the returned `state` over their input). `pr.mergeable` may be true/false/null (GitHub is still
 * computing mergeability — treated as "wait", never as a conflict). `checks` is
 * `{ total, pending, failed }` counts across the PR's required checks.
 *
 * A stage "falls through" to the next stage's logic in the SAME call once its own gate clears
 * (e.g. conflicts resolved -> immediately evaluate audit) so the caller doesn't have to re-invoke
 * per stage-transition inside one poll tick.
 */
export function nextFinisherStep(state, { pr, checks } = {}) {
  let s = { ...state, attempts: { ...state.attempts } };

  if (s.stage === "conflicts") {
    if (pr?.mergeable === false) {
      if ((s.attempts.conflicts || 0) >= 1) {
        return { action: "park", reason: "merge conflicts persisted after one resolve attempt", state: s };
      }
      s = withAttempt(s, "conflicts");
      return { action: "resolve-conflicts", reason: "merge conflicts detected", state: s };
    }
    if (pr?.mergeable === null || pr?.mergeable === undefined) {
      return { action: "wait", reason: "GitHub still computing mergeability", state: s };
    }
    // mergeable === true -> fall through to audit.
    s = toStage(s, "audit");
  }

  if (s.stage === "audit") {
    if (s.skipAudit) {
      s = toStage(s, "ci");
    } else if (s.auditVerdict === null) {
      if ((s.attempts.audit || 0) >= 1) {
        return { action: "wait", reason: "waiting on the cross-engine audit session", state: s };
      }
      s = withAttempt(s, "audit");
      return { action: "audit", reason: "spawning cross-engine audit session", state: s };
    } else if (s.auditVerdict === "approve") {
      s = toStage(s, "ci");
    } else if (s.auditVerdict === "block") {
      return {
        action: "ask-owner",
        reason: `cross-engine audit flagged issues: ${s.auditNotes || "(no notes)"}`,
        state: s,
      };
    }
  }

  if (s.stage === "ci") {
    const total = checks?.total ?? 0;
    const pending = checks?.pending ?? 0;
    const failed = checks?.failed ?? 0;
    if (failed > 0) {
      if ((s.attempts.fixup || 0) >= 1) {
        return { action: "park", reason: "CI still red after one fix-up session", state: s };
      }
      s = withAttempt(s, "fixup");
      return { action: "fixup", reason: "CI has failing checks", state: s };
    }
    if (pending > 0) {
      return { action: "wait", reason: "CI running", state: s };
    }
    // total === 0 (no checks configured) counts as green; otherwise all present checks passed.
    s = toStage(s, "merge");
  }

  if (s.stage === "merge") {
    if ((s.attempts.merge || 0) >= 2) {
      return { action: "park", reason: "merge failed twice", state: s };
    }
    s = withAttempt(s, "merge");
    return { action: "merge", reason: "all gates green", state: s };
  }

  if (s.stage === "done") return { action: "done", reason: "already merged", state: s };
  if (s.stage === "parked") return { action: "park", reason: s.parkedReason || "parked", state: s };

  // Defensive: unknown stage never falls through unhandled.
  return { action: "park", reason: `unknown finisher stage "${s.stage}"`, state: s };
}

// ── pure state mutators (called after a session/owner responds) ────────────────────────────

// Record the cross-engine audit's verdict + notes. Pure copy; nextFinisherStep reads
// auditVerdict/auditNotes back on the following tick.
export function applyAuditVerdict(state, verdict) {
  // Tolerate both the parsed { verdict, notes } object and a bare verdict string —
  // the hub passed the string live (rn#293) and the audit silently never stuck.
  const v = typeof verdict === "string" ? { verdict } : verdict;
  return {
    ...state,
    auditVerdict: v?.verdict ?? null,
    auditNotes: v?.notes ?? state.auditNotes ?? null,
  };
}

// A merge attempt resolved (or didn't). merged -> stage "done"; otherwise stay on "merge" — the
// attempts.merge counter already incremented by nextFinisherStep is what gates the eventual park,
// so this mutator must NOT touch attempts itself (double-counting would park after only one
// real failure).
export function applyMergeResult(state, { merged, message } = {}) {
  if (merged) {
    return { ...state, stage: "done", mergeMessage: message ?? null };
  }
  return { ...state, mergeMessage: message ?? null };
}

// The owner's decision after an "ask-owner" audit-block escalation. proceed=true means "merge
// anyway" — skip the (already-failed) audit gate and resume at CI; proceed=false parks with a
// fixed, honest reason (never silently retries the audit).
export function applyOwnerMergeDecision(state, proceed) {
  if (proceed) {
    return { ...state, skipAudit: true, stage: "ci" };
  }
  return { ...state, stage: "parked", parkedReason: "owner declined after audit flagged issues" };
}

// Park unconditionally with an explicit reason (used by callers reacting to something outside
// the decision table itself, e.g. an unrecoverable GitHub API error).
export function parkState(state, reason) {
  return { ...state, stage: "parked", parkedReason: reason };
}

// ── session prompts (mirrors lib/griller.mjs's fenced-json prompt/parse conventions) ────────

// Cross-engine audit session prompt. `decisions` are the ratified decisions from the grilling
// ledger (so the audit can check for deviations against what was actually agreed, not just
// "looks fine to me"); `handoffNote` is the implementer's own compact summary, if any.
export function buildAuditPrompt({ issue, repoSlug, prNumber, decisions, handoffNote, offline = false, baseBranch = "main" } = {}) {
  const decisionLines = Array.isArray(decisions) && decisions.length
    ? decisions.map((d) => `- ${d}`).join("\n")
    : "_none recorded_";

  // Codex audit sessions run with network OFF (ADR-0003), so `gh pr diff` cannot work
  // there — they get the PR branch checked out in a worktree and diff locally instead.
  const diffInstruction = offline
    ? "You have NO network access — gh will not work. This worktree IS the PR branch: read the diff via " +
      "`git diff origin/" + baseBranch + "...HEAD` and the commits via `git log origin/" + baseBranch + "..HEAD`."
    : "Read the diff via `gh pr diff " + prNumber + " --repo " + repoSlug + "`.";

  const lines = [
    `You are auditing PR #${prNumber} implementing issue #${issue} in ${repoSlug}.`,
    diffInstruction,
    "",
    "Ratified decisions this PR must honor:",
    decisionLines,
    "",
  ];

  if (handoffNote) {
    lines.push("Implementer's handoff note:", handoffNote, "");
  }

  lines.push(
    "Audit for:",
    "- correctness bugs",
    "- deviations from the ratified decisions above",
    "- security issues or data loss",
    "- CI-likely failures (lint/type errors)",
    "",
    "Do NOT flag style nits — this is not a style review.",
    "",
    "END your final message with a fenced ```json block, and nothing after it, of this exact shape:",
    "```json",
    JSON.stringify({ verdict: "approve", notes: "plain-language summary for a phone screen" }, null, 2),
    "```",
    '`verdict` must be exactly "approve" or "block".'
  );

  return lines.join("\n");
}

// Parse an audit session's final message into { verdict, notes }, or null if unparseable/absent.
// verdict must be EXACTLY "approve" or "block" — anything else (typo, hostile injection, missing
// field) fails closed to null so the caller never silently treats a garbled response as approval.
// Extraction is the shared brace-balancing lib/fenced-json.mjs (fences inside payloads must not
// truncate the block — live failure rn#280).
export function parseAuditVerdict(lastText) {
  const parsed = lastFencedJson(lastText);
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.verdict !== "approve" && parsed.verdict !== "block") return null;
  return {
    verdict: parsed.verdict,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

// Fix-up session prompt: fix the failing CI checks in place on the PR branch. `failedCheckNames`
// lets the session target the actual red checks instead of guessing.
export function buildFixupPrompt({ prNumber, repoSlug, failedCheckNames } = {}) {
  const names = Array.isArray(failedCheckNames) && failedCheckNames.length
    ? failedCheckNames.join(", ")
    : "(names unavailable — inspect CI output on the PR)";

  const lines = [
    `Fix the failing CI checks on PR #${prNumber} in ${repoSlug}, in this worktree.`,
    `Failing checks: ${names}.`,
    "Run the same checks locally before finishing, so you know they pass before handing back.",
    "Commit your fix. Do NOT push — the hub pushes.",
    "",
    "END your final message with a fenced ```json block, and nothing after it, of this exact shape:",
    "```json",
    JSON.stringify({ done: true, summary: "…" }, null, 2),
    "```",
  ];
  return lines.join("\n");
}

// Conflict-resolve session prompt: merge origin/<base> into the PR branch, preserving BOTH
// intents (the base's changes and the PR's changes), never silently dropping one side.
export function buildConflictPrompt({ prNumber, baseBranch } = {}) {
  const lines = [
    `Resolve the merge conflicts on PR #${prNumber} by merging origin/${baseBranch} into the PR`,
    "branch, in this worktree.",
    "Preserve BOTH intents — the base branch's changes and this PR's changes — do not silently",
    "drop either side's work while resolving conflicts.",
    "Run the tests after merging. Commit the merge. Do NOT push — the hub pushes.",
    "",
    "END your final message with a fenced ```json block, and nothing after it, of this exact shape:",
    "```json",
    JSON.stringify({ done: true, summary: "…" }, null, 2),
    "```",
  ];
  return lines.join("\n");
}

// ── label transitions (docs/architecture.md label vocabulary) ──────────────────────────────

// Label add/remove sets for a finisher-pipeline transition. "start" is pr-open -> finishing;
// "done" drops finishing WITHOUT adding anything (the issue closes via the PR's "Closes #N",
// not a label the finisher sets itself); "parked" drops finishing and adds blocked.
export function finisherLabelTransitions(stage) {
  if (stage === "start") return { add: ["finishing"], remove: ["pr-open"] };
  if (stage === "done") return { add: [], remove: ["finishing"] };
  if (stage === "parked") return { add: ["blocked"], remove: ["finishing"] };
  return { add: [], remove: [] };
}

// ── phone-friendly status line ──────────────────────────────────────────────────────────────

// One plain-text line per finisher action, for Telegram status messages (never raw stage/action
// enum values — always a phone-readable sentence).
export function describeFinisherStep(step) {
  const reason = step?.reason ? ` — ${step.reason}` : "";
  switch (step?.action) {
    case "resolve-conflicts":
      return `Resolving merge conflicts${reason}.`;
    case "audit":
      return `Requesting a cross-engine audit${reason}.`;
    case "fixup":
      return `Kicking off a CI fix-up session${reason}.`;
    case "merge":
      return `Merging now${reason}.`;
    case "wait":
      return `Waiting${reason}.`;
    case "ask-owner":
      return `Needs your call${reason}.`;
    case "park":
      return `Parked${reason}.`;
    case "done":
      return "Done — merged.";
    default:
      return `Unknown finisher step "${step?.action}".`;
  }
}

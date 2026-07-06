// Hermes v2 ops/doctor helpers.
//
// Keep this file mostly pure: the hub and live script gather probes, then these
// helpers turn them into phone-sized English and concrete next actions.

import fs from "node:fs";

const HOUR_MS = 3600_000;

function asDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function hoursOld(value, now = new Date()) {
  const d = asDate(value);
  if (!d) return null;
  return Math.max(0, (now - d) / HOUR_MS);
}

export function activeFinisherEntries(finishers = {}) {
  return Object.entries(finishers || {})
    .filter(([, s]) => s && !["done", "parked"].includes(s.stage));
}

export function parseLaunchctlPrint(text = "") {
  const pid = String(text).match(/\bpid\s*=\s*(\d+)/)?.[1] || null;
  const state = String(text).match(/\bstate\s*=\s*(\S+)/)?.[1] || null;
  return {
    loaded: String(text).trim().length > 0,
    running: Boolean(pid) || state === "running",
    pid: pid ? Number(pid) : null,
    state,
  };
}

export function classifyLogWarnings(text = "") {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const concerning = lines.filter((line) =>
    /\b(error|failed|fatal|unhandled|exception|enoent|eaddrinuse|auth|forbidden|rate limit)\b/i.test(line)
  );
  return {
    checkedLines: lines.length,
    warningCount: concerning.length,
    lastWarning: concerning.at(-1) || "",
  };
}

function repoHealth(repoKey, repo = {}, repoProbe = {}) {
  const problems = [];
  if (!repo.path) problems.push("no local path");
  else if (repoProbe.exists === false) problems.push("path missing");
  if (!repo.slug) problems.push("no GitHub slug");
  return {
    key: repoKey,
    label: repo.label || repoKey,
    path: repo.path || "",
    slug: repo.slug || "",
    ok: problems.length === 0,
    problems,
  };
}

export function buildOpsModel(snapshot = {}, opts = {}) {
  const now = opts.now || new Date();
  const staleQuestionHours = opts.staleQuestionHours ?? snapshot.askTimeoutHours ?? 8;
  const staleSessionHours = opts.staleSessionHours ?? 12;
  const staleFinisherHours = opts.staleFinisherHours ?? 24;

  const sessions = snapshot.sessions?.sessions || [];
  const pendingQuestions = snapshot.pendingQuestions || [];
  const activeFinishers = activeFinisherEntries(snapshot.finishers);
  const repos = Object.entries(snapshot.repos || {}).map(([key, repo]) =>
    repoHealth(key, repo, snapshot.repoProbes?.[key] || {})
  );

  const running = sessions.filter((s) => s.status === "running");
  const orphaned = sessions.filter((s) => s.status === "orphaned");
  const failed = sessions.filter((s) => s.status === "failed");
  const staleQuestions = pendingQuestions.filter((q) =>
    (hoursOld(q.askedAt, now) ?? 0) >= staleQuestionHours
  );
  const staleRunning = running.filter((s) =>
    (hoursOld(s.startedAt, now) ?? 0) >= staleSessionHours
  );
  const missingWorktrees = sessions.filter((s) =>
    ["running", "orphaned"].includes(s.status) && s.worktree && snapshot.pathExists?.[s.worktree] === false
  );
  const staleFinishers = activeFinishers.filter(([, s]) =>
    (hoursOld(s.startedAt, now) ?? 0) >= staleFinisherHours
  );
  const missingFinisherWorktrees = activeFinishers.filter(([, s]) =>
    s.worktree && snapshot.pathExists?.[s.worktree] === false
  );
  const missingBranches = activeFinishers.filter(([, s]) =>
    s.branch && snapshot.branchExists?.[`${s.repoKey}:${s.branch}`] === false
  );

  const warnings = [];
  if (!snapshot.configPresent) warnings.push("config.json is missing");
  if (!snapshot.hermesEnabled) warnings.push("hermes.enabled is off");
  if (!snapshot.launchd?.running) warnings.push("launchd does not show Hermes running");
  if (snapshot.github?.ok === false) warnings.push(`GitHub auth is not reachable: ${snapshot.github.reason || "unknown"}`);
  if (snapshot.telegram?.ok === false) warnings.push(`Telegram check failed: ${snapshot.telegram.reason || "unknown"}`);
  if (snapshot.telegram?.webhookUrl) warnings.push("Telegram webhook is set; long polling may be blocked");
  if (snapshot.codex?.ok === false) warnings.push(`Codex CLI is not usable: ${snapshot.codex.reason || "missing"}`);
  for (const repo of repos.filter((r) => !r.ok)) warnings.push(`${repo.key} repo ${repo.problems.join(", ")}`);
  if (orphaned.length) warnings.push(`${orphaned.length} orphaned session${orphaned.length === 1 ? "" : "s"}`);
  if (staleQuestions.length) warnings.push(`${staleQuestions.length} old pending question${staleQuestions.length === 1 ? "" : "s"}`);
  if (staleRunning.length) warnings.push(`${staleRunning.length} long-running session${staleRunning.length === 1 ? "" : "s"}`);
  if (missingWorktrees.length) warnings.push(`${missingWorktrees.length} session worktree${missingWorktrees.length === 1 ? "" : "s"} missing`);
  if (staleFinishers.length) warnings.push(`${staleFinishers.length} stale finisher${staleFinishers.length === 1 ? "" : "s"}`);
  if (missingFinisherWorktrees.length) warnings.push(`${missingFinisherWorktrees.length} finisher worktree${missingFinisherWorktrees.length === 1 ? "" : "s"} missing`);
  if (missingBranches.length) warnings.push(`${missingBranches.length} PR branch${missingBranches.length === 1 ? "" : "es"} missing locally`);
  if (snapshot.logs?.warningCount > 0) warnings.push(`recent log warnings: ${snapshot.logs.lastWarning.slice(0, 120)}`);

  const actions = [];
  if (!snapshot.launchd?.running) actions.push("Run npm run live:restart from the live checkout.");
  if (snapshot.telegram?.webhookUrl) actions.push("Run npm run check or npm run live:restart to clear the webhook.");
  if (snapshot.github?.ok === false) actions.push("Run gh auth status on the live machine.");
  if (staleQuestions.length) actions.push("Answer the pinned inbox cards, or run /ops refresh after deciding they are stale.");
  for (const s of orphaned.slice(0, 3)) actions.push(`Resume ${s.id}: /ops resume ${s.id}`);
  for (const [key] of staleFinishers.slice(0, 3)) actions.push(`Nudge finisher ${key}: /ops retry ${key}; park safely with /ops park ${key} <reason>.`);
  if (missingWorktrees.length || missingFinisherWorktrees.length || missingBranches.length) {
    actions.push("Missing worktrees/branches need manual repo repair before retrying.");
  }
  if (!actions.length && warnings.length) actions.push("Run /ops refresh once; if this repeats, inspect logs/hermes.err.log.");
  if (!actions.length) actions.push("No ops action needed. Use /status for shipping work.");

  let next = actions[0];
  if (!warnings.length) next = "No ops action needed. Use /status for shipping work.";

  return {
    now,
    repos,
    running,
    orphaned,
    failed,
    pendingQuestions,
    staleQuestions,
    staleRunning,
    activeFinishers,
    staleFinishers,
    missingWorktrees,
    missingFinisherWorktrees,
    missingBranches,
    warnings,
    actions,
    next,
  };
}

function sessionLine(s) {
  const bits = [`${s.id}`, `${s.repoKey}#${s.issue}`, `${s.role}/${s.engine}`, s.status];
  if (s.pid) bits.push(`pid ${s.pid}`);
  return bits.filter(Boolean).join(" ");
}

export function renderOpsReport(snapshot = {}, opts = {}) {
  const model = buildOpsModel(snapshot, opts);
  const sha = snapshot.git?.sha ? snapshot.git.sha.slice(0, 12) : "unknown";
  const launchd = snapshot.launchd?.running
    ? `running${snapshot.launchd.pid ? ` pid ${snapshot.launchd.pid}` : ""}`
    : "not running";
  const repos = model.repos.length
    ? model.repos.map((r) => `${r.key}=${r.slug || "no slug"}${r.ok ? "" : ` (${r.problems.join(", ")})`}`).join("; ")
    : "none enabled";
  const webhook = snapshot.telegram?.webhookUrl ? "webhook set" : "long polling OK";

  const lines = [
    "Hermes ops doctor",
    `Next: ${model.next}`,
    `Bot: ${sha}; launchd ${launchd}`,
    `Repos: ${repos}`,
    `GitHub: ${snapshot.github?.ok ? "reachable" : `check failed${snapshot.github?.reason ? ` (${snapshot.github.reason})` : ""}`}`,
    `Telegram: ${snapshot.telegram?.ok ? webhook : `check failed${snapshot.telegram?.reason ? ` (${snapshot.telegram.reason})` : ""}`}`,
    `Codex: ${snapshot.codex?.ok ? (snapshot.codex.version || "present") : `missing${snapshot.codex?.reason ? ` (${snapshot.codex.reason})` : ""}`}`,
    `State: ${model.running.length} running, ${model.pendingQuestions.length} pending question${model.pendingQuestions.length === 1 ? "" : "s"}, ${model.activeFinishers.length} active finisher${model.activeFinishers.length === 1 ? "" : "s"}`,
  ];

  if (model.orphaned.length) lines.push(`Orphaned: ${model.orphaned.slice(0, 3).map(sessionLine).join("; ")}`);
  if (model.staleQuestions.length) {
    lines.push(`Old questions: ${model.staleQuestions.slice(0, 3).map((q) => `${q.repoKey}#${q.issue} ${q.id}`).join("; ")}`);
  }
  if (model.staleRunning.length) lines.push(`Long-running: ${model.staleRunning.slice(0, 3).map(sessionLine).join("; ")}`);
  if (model.activeFinishers.length) {
    lines.push(`Finishers: ${model.activeFinishers.slice(0, 4).map(([key, s]) => `${key} ${s.stage}${s.prNumber ? ` PR #${s.prNumber}` : ""}`).join("; ")}`);
  }
  if (model.missingWorktrees.length || model.missingFinisherWorktrees.length) {
    const missing = [
      ...model.missingWorktrees.map((s) => `${s.id}: ${s.worktree}`),
      ...model.missingFinisherWorktrees.map(([key, s]) => `${key}: ${s.worktree}`),
    ];
    lines.push(`Missing worktrees: ${missing.slice(0, 3).join("; ")}`);
  }
  if (model.missingBranches.length) {
    lines.push(`Missing branches: ${model.missingBranches.slice(0, 3).map(([key, s]) => `${key}: ${s.branch}`).join("; ")}`);
  }
  if (snapshot.logs?.warningCount > 0) lines.push(`Logs: ${snapshot.logs.warningCount} warning line(s); last: ${snapshot.logs.lastWarning.slice(0, 160)}`);
  if (model.warnings.length) lines.push(`Warnings: ${model.warnings.slice(0, 6).join("; ")}`);
  lines.push(`Actions: ${model.actions.slice(0, 4).join(" | ")}`);
  lines.push("Use /status for work queue; /ops is only appliance health.");
  return lines.join("\n");
}

export function readLogWarnings(file, { maxBytes = 20000 } = {}) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return classifyLogWarnings(buf.toString("utf8"));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { checkedLines: 0, warningCount: 0, lastWarning: "" };
  }
}

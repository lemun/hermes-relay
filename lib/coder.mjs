// Coding-mode engine — runs a REAL write-enabled Claude Code session in an allowlisted
// repo, isolated in a fresh git worktree on a phone/* branch. This is the deliberate
// escalation from the read-only concierge: full tools + bypassPermissions, so it MUST
// stay worktree-isolated and never touch the repo's main checkout or uncommitted work.
//
// One job at a time (singleton). The job is a detached child of the bot, NOT awaited on
// the Telegram loop, so polling stays responsive while it runs. Progress is
// streamed via stream-json; on completion we auto-commit to the task branch, summarize the
// diff, and hand structured results back to the caller over Telegram.

import { spawn } from "node:child_process";
import fs, { existsSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ROOT, loadPrefs, savePrefs } from "./runtime.mjs";
import { buildChildSessionEnv } from "./engines.mjs";
import { MODELS, EFFORTS } from "./models.mjs";
import { exec as sh } from "./proc.mjs";
import { ensurePrivateDirectory, openPrivateFileForAppend } from "./private-storage.mjs";

export { EFFORTS }; // re-exported so hermes-bot + coder.test keep importing it from here

const PROGRESS_THROTTLE_MS = 25000; // at most ~1 status edit / 25s, to dodge Telegram rate limits
const AUDIT_LOG = path.join(ROOT, "logs", "coder.log");

// The single in-flight job, or null. Holds the live child so /stop can kill it.
let active = null;

// ── git / shell helpers ──────────────────────────────────────────────────────
const git = (cwd, ...args) => sh("git", ["-C", cwd, ...args]);
async function gitOut(cwd, ...args) {
  const r = await git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} -> ${r.stderr.trim() || r.code}`);
  return r.stdout.trim();
}

// Pure summary of a finished job, separated from the git/IO in finalize() so the ok-flag truth
// table and file-counting are unit-tested. `ok` is true only on a clean, uninterrupted exit.
export function finalizeResult({ exitCode, isError, canceled, timedOut, baseSha, headSha, diffNames }) {
  const changed = !!(baseSha && headSha && headSha !== baseSha);
  const filesChanged = changed && diffNames ? diffNames.split("\n").filter(Boolean).length : 0;
  return {
    ok: exitCode === 0 && !isError && !canceled && !timedOut,
    changed,
    filesChanged,
  };
}

// Build the `claude` argv for a coding session. Pure (no side effects) so it's unit-tested.
// A fresh run uses --session-id; a resume uses --resume on the prior session.
export function buildSessionArgs({ prompt, modelId, effort, worktreePath, sessionId, resume }) {
  const args = [
    "-p", prompt,
    "--model", modelId,
    "--effort", effort,
    "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
    "--add-dir", worktreePath,
    "--output-format", "stream-json",
    "--verbose",
  ];
  if (resume) args.push("--resume", sessionId);
  else args.push("--session-id", sessionId);
  return args;
}

function shortPath(p) {
  if (!p) return "";
  const parts = String(p).split("/");
  return parts.slice(-2).join("/");
}

// One-line milestone for a tool_use event in the stream.
function toolMilestone(tu) {
  const n = tu.name || "tool";
  const i = tu.input || {};
  if (n === "Bash") return `🖥 ${(i.command || "").replace(/\s+/g, " ").slice(0, 60)}`;
  if (["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"].includes(n)) return `🔧 ${n} ${shortPath(i.file_path || i.notebook_path || "")}`;
  if (n === "Grep" || n === "Glob") return `🔎 ${n} ${(i.pattern || i.query || "").slice(0, 40)}`;
  if (n === "Task") return `🤖 ${(i.description || "subagent").slice(0, 50)}`;
  if (n === "TodoWrite") return "📝 planning";
  if (n.startsWith("mcp__")) return `🔌 ${n.replace(/^mcp__/, "")}`;
  return `🔧 ${n}`;
}

export function buildLegacyChildEnv(parentEnv) {
  return buildChildSessionEnv(parentEnv);
}

export function buildPromptAuditMetadata(prompt) {
  const text = String(prompt ?? "");
  return {
    promptBytes: Buffer.byteLength(text, "utf8"),
  };
}

export function buildStartAuditRecord(j) {
  return {
    event: "start",
    id: j.sessionId,
    repo: j.repoKey,
    model: j.model,
    effort: j.effort,
    resume: !!j.resume,
    ...buildPromptAuditMetadata(j.prompt),
  };
}

export function writeAuditLine(logPath, obj, { fsImpl = fs } = {}) {
  const dir = path.dirname(logPath);
  ensurePrivateDirectory(dir, { fsImpl });
  const fd = openPrivateFileForAppend(logPath, { fsImpl });
  try {
    const safe = { ...obj };
    delete safe.prompt;
    delete safe.branch;
    fsImpl.writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...safe }) + "\n");
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

function auditLine(obj) {
  writeAuditLine(AUDIT_LOG, obj);
}

// ── public surface ───────────────────────────────────────────────────────────

export function codingStatus() {
  if (!active) return { running: false };
  return {
    running: true, id: active.id, repoKey: active.repoKey, repoLabel: active.repoLabel,
    branch: active.branch, worktreePath: active.worktreePath, model: active.model,
    effort: active.effort, elapsedMs: Date.now() - active.startedAt,
    stepCount: active.stepCount, lastStep: active.lastStep,
  };
}

// Validate the configured repos at startup (when coding is enabled). Throws on the first
// repo whose path is missing or is not a git work tree, so startup can fail loud.
export async function assertCodingConfig(cfg) {
  const repos = cfg.coding?.repos || {};
  const keys = Object.keys(repos);
  if (!keys.length) throw new Error("coding.enabled is true but coding.repos is empty");
  if (!existsSync(cfg.coding.worktreeBase)) throw new Error(`coding.worktreeBase does not exist: ${cfg.coding.worktreeBase}`);
  for (const k of keys) {
    const p = repos[k]?.path;
    if (!p || !existsSync(p)) throw new Error(`coding.repos.${k}.path missing or not found: ${p}`);
    const r = await git(p, "rev-parse", "--is-inside-work-tree");
    if (r.code !== 0 || r.stdout.trim() !== "true") throw new Error(`coding.repos.${k}.path is not a git work tree: ${p}`);
  }
}

// The last finished coding session's breadcrumb ({sessionId, branch, worktreePath, …}), or null.
// Single accessor so callers don't reach into the prefs blob directly.
export function lastCodingSession() {
  return loadPrefs().coding?.last || null;
}

// If a job's bookkeeping survived a bot restart, the child is dead (it was our child).
// Running-child breadcrumbs are returned and cleared for the existing interrupted-job
// notice. A finalization_pending breadcrumb is durable recovery work: never delete it
// until its guarded commit + completion persistence succeeds after a local unlock.
export function reapStaleActive({ loadPrefsImpl = loadPrefs, savePrefsImpl = savePrefs } = {}) {
  const prefs = loadPrefsImpl();
  const stale = prefs.coding?.active;
  if (!stale) return null;
  if (stale.phase === "finalization_pending") return stale;
  prefs.coding = prefs.coding || {};
  delete prefs.coding.active;
  savePrefsImpl(prefs);
  return stale;
}

// Kill the running job (SIGTERM, then SIGKILL after 5s). The child's "close" handler still
// fires and finalizes (commit + summary of partial work). No-op if nothing is running.
export function stopCodingJob() {
  if (!active?.child || active.finalizing) return false; // nothing to interrupt once the child has exited
  active.canceled = true;
  const child = active.child; // capture THIS child — a late SIGKILL must never hit a later job
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  active.killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 5000);
  return true;
}

// Start a new coding job. Resolves once the worktree exists and the child is spawned
// (returns the job descriptor); completion is delivered later via onDone. Throws if a job
// is already running, the repo is unknown, or worktree creation fails.
export async function startCodingJob({
  repoKey, model, effort, prompt, onProgress, onDone,
  authorizeRuntimeAction, authorizeCurrentRuntimeAction,
}, cfg) {
  if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.spawn") !== true) throw new Error("runtime security policy denied coding spawn");
  if (active) throw new Error("a coding job is already running");
  const repo = cfg.coding?.repos?.[repoKey];
  if (!repo) throw new Error(`unknown repo "${repoKey}"`);
  if (!EFFORTS.includes(effort)) effort = cfg.coding.defaultEffort;
  const modelId = MODELS[model] || MODELS[cfg.coding.defaultModel] || MODELS.sonnet;

  const shortid = randomUUID().slice(0, 8);
  const branch = `phone/session-${shortid}`;
  const worktreePath = path.join(cfg.coding.worktreeBase, `hermes-wt-phone-${shortid}`);

  // Create the isolated worktree + branch off the repo's current HEAD.
  const add = await git(repo.path, "worktree", "add", worktreePath, "-b", branch);
  if (add.code !== 0) throw new Error(`worktree add failed: ${add.stderr.trim() || add.code}`);
  const baseSha = await gitOut(worktreePath, "rev-parse", "HEAD").catch(() => "");

  const sessionId = randomUUID();
  spawnSession({ cfg, modelId, model, effort, prompt, worktreePath, branch, baseSha, sessionId,
    repoKey, repoLabel: repo.label || repoKey, onProgress, onDone, resume: false,
    authorizeRuntimeAction, authorizeCurrentRuntimeAction });

  return { id: sessionId, branch, worktreePath, repoLabel: repo.label || repoKey, model, effort };
}

// Resume the last coding session in its existing worktree (the "/code again" / iterate path).
export async function resumeCodingJob({
  prompt, onProgress, onDone, authorizeRuntimeAction, authorizeCurrentRuntimeAction,
  expectedSessionId, expectedBranch,
}, cfg) {
  if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.spawn") !== true) throw new Error("runtime security policy denied coding resume");
  if (active) throw new Error("a coding job is already running");
  const last = loadPrefs().coding?.last;
  if (!last?.sessionId || !last?.worktreePath) throw new Error("no previous coding session to resume");
  if (!existsSync(last.worktreePath)) throw new Error(`previous worktree is gone: ${last.worktreePath}`);
  if ((expectedSessionId && last.sessionId !== expectedSessionId) || (expectedBranch && last.branch !== expectedBranch)) {
    throw new Error("coding result changed; use the current result card");
  }
  const modelId = MODELS[last.model] || MODELS.sonnet;
  const baseSha = await gitOut(last.worktreePath, "rev-parse", "HEAD").catch(() => "");
  spawnSession({ cfg, modelId, model: last.model, effort: last.effort, prompt,
    worktreePath: last.worktreePath, branch: last.branch, baseSha, sessionId: last.sessionId,
    repoKey: last.repoKey, repoLabel: last.repoLabel || last.repoKey, onProgress, onDone, resume: true,
    authorizeRuntimeAction, authorizeCurrentRuntimeAction });
  return { id: last.sessionId, branch: last.branch, worktreePath: last.worktreePath, repoLabel: last.repoLabel, model: last.model, effort: last.effort };
}

// Push the last job's branch and open a PR (the one-tap "push & open PR" button). Returns
// { pushed, prUrl, note }. Degrades gracefully if `gh` is missing/unauthenticated.
export async function pushCodingResult({ expectedSessionId, expectedBranch, expectedHeadSha, authorizeRuntimeAction } = {}) {
  const last = loadPrefs().coding?.last;
  if (!last?.worktreePath || !last?.branch) throw new Error("no coding result to push");
  if (!existsSync(last.worktreePath)) throw new Error("the worktree for the last result is gone");
  if ((expectedSessionId && last.sessionId !== expectedSessionId)
    || (expectedBranch && last.branch !== expectedBranch)
    || !expectedHeadSha
    || !last.headSha
    || last.headSha !== expectedHeadSha) {
    throw new Error("coding result changed; use the current result card");
  }
  if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.mutate") !== true) throw new Error("runtime security policy denied coding push");
  const liveHeadSha = await gitOut(last.worktreePath, "rev-parse", "HEAD");
  if (liveHeadSha !== expectedHeadSha) throw new Error("coding result changed; use the current result card");
  const push = await git(last.worktreePath, "push", "-u", "origin", `${expectedHeadSha}:refs/heads/${last.branch}`);
  if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim().slice(0, 200)}`);
  if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.mutate") !== true) throw new Error("runtime security policy denied PR creation");
  const pr = await sh("gh", ["pr", "create", "--fill", "--head", last.branch], { cwd: last.worktreePath });
  if (pr.code !== 0) {
    return { pushed: true, prUrl: null, note: `Pushed ${last.branch}. PR not opened (${(pr.stderr || "gh unavailable").trim().slice(0, 160)}). Open it manually.` };
  }
  const prUrl = (pr.stdout.match(/https?:\/\/\S+/) || [])[0] || pr.stdout.trim();
  return { pushed: true, prUrl, note: null };
}

// Bound the worktree leak: prune git's stale metadata and remove our phone-coding worktrees
// older than the retention window — EXCEPT the most recent one (kept so /code again can resume).
// Removal only reclaims disk: the commits live on the phone/* branch, which survives. Uses plain
// `worktree remove` (no --force) so a worktree with stray uncommitted work is skipped, never
// discarded. Best-effort; never throws. Returns the count removed.
export async function reapOldWorktrees(cfg, {
  assertFresh = () => {},
  gitImpl = git,
  now = Date.now,
} = {}) {
  const base = cfg.coding?.worktreeBase;
  const repos = cfg.coding?.repos || {};
  if (!base) return 0;
  // Compare canonical paths (realpath) so a symlinked base like /tmp→/private/tmp still matches.
  let baseReal; try { baseReal = realpathSync(base); } catch { baseReal = base; }
  const keepBase = path.basename(lastCodingSession()?.worktreePath || ""); // unique id → safe to match by name
  const cutoff = Number(now()) - (cfg.coding.worktreeRetentionDays || 7) * 86_400_000;
  let removed = 0;
  for (const k of Object.keys(repos)) {
    const repoPath = repos[k]?.path;
    if (!repoPath) continue;
    assertFresh("hub.runtime.mutate");
    await gitImpl(repoPath, "worktree", "prune");
    const list = (await gitImpl(repoPath, "worktree", "list", "--porcelain")).stdout;
    for (const block of list.split("\n\n")) {
      const m = block.match(/^worktree (.+)$/m);
      if (!m) continue;
      const wt = m[1];
      const name = path.basename(wt);
      if (!name.startsWith("hermes-wt-phone-") || name === keepBase) continue; // ours, and not the kept one
      let parentReal; try { parentReal = realpathSync(path.dirname(wt)); } catch { continue; }
      if (parentReal !== baseReal) continue; // only sweep worktrees under the configured base
      let mtimeMs = 0;
      try { mtimeMs = statSync(wt).mtimeMs; } catch { continue; }
      if (mtimeMs > cutoff) continue;
      assertFresh("hub.runtime.mutate");
      const r = await gitImpl(repoPath, "worktree", "remove", wt);
      if (r.code === 0) removed++;
    }
  }
  return removed;
}

// ── internals ────────────────────────────────────────────────────────────────

export function buildActiveCodingState(j, child, startedAt) {
  return {
    id: j.sessionId, child, repoKey: j.repoKey, repoLabel: j.repoLabel,
    worktreePath: j.worktreePath, branch: j.branch, baseSha: j.baseSha, sessionId: j.sessionId,
    model: j.model, effort: j.effort, startedAt, lastPingAt: 0,
    stepCount: 0, lastStep: "starting…", resultText: "", canceled: false, timedOut: false,
    onProgress: j.onProgress, onDone: j.onDone, cfg: j.cfg,
    authorizeRuntimeAction: j.authorizeRuntimeAction,
    authorizeCurrentRuntimeAction: j.authorizeCurrentRuntimeAction,
  };
}

function spawnSession(j) {
  // Preserve Claude's subscription/runtime state while stripping bot, service, and
  // metered API credentials using the same policy as Hermes v2 engine children.
  const env = buildLegacyChildEnv(process.env);

  const args = buildSessionArgs({ prompt: j.prompt, modelId: j.modelId, effort: j.effort, worktreePath: j.worktreePath, sessionId: j.sessionId, resume: j.resume });
  // A host-capable child must never start without both its durable audit record
  // and restart breadcrumb. Persist both before spawn.
  auditLine(buildStartAuditRecord(j));
  const startedAt = Date.now();
  const prefs = loadPrefs();
  prefs.coding = prefs.coding || {};
  prefs.coding.active = {
    id: j.sessionId,
    sessionId: j.sessionId,
    repoKey: j.repoKey,
    repoLabel: j.repoLabel,
    branch: j.branch,
    worktreePath: j.worktreePath,
    baseSha: j.baseSha,
    model: j.model,
    effort: j.effort,
    startedAt,
    phase: "running",
  };
  savePrefs(prefs);

  if (j.authorizeRuntimeAction && j.authorizeRuntimeAction("hub.runtime.spawn") !== true) {
    const current = loadPrefs();
    if (current.coding?.active?.id === j.sessionId) {
      delete current.coding.active;
      savePrefs(current);
    }
    throw new Error("runtime security policy denied coding spawn");
  }

  const child = spawn(j.cfg.claudeBin || "claude", args, { cwd: j.worktreePath, env });

  active = buildActiveCodingState(j, child, startedAt);

  const timer = setTimeout(() => { active.timedOut = true; stopCodingJob(); }, j.cfg.coding.jobTimeoutMs);

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (line.trim()) handleEvent(line);
    }
    if (buf.length > 8 * 1024 * 1024) buf = ""; // drop a pathologically long unterminated line
  });
  child.stderr.on("data", () => { /* stderr is mostly progress noise; ignore */ });

  const onExit = () => { clearTimeout(timer); if (active?.killTimer) { clearTimeout(active.killTimer); active.killTimer = null; } };
  child.on("close", (code) => { onExit(); finalize(code).catch(() => {}); });
  child.on("error", (err) => { onExit(); if (active) active.spawnError = err.message; finalize(1).catch(() => {}); });
}

function handleEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; } // tolerate non-JSON noise
  if (ev.type === "assistant" && ev.message?.content) {
    for (const c of ev.message.content) {
      if (c.type === "tool_use") {
        active.stepCount++;
        active.lastStep = toolMilestone(c);
      } else if (c.type === "text" && c.text) {
        active.resultText = c.text; // rolling last assistant text (fallback summary)
      }
    }
    maybePing();
  } else if (ev.type === "result") {
    if (typeof ev.result === "string" && ev.result.trim()) active.resultText = ev.result.trim();
    active.isError = !!ev.is_error;
  }
}

function maybePing() {
  const now = Date.now();
  if (now - active.lastPingAt < PROGRESS_THROTTLE_MS) return;
  active.lastPingAt = now;
  try {
    active.onProgress?.({ stepCount: active.stepCount, lastStep: active.lastStep, elapsedMs: now - active.startedAt });
  } catch { /* ignore */ }
}

export async function commitCodingChanges({
  worktreePath,
  sessionId,
  model,
  effort,
  authorizeRuntimeAction,
  authorizeCurrentRuntimeAction,
  gitImpl = git,
}) {
  // A contextual Telegram authorizer is intentionally insufficient here: its
  // AsyncLocalStorage generation may be stale forever after lock/unlock. If a
  // guarded caller omitted the fresh local-unlock authorizer, fail closed.
  const authorize = authorizeCurrentRuntimeAction
    || (authorizeRuntimeAction ? () => false : null);
  const allowed = () => !authorize || authorize("hub.runtime.mutate") === true;
  if (!allowed()) {
    return { committed: false, securityError: "lockdown blocked coding finalization before staging" };
  }
  await gitImpl(worktreePath, "add", "-A");
  const dirty = await gitImpl(worktreePath, "status", "--porcelain");
  if (!dirty.stdout.trim()) return { committed: false };
  if (!allowed()) {
    return { committed: false, securityError: "lockdown blocked coding finalization before commit" };
  }
  const title = `Hermes coding session ${sessionId.slice(0, 8)}`;
  const commit = await gitImpl(
    worktreePath,
    "commit",
    "-m",
    title,
    "-m",
    `via Hermes phone coding session (model=${model}, effort=${effort})`,
  );
  return { committed: commit.code === 0 };
}

export function durableFinalizationRecord(j, exitCode) {
  return {
    id: j.sessionId,
    sessionId: j.sessionId,
    repoKey: j.repoKey,
    repoLabel: j.repoLabel,
    branch: j.branch,
    worktreePath: j.worktreePath,
    baseSha: j.baseSha,
    model: j.model,
    effort: j.effort,
    startedAt: j.startedAt,
    phase: "finalization_pending",
    exitCode,
    canceled: j.canceled === true,
    timedOut: j.timedOut === true,
    isError: j.isError === true,
    ...(j.spawnError ? { spawnError: j.spawnError } : {}),
  };
}

function persistFinalizationPending(j, exitCode, { loadPrefsImpl, savePrefsImpl }) {
  const prefs = loadPrefsImpl();
  prefs.coding = prefs.coding || {};
  prefs.coding.active = durableFinalizationRecord(j, exitCode);
  savePrefsImpl(prefs);
}

async function gitOutput(gitImpl, cwd, ...args) {
  const result = await gitImpl(cwd, ...args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return String(result.stdout || "").trim();
}

/**
 * Complete one exited legacy coding job. The pending phase is persisted before
 * any git mutation, and it is only cleared after a fresh local-unlock authorizer
 * permits both commit boundaries and the final prefs mutation.
 */
export async function runCodingFinalization(j, exitCode, {
  gitImpl = git,
  loadPrefsImpl = loadPrefs,
  savePrefsImpl = savePrefs,
  auditLineImpl = auditLine,
  clock = Date.now,
} = {}) {
  persistFinalizationPending(j, exitCode, { loadPrefsImpl, savePrefsImpl });

  const commitResult = await commitCodingChanges({ ...j, gitImpl });
  if (commitResult.securityError) return { deferred: true, reason: commitResult.securityError };
  const committed = commitResult.committed;

  let diffStat = "", diffNames = "", headSha = "";
  try {
    headSha = await gitOutput(gitImpl, j.worktreePath, "rev-parse", "HEAD");
    if (j.baseSha && headSha !== j.baseSha) {
      diffStat = (await gitImpl(j.worktreePath, "diff", "--stat", `${j.baseSha}..HEAD`)).stdout.trim();
      diffNames = (await gitImpl(j.worktreePath, "diff", "--name-only", `${j.baseSha}..HEAD`)).stdout.trim();
    }
  } catch { /* leave summary fields empty; the durable breadcrumb still survives */ }

  const authorize = j.authorizeCurrentRuntimeAction
    || (j.authorizeRuntimeAction ? () => false : null);
  if (authorize && authorize("hub.runtime.mutate") !== true) {
    return { deferred: true, reason: "lockdown blocked coding finalization before completion persistence" };
  }

  const { ok, filesChanged } = finalizeResult({
    exitCode, isError: j.isError, canceled: j.canceled, timedOut: j.timedOut,
    baseSha: j.baseSha, headSha, diffNames,
  });
  const result = {
    ok, exitCode, canceled: j.canceled === true, timedOut: j.timedOut === true, spawnError: j.spawnError,
    resultText: j.resultText || "(no final message)",
    repoKey: j.repoKey, repoLabel: j.repoLabel, branch: j.branch, worktreePath: j.worktreePath,
    model: j.model, effort: j.effort, baseSha: j.baseSha, headSha,
    diffStat, filesChanged, committed, durationMs: Number(clock()) - Number(j.startedAt || 0),
  };

  const prefs = loadPrefsImpl();
  // A newer coding job must never be overwritten by a late recovery callback.
  if (prefs.coding?.active?.sessionId && prefs.coding.active.sessionId !== j.sessionId) {
    return { deferred: true, reason: "coding finalization breadcrumb changed" };
  }
  prefs.coding = prefs.coding || {};
  prefs.coding.last = {
    sessionId: j.sessionId,
    repoKey: j.repoKey,
    repoLabel: j.repoLabel,
    worktreePath: j.worktreePath,
    branch: j.branch,
    headSha,
    model: j.model,
    effort: j.effort,
  };
  delete prefs.coding.active;
  try {
    savePrefsImpl(prefs);
  } catch {
    return { deferred: true, reason: "coding completion state could not be persisted" };
  }

  try {
    auditLineImpl({ event: "done", id: j.sessionId, repo: j.repoKey, exitCode, canceled: j.canceled, timedOut: j.timedOut, filesChanged });
  } catch {
    result.ok = false;
    result.auditError = "completion audit could not be persisted";
  }
  return { deferred: false, result };
}

export async function recoverPendingCodingFinalization({
  authorizeCurrentRuntimeAction,
  loadPrefsImpl = loadPrefs,
  savePrefsImpl = savePrefs,
  gitImpl = git,
  auditLineImpl = auditLine,
  clock = Date.now,
} = {}) {
  const pending = loadPrefsImpl().coding?.active;
  if (!pending || pending.phase !== "finalization_pending") return { recovered: false };
  if (typeof authorizeCurrentRuntimeAction !== "function") {
    return { recovered: false, deferred: true, reason: "fresh local-unlock authorization is unavailable" };
  }
  const outcome = await runCodingFinalization({
    ...pending,
    authorizeCurrentRuntimeAction,
  }, pending.exitCode, { gitImpl, loadPrefsImpl, savePrefsImpl, auditLineImpl, clock });
  return outcome.deferred
    ? { recovered: false, deferred: true, reason: outcome.reason }
    : { recovered: true, result: outcome.result };
}

function scheduleFinalizationRetry(j, exitCode) {
  j.finalizing = false;
  j.lastStep = "waiting for local unlock before finalization…";
  j.finalizeRetryTimer = setTimeout(() => {
    j.finalizeRetryTimer = null;
    finalize(exitCode).catch(() => {});
  }, 1000);
}

async function finalize(exitCode) {
  const j = active;
  // A failed spawn fires both error and close. Keep the slot occupied until the
  // durable, guarded finalization succeeds or is explicitly deferred.
  if (!j || j.finalizing) return;
  j.finalizing = true;
  j.lastStep = "finalizing…";

  let outcome;
  try {
    outcome = await runCodingFinalization(j, exitCode);
  } catch {
    scheduleFinalizationRetry(j, exitCode);
    return;
  }
  if (outcome.deferred) {
    scheduleFinalizationRetry(j, exitCode);
    return;
  }

  active = null;
  try { await j.onDone?.(outcome.result); } catch { /* ignore */ }
}

// Coding-mode engine — runs a REAL write-enabled Claude Code session in an allowlisted
// repo, isolated in a fresh git worktree on a phone/* branch. This is the deliberate
// escalation from the read-only concierge: full tools + bypassPermissions, so it MUST
// stay worktree-isolated and never touch the repo's main checkout or uncommitted work.
//
// One job at a time (singleton). The job is a detached child of the bot, NOT awaited on
// the Telegram loop, so the concierge/notifier stay responsive while it runs. Progress is
// streamed via stream-json; on completion we auto-commit to the task branch, summarize the
// diff, and hand structured results back to the caller (which texts + ntfy-pushes them).

import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ROOT, loadPrefs, savePrefs } from "./paperclip.mjs";
import { buildChildSessionEnv } from "./engines.mjs";
import { MODELS, EFFORTS } from "./models.mjs";
import { exec as sh } from "./proc.mjs";

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

export function slugify(s) {
  return (s || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "task";
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
    promptSha256: createHash("sha256").update(text, "utf8").digest("hex"),
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

export function writeAuditLine(logPath, obj) {
  const dir = path.dirname(logPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const fd = openSync(logPath, "a", 0o600);
  try {
    fchmodSync(fd, 0o600);
    const safe = { ...obj };
    delete safe.prompt;
    delete safe.branch; // legacy branch names contain a slug derived from the prompt
    writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...safe }) + "\n");
  } finally {
    closeSync(fd);
  }
}

function auditLine(obj) {
  try {
    writeAuditLine(AUDIT_LOG, obj);
  } catch { /* best-effort */ }
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
// Return the stale record (for a user-facing "interrupted" note) and clear it.
export function reapStaleActive() {
  const prefs = loadPrefs();
  const stale = prefs.coding?.active;
  if (!stale) return null;
  prefs.coding = prefs.coding || {};
  delete prefs.coding.active;
  savePrefs(prefs);
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
export async function startCodingJob({ repoKey, model, effort, prompt, onProgress, onDone }, cfg) {
  if (active) throw new Error("a coding job is already running");
  const repo = cfg.coding?.repos?.[repoKey];
  if (!repo) throw new Error(`unknown repo "${repoKey}"`);
  if (!EFFORTS.includes(effort)) effort = cfg.coding.defaultEffort;
  const modelId = MODELS[model] || MODELS[cfg.coding.defaultModel] || MODELS.sonnet;

  const shortid = randomUUID().slice(0, 8);
  const branch = `phone/${slugify(prompt)}-${shortid}`;
  const worktreePath = path.join(cfg.coding.worktreeBase, `hermes-wt-phone-${shortid}`);

  // Create the isolated worktree + branch off the repo's current HEAD.
  const add = await git(repo.path, "worktree", "add", worktreePath, "-b", branch);
  if (add.code !== 0) throw new Error(`worktree add failed: ${add.stderr.trim() || add.code}`);
  const baseSha = await gitOut(worktreePath, "rev-parse", "HEAD").catch(() => "");

  const sessionId = randomUUID();
  spawnSession({ cfg, modelId, model, effort, prompt, worktreePath, branch, baseSha, sessionId,
    repoKey, repoLabel: repo.label || repoKey, onProgress, onDone, resume: false });

  return { id: sessionId, branch, worktreePath, repoLabel: repo.label || repoKey, model, effort };
}

// Resume the last coding session in its existing worktree (the "/code again" / iterate path).
export async function resumeCodingJob({ prompt, onProgress, onDone }, cfg) {
  if (active) throw new Error("a coding job is already running");
  const last = loadPrefs().coding?.last;
  if (!last?.sessionId || !last?.worktreePath) throw new Error("no previous coding session to resume");
  if (!existsSync(last.worktreePath)) throw new Error(`previous worktree is gone: ${last.worktreePath}`);
  const modelId = MODELS[last.model] || MODELS.sonnet;
  const baseSha = await gitOut(last.worktreePath, "rev-parse", "HEAD").catch(() => "");
  spawnSession({ cfg, modelId, model: last.model, effort: last.effort, prompt,
    worktreePath: last.worktreePath, branch: last.branch, baseSha, sessionId: last.sessionId,
    repoKey: last.repoKey, repoLabel: last.repoLabel || last.repoKey, onProgress, onDone, resume: true });
  return { id: last.sessionId, branch: last.branch, worktreePath: last.worktreePath, repoLabel: last.repoLabel, model: last.model, effort: last.effort };
}

// Push the last job's branch and open a PR (the one-tap "push & open PR" button). Returns
// { pushed, prUrl, note }. Degrades gracefully if `gh` is missing/unauthenticated.
export async function pushCodingResult() {
  const last = loadPrefs().coding?.last;
  if (!last?.worktreePath || !last?.branch) throw new Error("no coding result to push");
  if (!existsSync(last.worktreePath)) throw new Error("the worktree for the last result is gone");
  const push = await git(last.worktreePath, "push", "-u", "origin", last.branch);
  if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim().slice(0, 200)}`);
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
export async function reapOldWorktrees(cfg) {
  const base = cfg.coding?.worktreeBase;
  const repos = cfg.coding?.repos || {};
  if (!base) return 0;
  // Compare canonical paths (realpath) so a symlinked base like /tmp→/private/tmp still matches.
  let baseReal; try { baseReal = realpathSync(base); } catch { baseReal = base; }
  const keepBase = path.basename(lastCodingSession()?.worktreePath || ""); // unique id → safe to match by name
  const cutoff = Date.now() - (cfg.coding.worktreeRetentionDays || 7) * 86_400_000;
  let removed = 0;
  for (const k of Object.keys(repos)) {
    const repoPath = repos[k]?.path;
    if (!repoPath) continue;
    await git(repoPath, "worktree", "prune");
    const list = (await git(repoPath, "worktree", "list", "--porcelain")).stdout;
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
      const r = await git(repoPath, "worktree", "remove", wt);
      if (r.code === 0) removed++;
    }
  }
  return removed;
}

// ── internals ────────────────────────────────────────────────────────────────

function spawnSession(j) {
  // Preserve Claude's subscription/runtime state while stripping bot, service, and
  // metered API credentials using the same policy as Hermes v2 engine children.
  const env = buildLegacyChildEnv(process.env);

  const args = buildSessionArgs({ prompt: j.prompt, modelId: j.modelId, effort: j.effort, worktreePath: j.worktreePath, sessionId: j.sessionId, resume: j.resume });
  const child = spawn(j.cfg.claudeBin || "claude", args, { cwd: j.worktreePath, env });

  active = {
    id: j.sessionId, child, repoKey: j.repoKey, repoLabel: j.repoLabel,
    worktreePath: j.worktreePath, branch: j.branch, baseSha: j.baseSha, sessionId: j.sessionId,
    model: j.model, effort: j.effort, startedAt: Date.now(), lastPingAt: 0,
    stepCount: 0, lastStep: "starting…", resultText: "", canceled: false, timedOut: false,
    onProgress: j.onProgress, onDone: j.onDone, cfg: j.cfg,
  };

  // Persist a breadcrumb so a bot restart can detect+report an interrupted job.
  const prefs = loadPrefs();
  prefs.coding = prefs.coding || {};
  prefs.coding.active = { id: j.sessionId, repoKey: j.repoKey, repoLabel: j.repoLabel, branch: j.branch, worktreePath: j.worktreePath, startedAt: active.startedAt };
  savePrefs(prefs);

  auditLine(buildStartAuditRecord(j));

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

async function finalize(exitCode) {
  const j = active;
  // Re-entrancy guard: a failed spawn fires BOTH 'error' and 'close', each calling finalize.
  // Since `active` is no longer nulled until the end (below), the synchronously-set j.finalizing
  // flag is what stops the second call from double-committing + double-notifying.
  if (!j || j.finalizing) return;
  // Keep the slot BUSY through the git commit/diff below — nulling `active` here would let a
  // new /code start a second job whose `git worktree add` races this job's commit on the same
  // repo. We free the slot only once the git work is done (just before onDone).
  j.finalizing = true;
  j.lastStep = "finalizing…";

  // Auto-commit any work to the task branch so the diff is durable and resumable.
  let committed = false;
  await git(j.worktreePath, "add", "-A");
  const dirty = await git(j.worktreePath, "status", "--porcelain");
  if (dirty.stdout.trim()) {
    const title = (j.prompt || "phone coding task").split("\n")[0].slice(0, 72);
    const c = await git(j.worktreePath, "commit", "-m", title, "-m", `via Hermes phone coding session (model=${j.model}, effort=${j.effort})`);
    committed = c.code === 0;
  }

  let diffStat = "", diffNames = "", headSha = "";
  try {
    headSha = await gitOut(j.worktreePath, "rev-parse", "HEAD");
    if (j.baseSha && headSha !== j.baseSha) {
      diffStat = (await git(j.worktreePath, "diff", "--stat", `${j.baseSha}..HEAD`)).stdout.trim();
      diffNames = (await git(j.worktreePath, "diff", "--name-only", `${j.baseSha}..HEAD`)).stdout.trim();
    }
  } catch { /* leave summary fields empty */ }

  const { ok, filesChanged } = finalizeResult({
    exitCode, isError: j.isError, canceled: j.canceled, timedOut: j.timedOut,
    baseSha: j.baseSha, headSha, diffNames,
  });

  const result = {
    ok, exitCode, canceled: j.canceled, timedOut: j.timedOut, spawnError: j.spawnError,
    resultText: j.resultText || "(no final message)",
    repoKey: j.repoKey, repoLabel: j.repoLabel, branch: j.branch, worktreePath: j.worktreePath,
    model: j.model, effort: j.effort, baseSha: j.baseSha, headSha,
    diffStat, filesChanged, committed, durationMs: Date.now() - j.startedAt,
  };

  // Record "last" for /code again + push; clear the active breadcrumb.
  const prefs = loadPrefs();
  prefs.coding = prefs.coding || {};
  prefs.coding.last = { sessionId: j.sessionId, repoKey: j.repoKey, repoLabel: j.repoLabel, worktreePath: j.worktreePath, branch: j.branch, model: j.model, effort: j.effort };
  delete prefs.coding.active;
  savePrefs(prefs);

  active = null; // git work done — free the slot so /code again (iterate) and new jobs work

  auditLine({ event: "done", id: j.sessionId, repo: j.repoKey, exitCode, canceled: j.canceled, timedOut: j.timedOut, filesChanged });

  try { await j.onDone?.(result); } catch { /* ignore */ }
}

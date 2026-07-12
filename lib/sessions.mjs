// Session lifecycle — spawn, persist, reconcile (ADR-0004).
//
// A session is one disposable headless engine run (griller, implementer,
// auditor…). Nothing durable lives in it: the GitHub issue is the continuity.
// Sessions are spawned detached (own PGID) so a bot restart — including
// launchd's group kill on `kickstart -k` — cannot take down an hours-long run
// that is blocked on an ask_owner answer. There is no way to re-adopt an
// orphan, so on startup we reconcile instead: probe each persisted PID, infer
// completion from the session's output files, and mark the dead-but-unfinished
// ones "orphaned" for the resume fallback (ADR-0001).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ROOT, writeJsonAtomic } from "./paperclip.mjs";
import { parseCodexThreadId, parseClaudeStreamMeta, isSilentCodexFailure } from "./engines.mjs";

export const SESSIONS_FILE = path.join(ROOT, "state", "hermes-sessions.json");
export const SESSION_LOG_DIR = path.join(ROOT, "logs", "sessions");

// ---------------------------------------------------------------------------
// Store — single writer (the bot), atomic writes, tolerant loads.

export function loadSessions({ file = SESSIONS_FILE } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && Array.isArray(data.sessions)) return data;
  } catch { /* missing or corrupt → fresh */ }
  return { sessions: [] };
}

export function saveSessions(data, { file = SESSIONS_FILE } = {}) {
  writeJsonAtomic(file, data);
}

export function mintAskToken() {
  return crypto.randomBytes(32).toString("base64url");
}

/** Upgrade legacy records before they can be launched again. Existing tokens
 * are stable capabilities and must never be rotated during ordinary reloads. */
export function ensureAskTokens(data) {
  let changed = false;
  const sessions = (data.sessions || []).map((record) => {
    if (typeof record.askToken === "string" && record.askToken.length > 0) return record;
    changed = true;
    return { ...record, askToken: mintAskToken() };
  });
  return { data: changed ? { ...data, sessions } : data, changed };
}

/** Fresh SessionRecord (docs/architecture.md "State files"). Persist it BEFORE
 * any question can flow: the record is what maps an ask_owner sessionKey back
 * to a worktree + engine session id for crash recovery. */
export function newSessionRecord({
  role, engine, repoKey, issue = null, worktree = null, branch = null,
  outFile = null, errFile = null, lastMessageFile = null,
  engineSessionId = null, now = new Date(),
}) {
  return {
    id: `sess-${crypto.randomBytes(4).toString("hex")}`,
    askToken: mintAskToken(),
    role, engine, repoKey, issue,
    pid: null, caffeinatePid: null,
    worktree, branch, engineSessionId,
    outFile, errFile, lastMessageFile,
    status: "running",
    startedAt: now.toISOString(), endedAt: null,
    ledgerCommentId: null,
  };
}

export function getSession(data, id) {
  return data.sessions.find((s) => s.id === id) || null;
}

/** Insert or replace by id; returns a NEW data object. */
export function upsertSession(data, rec) {
  const rest = data.sessions.filter((s) => s.id !== rec.id);
  return { ...data, sessions: [...rest, rec] };
}

/** Shallow-patch one record; returns a NEW data object. */
export function patchSession(data, id, patch) {
  return {
    ...data,
    sessions: data.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  };
}

export function runningSessions(data) {
  return data.sessions.filter((s) => s.status === "running");
}

/** ADR-0005: one global codex slot — concurrent `codex exec` sharing auth.json
 * can race the subscription token refresh and brick codex auth entirely. */
export function codexBusy(data) {
  return runningSessions(data).some((s) => s.engine === "codex");
}

// ---------------------------------------------------------------------------
// Spawning — detached, output to files, caffeinate alongside.

export function isPidAlive(pid, { killImpl = process.kill } = {}) {
  if (!pid) return false;
  try { killImpl(pid, 0); return true; }
  catch (err) { return err?.code === "EPERM"; }
}

/** Spawn detached with stdout/stderr appended to files.
 * stdin MUST be "ignore": `codex exec` with a non-TTY stdin that never closes
 * blocks forever on "Reading additional input from stdin..." (live-verified
 * 2026-07-06 on codex-cli 0.142.5). Detached = own PGID (ADR-0004). */
export function spawnDetached({ bin, args, cwd, env, outFile, errFile }, { spawnImpl = spawn } = {}) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const out = fs.openSync(outFile, "a");
  const err = fs.openSync(errFile || outFile, "a");
  const child = spawnImpl(bin, args, {
    cwd,
    env: env || process.env,
    detached: true,
    stdio: ["ignore", out, err],
  });
  fs.closeSync(out);
  if (errFile) fs.closeSync(err);
  child.unref();
  return child;
}

/** `caffeinate -i -w <pid>` — keep the machine awake for exactly as long as
 * the session lives (exits by itself when the watched pid dies), so multi-hour
 * runs survive on machines without sleep=0. Detached: must outlive the bot. */
export function spawnCaffeinate(pid, { spawnImpl = spawn } = {}) {
  try {
    const c = spawnImpl("caffeinate", ["-i", "-w", String(pid)], {
      detached: true, stdio: "ignore",
    });
    c.unref();
    return c.pid || null;
  } catch { return null; }
}

/**
 * Launch one session: persist the record FIRST (a crash between spawn and
 * persist would leave an untracked child — persisting an unspawned record
 * only leaves a dead entry reconcile cleans up), then spawn detached, then
 * patch in the PIDs. Returns { record, child }; callers attach child.on("exit")
 * for the live-finalize path (reconcile covers the bot-restart path).
 */
export function launchSession({ record, bin, args, cwd, env }, {
  file = SESSIONS_FILE, spawnImpl = spawn, caffeinate = true,
} = {}) {
  let data = loadSessions({ file });
  data = upsertSession(data, record);
  saveSessions(data, { file });

  const child = spawnDetached(
    { bin, args, cwd, env, outFile: record.outFile, errFile: record.errFile },
    { spawnImpl },
  );
  const caffeinatePid = caffeinate && child.pid ? spawnCaffeinate(child.pid, { spawnImpl }) : null;

  data = patchSession(loadSessions({ file }), record.id, { pid: child.pid || null, caffeinatePid });
  saveSessions(data, { file });
  return { record: getSession(data, record.id), child };
}

// ---------------------------------------------------------------------------
// Output inspection — how we learn what a session did without supervising it.

/** Read the tail of a possibly-large output file (sessions can stream MBs). */
export function readTail(file, { maxBytes = 262144, fsImpl = fs } = {}) {
  try {
    const size = fsImpl.statSync(file).size;
    const fd = fsImpl.openSync(file, "r");
    try {
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      fsImpl.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally { fsImpl.closeSync(fd); }
  } catch { return ""; }
}

/**
 * Infer a session's state from its output files.
 * claude (stream-json): a "result" line = finished; is_error = failed.
 * codex (--json): "turn.completed" event or a non-empty last-message file
 * (written via -o) = finished; thread_id comes from the thread.started event.
 */
export function sessionOutputMeta(record, { readImpl = readTail, fsImpl = fs } = {}) {
  const outText = record.outFile ? readImpl(record.outFile) : "";
  let lastText = "";
  try {
    if (record.lastMessageFile) lastText = fsImpl.readFileSync(record.lastMessageFile, "utf8");
  } catch { /* not written yet */ }

  if (record.engine === "claude") {
    const meta = parseClaudeStreamMeta(outText);
    return {
      engineSessionId: meta.sessionId || record.engineSessionId,
      finished: meta.lastResultText !== null,
      failed: Boolean(meta.isError),
      lastText: meta.lastResultText || "",
    };
  }
  const threadId = parseCodexThreadId(outText);
  const finished = /"type":"turn\.completed"/.test(outText) || lastText.trim() !== "";
  return {
    engineSessionId: threadId || record.engineSessionId,
    finished,
    failed: false, // codex reports failures in-band; exit-code path is the live finalize
    lastText: lastText.trim(),
  };
}

/** The codex no-TTY bug #19945 signature check for the live-finalize path. */
export function detectSilentCodexFailure(record, exitCode, { readImpl = readTail, fsImpl = fs } = {}) {
  if (record.engine !== "codex") return false;
  let lastText = "";
  try {
    if (record.lastMessageFile) lastText = fsImpl.readFileSync(record.lastMessageFile, "utf8");
  } catch { /* absent */ }
  return isSilentCodexFailure({
    exitCode,
    stdoutText: record.outFile ? readImpl(record.outFile) : "",
    lastMessageText: lastText,
  });
}

/**
 * Startup reconcile (ADR-0004): probe every persisted "running" record.
 *  - pid alive → leave running (caffeinate still watches it; detached children
 *    survive bot restarts by design).
 *  - dead + output shows completion → done/failed (harvest engineSessionId).
 *  - dead + no completion → "orphaned": the resume fallback re-enters it with
 *    `claude -p --resume` / `codex exec resume` from the recorded worktree —
 *    which is why a worktree with a pending question is never pruned.
 * Returns { data, alive, finished, orphaned } — caller saves and acts.
 */
export function reconcileSessions(data, {
  isAliveImpl = isPidAlive, metaImpl = sessionOutputMeta, now = new Date(),
} = {}) {
  const alive = [], finished = [], orphaned = [];
  let next = data;
  for (const rec of runningSessions(data)) {
    if (isAliveImpl(rec.pid)) { alive.push(rec); continue; }
    const meta = metaImpl(rec);
    const patch = { engineSessionId: meta.engineSessionId, endedAt: now.toISOString() };
    if (meta.finished) {
      patch.status = meta.failed ? "failed" : "done";
      next = patchSession(next, rec.id, patch);
      finished.push(getSession(next, rec.id));
    } else {
      patch.status = "orphaned";
      next = patchSession(next, rec.id, patch);
      orphaned.push(getSession(next, rec.id));
    }
  }
  return { data: next, alive, finished, orphaned };
}

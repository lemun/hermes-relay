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
import { ROOT } from "./runtime.mjs";
import { parseCodexThreadId, parseClaudeStreamMeta, isSilentCodexFailure } from "./engines.mjs";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  readPrivateFile,
  readPrivateFileTail,
  openPrivateFileForAppend,
  writePrivateJsonAtomic,
} from "./private-storage.mjs";

export const SESSIONS_FILE = path.join(ROOT, "state", "hermes-sessions.json");
export const SESSION_LOG_DIR = path.join(ROOT, "logs", "sessions");

export const ASK_TOKEN_MIGRATION = Object.freeze({
  DRAIN_REQUIRED: "drain-required",
  RECONCILE_REQUIRED: "reconcile-required",
  RESPAWN_REQUIRED: "respawn-required",
  RESPAWN_READY: "respawn-ready",
  DRAINED: "drained",
  COMPLETE: "complete",
});

export class SessionStateError extends Error {
  constructor(message, { file, cause } = {}) {
    super(message, { cause });
    this.name = "SessionStateError";
    this.code = "ERR_HERMES_SESSION_STATE";
    this.file = file;
  }
}

// ---------------------------------------------------------------------------
// Store — single writer (the bot), atomic writes, fail-closed loads.

function invalidSessionState(file, detail, cause) {
  return new SessionStateError(
    `Malformed durable session state at ${file} (${detail}); refusing to continue so recovery evidence is not overwritten.`,
    { file, cause },
  );
}

function assertValidSessionData(data, file) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.sessions)) {
    throw invalidSessionState(file, "expected an object with a sessions array");
  }
  const ids = new Set();
  for (const [index, record] of data.sessions.entries()) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw invalidSessionState(file, `session ${index} must be an object`);
    }
    if (typeof record.id !== "string" || record.id.trim() === "") {
      throw invalidSessionState(file, `session ${index} must have a valid non-empty id`);
    }
    if (ids.has(record.id)) {
      throw invalidSessionState(file, `duplicate session id ${record.id}`);
    }
    ids.add(record.id);
    if (typeof record.status !== "string" || record.status.trim() === "") {
      throw invalidSessionState(file, `session ${record.id} must have a valid non-empty status`);
    }
  }
  return data;
}

export function loadSessions({ file = SESSIONS_FILE, fsImpl = fs } = {}) {
  try {
    fsImpl.lstatSync(file);
  } catch (cause) {
    if (cause?.code === "ENOENT") return { sessions: [] };
    throw new SessionStateError(
      `Durable session state at ${file} is unreadable; refusing to continue so recovery evidence is not overwritten.`,
      { file, cause },
    );
  }
  let text;
  try {
    text = readPrivateFile(file, { fsImpl });
  } catch (cause) {
    throw new SessionStateError(
      `Durable session state at ${file} is unreadable; refusing to continue so recovery evidence is not overwritten.`,
      { file, cause },
    );
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (cause) {
    throw invalidSessionState(file, "invalid JSON", cause);
  }
  return assertValidSessionData(data, file);
}

export function saveSessions(data, { file = SESSIONS_FILE, fsImpl = fs } = {}) {
  assertValidSessionData(data, file);
  // Validate any durable predecessor immediately before replacement. This is
  // deliberately redundant with callers' load-before-save flow: if the file
  // becomes unreadable or corrupt between those calls, never replace the only
  // recovery evidence with a derived empty/partial registry.
  loadSessions({ file, fsImpl });
  ensurePrivateDirectory(path.dirname(file), { fsImpl });
  writePrivateJsonAtomic(file, data, { fsImpl });
}

export function mintAskToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function migrationReport(data) {
  const recordsFor = (state) => data.sessions.filter((record) => record.askTokenMigration === state);
  return {
    drainRequired: recordsFor(ASK_TOKEN_MIGRATION.DRAIN_REQUIRED),
    reconcileRequired: recordsFor(ASK_TOKEN_MIGRATION.RECONCILE_REQUIRED),
    respawnRequired: recordsFor(ASK_TOKEN_MIGRATION.RESPAWN_REQUIRED),
    respawnReady: recordsFor(ASK_TOKEN_MIGRATION.RESPAWN_READY),
    drained: recordsFor(ASK_TOKEN_MIGRATION.DRAINED),
  };
}

/**
 * Plan a fail-closed migration for tokenless legacy records.
 *
 * A surviving legacy child cannot learn a newly minted capability, so it is
 * explicitly marked drain-required and remains tokenless. A dead running
 * record must be reconciled before deciding whether it finished or needs a
 * replacement. Only an already-orphaned record receives a capability; that
 * token is then persisted before the replacement child is launched.
 *
 * Existing tokens are stable capabilities and are never rotated.
 */
export function ensureAskTokens(data, { isAliveImpl = isPidAlive } = {}) {
  let changed = false;
  const sessions = (data.sessions || []).map((record) => {
    if (typeof record.askToken === "string" && record.askToken.length > 0) return record;
    let askTokenMigration;
    let askToken;
    if (record.status === "running") {
      askTokenMigration = isAliveImpl(record.pid)
        ? ASK_TOKEN_MIGRATION.DRAIN_REQUIRED
        : ASK_TOKEN_MIGRATION.RECONCILE_REQUIRED;
    } else if (record.status === "orphaned") {
      askTokenMigration = ASK_TOKEN_MIGRATION.RESPAWN_READY;
      askToken = mintAskToken();
    } else {
      askTokenMigration = ASK_TOKEN_MIGRATION.DRAINED;
    }
    if (record.askTokenMigration === askTokenMigration && askToken === undefined) return record;
    changed = true;
    return askToken === undefined
      ? { ...record, askTokenMigration }
      : { ...record, askToken, askTokenMigration };
  });
  const migrated = changed ? { ...data, sessions } : data;
  return { data: migrated, changed, migration: migrationReport(migrated) };
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
  ensurePrivateDirectory(path.dirname(outFile));
  if (errFile && path.dirname(errFile) !== path.dirname(outFile)) {
    ensurePrivateDirectory(path.dirname(errFile));
  }
  const out = openPrivateFileForAppend(outFile);
  const err = errFile && errFile !== outFile ? openPrivateFileForAppend(errFile) : out;
  let child;
  try {
    child = spawnImpl(bin, args, {
      cwd,
      env: env || process.env,
      detached: true,
      stdio: ["ignore", out, err],
    });
  } finally {
    fs.closeSync(out);
    if (err !== out) fs.closeSync(err);
  }
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
  const launchRecord = record.askTokenMigration === ASK_TOKEN_MIGRATION.RESPAWN_READY
    ? { ...record, askTokenMigration: ASK_TOKEN_MIGRATION.COMPLETE }
    : record;
  let data = loadSessions({ file });
  data = upsertSession(data, launchRecord);
  saveSessions(data, { file });

  if (launchRecord.lastMessageFile) {
    ensurePrivateDirectory(path.dirname(launchRecord.lastMessageFile));
    ensurePrivateFile(launchRecord.lastMessageFile);
  }

  const child = spawnDetached(
    { bin, args, cwd, env, outFile: launchRecord.outFile, errFile: launchRecord.errFile },
    { spawnImpl },
  );
  const caffeinatePid = caffeinate && child.pid ? spawnCaffeinate(child.pid, { spawnImpl }) : null;

  data = patchSession(loadSessions({ file }), launchRecord.id, { pid: child.pid || null, caffeinatePid });
  saveSessions(data, { file });
  return { record: getSession(data, launchRecord.id), child };
}

// ---------------------------------------------------------------------------
// Output inspection — how we learn what a session did without supervising it.

/** Read the tail of a possibly-large output file (sessions can stream MBs). */
export function readTail(file, { maxBytes = 262144, fsImpl = fs } = {}) {
  try {
    return readPrivateFileTail(file, { maxBytes, fsImpl });
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
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
    if (record.lastMessageFile && fsImpl.existsSync(record.lastMessageFile)) {
      lastText = readPrivateFile(record.lastMessageFile, { fsImpl });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

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
    if (record.lastMessageFile && fsImpl.existsSync(record.lastMessageFile)) {
      lastText = readPrivateFile(record.lastMessageFile, { fsImpl });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
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
      if (!rec.askToken) patch.askTokenMigration = ASK_TOKEN_MIGRATION.DRAINED;
      next = patchSession(next, rec.id, patch);
      finished.push(getSession(next, rec.id));
    } else {
      patch.status = "orphaned";
      if (!rec.askToken) patch.askTokenMigration = ASK_TOKEN_MIGRATION.RESPAWN_REQUIRED;
      next = patchSession(next, rec.id, patch);
      orphaned.push(getSession(next, rec.id));
    }
  }
  return { data: next, alive, finished, orphaned };
}

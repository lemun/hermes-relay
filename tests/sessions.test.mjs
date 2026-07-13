import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSessions, saveSessions, newSessionRecord, upsertSession, patchSession,
  getSession, runningSessions, codexBusy, isPidAlive, spawnDetached,
  launchSession, readTail, sessionOutputMeta, detectSilentCodexFailure,
  reconcileSessions, ensureAskTokens, ASK_TOKEN_MIGRATION,
} from "../lib/sessions.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hermes-sess-"));

// Real event lines captured from the 2026-07-06 smoke test on codex-cli 0.142.5.
const CODEX_STARTED = '{"type":"thread.started","thread_id":"019f376f-1aba-78e3-aa01-886723bc837b"}';
const CODEX_DONE = '{"type":"turn.completed","usage":{"input_tokens":24377,"output_tokens":46}}';
const CLAUDE_INIT = '{"type":"system","subtype":"init","session_id":"11111111-2222-3333-4444-555555555555"}';
const CLAUDE_RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"All done.","session_id":"11111111-2222-3333-4444-555555555555"}';

function rec(over = {}) {
  return newSessionRecord({
    role: "implementer", engine: "codex", repoKey: "rn", issue: 12,
    worktree: "/tmp/wt", branch: "hermes/12-x",
    now: new Date("2026-07-06T10:00:00Z"), ...over,
  });
}

test("store: a missing file is fresh, but malformed state fails closed and is preserved", () => {
  const dir = tmp();
  assert.deepEqual(loadSessions({ file: path.join(dir, "nope.json") }), { sessions: [] });
  const bad = path.join(dir, "bad.json");
  const original = "{corrupt";
  fs.writeFileSync(bad, original);
  assert.throws(
    () => loadSessions({ file: bad }),
    (error) => error?.name === "SessionStateError" && /malformed.*refusing to continue/i.test(error.message),
  );
  assert.equal(fs.readFileSync(bad, "utf8"), original);
});

test("store: unreadable and structurally invalid state fail closed", () => {
  const dir = tmp();
  const unreadable = path.join(dir, "unreadable.json");
  const original = JSON.stringify({ sessions: [] });
  fs.writeFileSync(unreadable, original);
  const fsImpl = {
    ...fs,
    readFileSync() {
      const error = new Error("simulated disk read failure");
      error.code = "EIO";
      throw error;
    },
  };
  assert.throws(
    () => loadSessions({ file: unreadable, fsImpl }),
    (error) => error?.name === "SessionStateError" && /unreadable.*refusing to continue/i.test(error.message),
  );
  const disappearedDuringRead = {
    ...fs,
    readFileSync() {
      const error = new Error("simulated read race");
      error.code = "ENOENT";
      throw error;
    },
  };
  assert.throws(
    () => loadSessions({ file: unreadable, fsImpl: disappearedDuringRead }),
    (error) => error?.name === "SessionStateError" && /unreadable.*refusing to continue/i.test(error.message),
    "ENOENT after an existing state file was observed must fail closed",
  );
  assert.equal(fs.readFileSync(unreadable, "utf8"), original);

  const invalid = path.join(dir, "invalid.json");
  fs.writeFileSync(invalid, JSON.stringify({ sessions: [{ status: "running" }] }));
  assert.throws(() => loadSessions({ file: invalid }), /valid non-empty id/i);
});

test("store: save/load round-trips and upsert replaces by id", () => {
  const file = path.join(tmp(), "s.json");
  const r = rec();
  let data = upsertSession({ sessions: [] }, r);
  saveSessions(data, { file });
  assert.deepEqual(loadSessions({ file }), data);
  data = upsertSession(data, { ...r, status: "done" });
  assert.equal(data.sessions.length, 1);
  assert.equal(getSession(data, r.id).status, "done");
});

test("store: save refuses to overwrite malformed durable state with an empty registry", () => {
  const file = path.join(tmp(), "s.json");
  const original = "{corrupt-recovery-evidence";
  fs.writeFileSync(file, original);
  assert.throws(
    () => saveSessions({ sessions: [] }, { file }),
    (error) => error?.name === "SessionStateError",
  );
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("store: ask_owner capabilities are 0600 in a 0700 state directory under permissive umask", () => {
  const root = tmp();
  const file = path.join(root, "state", "hermes-sessions.json");
  const previousUmask = process.umask(0o000);
  try {
    const record = rec();
    saveSessions({ sessions: [record] }, { file });
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).sessions[0].askToken, record.askToken);

    fs.chmodSync(file, 0o666);
    saveSessions({ sessions: [record] }, { file });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("store: capability persistence surfaces chmod failures and does not replace the prior file", () => {
  const dir = tmp();
  const file = path.join(dir, "hermes-sessions.json");
  fs.writeFileSync(file, JSON.stringify({ sessions: [] }), { mode: 0o644 });
  const fsImpl = {
    ...fs,
    fchmodSync() {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
  };
  assert.throws(
    () => saveSessions({ sessions: [rec()] }, { file, fsImpl }),
    /hermes-sessions\.json.*(?:unreadable|recovery evidence)|secure private temporary file.*hermes-sessions\.json/i,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { sessions: [] });
  assert.equal(fs.readdirSync(dir).some((name) => name.includes(".tmp-")), false);
});

test("newSessionRecord shape: sess- id, running, nulls where unknown", () => {
  const r = rec();
  assert.match(r.id, /^sess-[0-9a-f]{8}$/);
  assert.equal(r.status, "running");
  assert.equal(r.pid, null);
  assert.equal(r.ledgerCommentId, null);
  assert.equal(r.startedAt, "2026-07-06T10:00:00.000Z");
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(r.askToken), true);
  assert.equal(r.askToken !== rec().askToken, true, "each session receives an independent capability");
});

test("ensureAskTokens marks a surviving tokenless child for drain without minting an unusable token", () => {
  const legacy = { ...rec(), askToken: undefined, pid: 4242 };
  const first = ensureAskTokens({ sessions: [legacy] }, { isAliveImpl: () => true });
  const migrated = first.data.sessions[0];
  assert.equal(first.changed, true);
  assert.equal(migrated.askToken, undefined);
  assert.equal(migrated.askTokenMigration, ASK_TOKEN_MIGRATION.DRAIN_REQUIRED);
  assert.deepEqual(first.migration.drainRequired.map((record) => record.id), [legacy.id]);

  const second = ensureAskTokens(first.data, { isAliveImpl: () => true });
  assert.equal(second.changed, false, "durable drain state must be stable across reloads");
  assert.equal(second.data.sessions[0].askToken, undefined);
  assert.deepEqual(second.migration.drainRequired.map((record) => record.id), [legacy.id]);
});

test("legacy token migration reconciles before minting and makes only an orphan respawn-ready", () => {
  const legacy = { ...rec(), askToken: undefined, pid: 4242 };
  const planned = ensureAskTokens({ sessions: [legacy] }, { isAliveImpl: () => false });
  assert.equal(planned.data.sessions[0].askToken, undefined);
  assert.equal(planned.data.sessions[0].askTokenMigration, ASK_TOKEN_MIGRATION.RECONCILE_REQUIRED);

  const reconciled = reconcileSessions(planned.data, {
    isAliveImpl: () => false,
    metaImpl: () => ({ engineSessionId: "thread-legacy", finished: false, failed: false }),
  });
  const orphan = reconciled.data.sessions[0];
  assert.equal(orphan.status, "orphaned");
  assert.equal(orphan.askToken, undefined);
  assert.equal(orphan.askTokenMigration, ASK_TOKEN_MIGRATION.RESPAWN_REQUIRED);

  const ready = ensureAskTokens(reconciled.data);
  const migrated = ready.data.sessions[0];
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(migrated.askToken), true);
  assert.equal(migrated.askTokenMigration, ASK_TOKEN_MIGRATION.RESPAWN_READY);
  assert.deepEqual(ready.migration.respawnReady.map((record) => record.id), [legacy.id]);

  const repeated = ensureAskTokens(ready.data);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.data.sessions[0].askToken, migrated.askToken, "migration capability must remain stable");
  assert.deepEqual(repeated.migration.respawnReady.map((record) => record.id), [legacy.id]);
});

test("reconcile marks a finished tokenless legacy child drained without minting a token", () => {
  const legacy = {
    ...rec(), askToken: undefined, pid: 4242,
    askTokenMigration: ASK_TOKEN_MIGRATION.DRAIN_REQUIRED,
  };
  const reconciled = reconcileSessions({ sessions: [legacy] }, {
    isAliveImpl: () => false,
    metaImpl: () => ({ engineSessionId: "thread-legacy", finished: true, failed: false }),
  });
  const drained = reconciled.data.sessions[0];
  assert.equal(drained.status, "done");
  assert.equal(drained.askToken, undefined);
  assert.equal(drained.askTokenMigration, ASK_TOKEN_MIGRATION.DRAINED);
});

test("patchSession returns new object without mutating input", () => {
  const r = rec();
  const data = upsertSession({ sessions: [] }, r);
  const next = patchSession(data, r.id, { status: "done" });
  assert.equal(getSession(data, r.id).status, "running");
  assert.equal(getSession(next, r.id).status, "done");
});

test("codexBusy: only running codex sessions occupy the single slot", () => {
  let data = { sessions: [] };
  assert.equal(codexBusy(data), false);
  data = upsertSession(data, rec({ engine: "claude" }));
  assert.equal(codexBusy(data), false);
  const c = rec();
  data = upsertSession(data, c);
  assert.equal(codexBusy(data), true);
  data = patchSession(data, c.id, { status: "done" });
  assert.equal(codexBusy(data), false);
});

test("isPidAlive: own pid alive, absurd pid dead, EPERM counts as alive", () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(2 ** 30), false);
  const eperm = () => { const e = new Error("nope"); e.code = "EPERM"; throw e; };
  assert.equal(isPidAlive(1234, { killImpl: eperm }), true);
});

test("spawnDetached: stdin ignored, output lands in file, child detached", async () => {
  const dir = tmp();
  const outFile = path.join(dir, "out.log");
  // A child that would hang forever if stdin were an open pipe (the codex
  // no-TTY hang): reading stdin must hit EOF immediately under "ignore".
  const child = spawnDetached({
    bin: process.execPath,
    args: ["-e", "process.stdin.on('data',()=>{}); process.stdin.on('end',()=>{console.log('EOF-OK'); process.exit(0)});"],
    cwd: dir, outFile,
  });
  assert.ok(child.pid > 0);
  child.ref(); // unref()ed by spawnDetached; re-ref so the test loop can await the exit
  await new Promise((resolve) => child.on("exit", resolve));
  assert.match(fs.readFileSync(outFile, "utf8"), /EOF-OK/);
});

test("spawnDetached tightens its log directory and files before the child starts", () => {
  const root = tmp();
  const dir = path.join(root, "session");
  const outFile = path.join(dir, "out.jsonl");
  const errFile = path.join(dir, "err.log");
  const previousUmask = process.umask(0o000);
  try {
    fs.mkdirSync(dir, { mode: 0o777 });
    fs.writeFileSync(outFile, "old", { mode: 0o666 });
    fs.writeFileSync(errFile, "old", { mode: 0o666 });
    const spawnImpl = (_bin, _args, options) => {
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(fs.fstatSync(options.stdio[1]).mode & 0o777, 0o600);
      assert.equal(fs.fstatSync(options.stdio[2]).mode & 0o777, 0o600);
      return { pid: 4242, unref() {} };
    };
    spawnDetached({ bin: "true", args: [], cwd: root, outFile, errFile }, { spawnImpl });
  } finally {
    process.umask(previousUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launchSession persists the record BEFORE spawning (ADR-0004 ordering)", () => {
  const dir = tmp();
  const file = path.join(dir, "s.json");
  const r = rec({ outFile: path.join(dir, "o.log"), errFile: path.join(dir, "e.log") });
  let persistedAtSpawn = null;
  const spawnImpl = () => {
    persistedAtSpawn = loadSessions({ file }).sessions.map((s) => s.id);
    return { pid: 4242, unref() {}, on() {} };
  };
  const { record } = launchSession(
    { record: r, bin: "true", args: [], cwd: dir },
    { file, spawnImpl, caffeinate: false },
  );
  assert.deepEqual(persistedAtSpawn, [r.id], "record must be on disk before spawn");
  assert.equal(record.pid, 4242);
  assert.equal(loadSessions({ file }).sessions[0].pid, 4242);
});

test("launchSession refuses to spawn or overwrite when durable state is malformed", () => {
  const dir = tmp();
  const file = path.join(dir, "s.json");
  const original = "{broken-session-state";
  fs.writeFileSync(file, original);
  let spawned = false;
  assert.throws(
    () => launchSession(
      {
        record: rec({ outFile: path.join(dir, "o.log"), errFile: path.join(dir, "e.log") }),
        bin: "true", args: [], cwd: dir,
      },
      { file, spawnImpl: () => { spawned = true; }, caffeinate: false },
    ),
    (error) => error?.name === "SessionStateError",
  );
  assert.equal(spawned, false);
  assert.equal(fs.readFileSync(file, "utf8"), original);
});

test("launchSession completes a respawn-ready legacy migration without rotating its token", () => {
  const dir = tmp();
  const file = path.join(dir, "s.json");
  const askToken = "legacy-respawn-capability";
  const record = {
    ...rec({
      outFile: path.join(dir, "o.log"),
      errFile: path.join(dir, "e.log"),
    }),
    status: "orphaned",
    askToken,
    askTokenMigration: ASK_TOKEN_MIGRATION.RESPAWN_READY,
  };
  saveSessions({ sessions: [record] }, { file });
  const launched = launchSession(
    { record: { ...record, status: "running" }, bin: "true", args: [], cwd: dir },
    { file, spawnImpl: () => ({ pid: 4242, unref() {}, on() {} }), caffeinate: false },
  );
  assert.equal(launched.record.askToken, askToken);
  assert.equal(launched.record.askTokenMigration, ASK_TOKEN_MIGRATION.COMPLETE);
  const persisted = loadSessions({ file }).sessions[0];
  assert.equal(persisted.askToken, askToken);
  assert.equal(persisted.askTokenMigration, ASK_TOKEN_MIGRATION.COMPLETE);
});

test("launchSession pre-creates the child-written last message file as 0600", () => {
  const root = tmp();
  const dir = path.join(root, "session");
  const file = path.join(root, "state", "hermes-sessions.json");
  const lastMessageFile = path.join(dir, "last-message.txt");
  const record = rec({
    outFile: path.join(dir, "out.jsonl"),
    errFile: path.join(dir, "err.log"),
    lastMessageFile,
  });
  const previousUmask = process.umask(0o000);
  try {
    const spawnImpl = () => {
      assert.equal(fs.statSync(lastMessageFile).mode & 0o777, 0o600);
      return { pid: 4242, unref() {}, on() {} };
    };
    launchSession(
      { record, bin: "true", args: [], cwd: root },
      { file, spawnImpl, caffeinate: false },
    );
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("session output inspection re-tightens a child replacement and rejects symlinks", () => {
  const dir = tmp();
  const outFile = path.join(dir, "out.jsonl");
  const lastMessageFile = path.join(dir, "last-message.txt");
  fs.writeFileSync(outFile, `${CODEX_STARTED}\n`);
  fs.writeFileSync(lastMessageFile, "private result", { mode: 0o666 });
  const record = rec({ outFile, lastMessageFile });
  assert.equal(sessionOutputMeta(record).lastText, "private result");
  assert.equal(fs.statSync(lastMessageFile).mode & 0o777, 0o600);

  fs.unlinkSync(lastMessageFile);
  const target = path.join(dir, "attacker-target");
  fs.writeFileSync(target, "do not read", { mode: 0o644 });
  fs.symlinkSync(target, lastMessageFile);
  assert.throws(() => sessionOutputMeta(record), /symbolic link/i);
  assert.equal(fs.readFileSync(target, "utf8"), "do not read");
});

test("readTail returns only the tail of large files and '' when missing", () => {
  const dir = tmp();
  const f = path.join(dir, "big.log");
  fs.writeFileSync(f, "x".repeat(1000) + "END");
  assert.equal(readTail(f, { maxBytes: 3 }), "END");
  assert.equal(readTail(path.join(dir, "absent.log")), "");
  const target = path.join(dir, "target.log");
  const link = path.join(dir, "linked.log");
  fs.writeFileSync(target, "do not follow");
  fs.symlinkSync(target, link);
  assert.throws(() => readTail(link), /symbolic link/i);
});

test("sessionOutputMeta: codex thread.started + turn.completed (real shapes)", () => {
  const dir = tmp();
  const outFile = path.join(dir, "o.jsonl");
  fs.writeFileSync(outFile, `${CODEX_STARTED}\n${CODEX_DONE}\n`);
  const meta = sessionOutputMeta(rec({ outFile }));
  assert.equal(meta.engineSessionId, "019f376f-1aba-78e3-aa01-886723bc837b");
  assert.equal(meta.finished, true);
});

test("sessionOutputMeta: codex unfinished without turn.completed or last message", () => {
  const dir = tmp();
  const outFile = path.join(dir, "o.jsonl");
  fs.writeFileSync(outFile, `${CODEX_STARTED}\n`);
  const meta = sessionOutputMeta(rec({ outFile, lastMessageFile: path.join(dir, "last.txt") }));
  assert.equal(meta.finished, false);
});

test("sessionOutputMeta: codex non-empty last-message file counts as finished", () => {
  const dir = tmp();
  const outFile = path.join(dir, "o.jsonl");
  const lastMessageFile = path.join(dir, "last.txt");
  fs.writeFileSync(outFile, `${CODEX_STARTED}\n`);
  fs.writeFileSync(lastMessageFile, "PONG\n");
  const meta = sessionOutputMeta(rec({ outFile, lastMessageFile }));
  assert.equal(meta.finished, true);
  assert.equal(meta.lastText, "PONG");
});

test("sessionOutputMeta: claude result line = finished, is_error = failed", () => {
  const dir = tmp();
  const outFile = path.join(dir, "o.jsonl");
  fs.writeFileSync(outFile, `${CLAUDE_INIT}\n${CLAUDE_RESULT}\n`);
  const meta = sessionOutputMeta(rec({ engine: "claude", outFile }));
  assert.equal(meta.engineSessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(meta.finished, true);
  assert.equal(meta.failed, false);
  assert.equal(meta.lastText, "All done.");
});

test("detectSilentCodexFailure: empty output + exit 0 = bug #19945", () => {
  const dir = tmp();
  const outFile = path.join(dir, "o.jsonl");
  const lastMessageFile = path.join(dir, "last.txt");
  fs.writeFileSync(outFile, "");
  const r = rec({ outFile, lastMessageFile });
  assert.equal(detectSilentCodexFailure(r, 0), true);
  assert.equal(detectSilentCodexFailure(r, 1), false);
  fs.writeFileSync(lastMessageFile, "PONG");
  assert.equal(detectSilentCodexFailure(r, 0), false);
  assert.equal(detectSilentCodexFailure(rec({ engine: "claude", outFile }), 0), false);
});

test("reconcileSessions: alive stays running, finished harvested, rest orphaned", () => {
  const dir = tmp();
  const aliveRec = rec();
  const doneRec = rec();
  const lostRec = rec();
  const claudeFailed = rec({ engine: "claude" });
  let data = { sessions: [] };
  for (const r of [aliveRec, doneRec, lostRec, claudeFailed]) data = upsertSession(data, { ...r, pid: 100 });

  const doneOut = path.join(dir, "done.jsonl");
  fs.writeFileSync(doneOut, `${CODEX_STARTED}\n${CODEX_DONE}\n`);
  const failedOut = path.join(dir, "failed.jsonl");
  fs.writeFileSync(failedOut, CLAUDE_RESULT.replace('"is_error":false', '"is_error":true') + "\n");

  data = patchSession(data, doneRec.id, { outFile: doneOut });
  data = patchSession(data, claudeFailed.id, { outFile: failedOut });

  const allDead = reconcileSessions(data, {
    isAliveImpl: () => false,
    now: new Date("2026-07-06T12:00:00Z"),
  });
  assert.equal(allDead.alive.length, 0);

  const res3 = reconcileSessions(patchSession(data, aliveRec.id, { pid: process.pid }), {
    isAliveImpl: (pid) => pid === process.pid,
    now: new Date("2026-07-06T12:00:00Z"),
  });
  assert.deepEqual(res3.alive.map((s) => s.id), [aliveRec.id]);
  assert.deepEqual(res3.finished.map((s) => s.id).sort(), [doneRec.id, claudeFailed.id].sort());
  assert.deepEqual(res3.orphaned.map((s) => s.id), [lostRec.id]);
  assert.equal(getSession(res3.data, doneRec.id).status, "done");
  assert.equal(getSession(res3.data, doneRec.id).engineSessionId, "019f376f-1aba-78e3-aa01-886723bc837b");
  assert.equal(getSession(res3.data, claudeFailed.id).status, "failed");
  assert.equal(getSession(res3.data, lostRec.id).status, "orphaned");
  assert.equal(getSession(res3.data, lostRec.id).endedAt, "2026-07-06T12:00:00.000Z");
  // input untouched
  assert.equal(getSession(data, doneRec.id).status, "running");
});

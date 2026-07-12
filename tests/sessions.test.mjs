import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSessions, saveSessions, newSessionRecord, upsertSession, patchSession,
  getSession, runningSessions, codexBusy, isPidAlive, spawnDetached,
  launchSession, readTail, sessionOutputMeta, detectSilentCodexFailure,
  reconcileSessions, ensureAskTokens,
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

test("store: load is tolerant of missing and corrupt files", () => {
  const dir = tmp();
  assert.deepEqual(loadSessions({ file: path.join(dir, "nope.json") }), { sessions: [] });
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{corrupt");
  assert.deepEqual(loadSessions({ file: bad }), { sessions: [] });
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

test("ensureAskTokens mints legacy tokens once and preserves them across reloads", () => {
  const file = path.join(tmp(), "s.json");
  const legacy = { ...rec(), askToken: undefined };
  const first = ensureAskTokens({ sessions: [legacy] });
  assert.equal(first.changed, true);
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(first.data.sessions[0].askToken), true);
  saveSessions(first.data, { file });

  const persisted = loadSessions({ file });
  const second = ensureAskTokens(persisted);
  assert.equal(second.changed, false);
  assert.equal(second.data.sessions[0].askToken === first.data.sessions[0].askToken, true);
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

test("readTail returns only the tail of large files and '' when missing", () => {
  const dir = tmp();
  const f = path.join(dir, "big.log");
  fs.writeFileSync(f, "x".repeat(1000) + "END");
  assert.equal(readTail(f, { maxBytes: 3 }), "END");
  assert.equal(readTail(path.join(dir, "absent.log")), "");
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

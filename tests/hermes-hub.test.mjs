import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHermesHub } from "../lib/hermes-hub.mjs";
import * as sessions from "../lib/sessions.mjs";
import * as questions from "../lib/questions.mjs";

// A hub wired to stubs: every external effect (telegram, github, spawning)
// is recorded in `calls` so tests assert on ordering and payloads.
function makeHub({ seedSessions = [], autopilotEnabled = false } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-"));
  const sessFile = path.join(stateDir, "hermes-sessions.json");
  sessions.saveSessions({ sessions: seedSessions }, { file: sessFile });
  if (autopilotEnabled) {
    fs.writeFileSync(path.join(stateDir, "hermes-autopilot.json"),
      JSON.stringify({ enabled: true, dispatched: { date: "", count: 0 } }));
  }

  const calls = [];
  let msgId = 100;
  const telegram = {
    tg: async (method, body) => {
      calls.push({ kind: "tg", method, body });
      return { ok: true, result: { message_id: ++msgId } };
    },
    kbd: (rows) => ({ inline_keyboard: rows }),
    sendKbd: async () => ++msgId,
    editMsg: async (...a) => { calls.push({ kind: "editMsg", a }); return { ok: true }; },
    answerCallback: async () => {},
  };
  const gh = {
    createComment: async (x) => { calls.push({ kind: "createComment", x }); return { id: 777 }; },
    editComment: async (x) => { calls.push({ kind: "editComment", x }); return { status: 200 }; },
    addLabels: async (x) => { calls.push({ kind: "addLabels", x }); },
    removeLabel: async (x) => { calls.push({ kind: "removeLabel", x }); },
    createIssue: async (x) => { calls.push({ kind: "createIssue", x }); return { number: 9, html_url: "u" }; },
    getPr: async () => ({ status: 200, json: { mergeable: true, head: { sha: "abc", ref: "b" }, base: { ref: "main" } } }),
    getChecksForRef: async () => ({ total: 0, pending: 0, failed: 0 }),
    mergePr: async () => ({ merged: true }),
    pollRepoIssues: async () => ({ changed: false, etag: "e" }),
    createCoalescedEditor: () => ({ schedule: (x) => calls.push({ kind: "scheduleEdit", x }), flush: async () => {}, pendingCount: () => 0 }),
    adaptivePollDelayMs: () => 99999,
  };
  const spawned = [];
  const launchSession = ({ record, bin, args, cwd }, opts) => {
    // mirror the real contract: persist first, then "spawn"
    let data = sessions.loadSessions({ file: opts.file });
    data = sessions.upsertSession(data, record);
    sessions.saveSessions(data, { file: opts.file });
    const child = new EventEmitter();
    child.pid = 4242;
    spawned.push({ record, bin, args, cwd, child });
    return { record: { ...record, pid: 4242 }, child };
  };

  const cfg = {
    claudeBin: "claude",
    hermes: {
      enabled: true,
      repos: { rn: { path: stateDir, slug: "lemun/example-app", label: "RN" } },
      defaultEngine: "codex", codexBin: "/fake/codex",
      pollActiveSeconds: 30, pollIdleSeconds: 180, askTimeoutHours: 8, sessionCap: 6, grillerCap: 2,
      autopilot: { dailyBudget: 10, maxLoadPerCore: 0.8, minFreeMemMB: 1024, hidIdleMinutes: 10 },
      tiers: { digest: "haiku", prose: "sonnet", grilling: "opus", audit: "opus", implementation: "codex" },
      morningDigestHour: 8,
    },
  };
  const hub = createHermesHub({
    cfg, telegram, chatId: "111", stateDir, log: () => {},
    deps: { gh, launchSession, gatherGateInputs: async () => ({ loadavg1: 0, cpuCount: 8, freeMemMB: 9999, hidIdleSec: 9999 }), execFile: () => {} },
  });
  return { hub, calls, spawned, stateDir, sessFile };
}

const seedRecord = (over = {}) => ({
  ...sessions.newSessionRecord({
    role: "griller", engine: "claude", repoKey: "rn", issue: 42,
    worktree: "/wt", branch: null, now: new Date("2026-07-06T10:00:00Z"),
  }),
  pid: 4242, ledgerCommentId: 777, ...over,
});

test("onAsk: persists the question and writes the ledger BEFORE the phone card (ADR-0001)", async () => {
  const rec = seedRecord();
  const { hub, calls, stateDir } = makeHub({ seedSessions: [rec] });
  const { id } = await hub.onAsk({ sessionKey: rec.id, question: "Keep the phone step?", recommended: "Yes" });
  assert.match(id, /^q-[0-9a-f]{8}$/);

  const qOnDisk = questions.getQuestion(
    questions.loadQuestions({ file: path.join(stateDir, "hermes-questions.json") }), id);
  assert.equal(qOnDisk.status, "pending");
  assert.equal(qOnDisk.sessionId, rec.id);

  const ledgerIdx = calls.findIndex((c) => c.kind === "editComment"); // immediate, not coalesced
  const cardIdx = calls.findIndex((c) => c.kind === "tg" && c.method === "sendMessage" && /Keep the phone step/.test(c.body.text));
  assert.ok(ledgerIdx !== -1, "ledger comment must be edited immediately");
  assert.ok(cardIdx !== -1, "question card must be sent");
  assert.ok(ledgerIdx < cardIdx, "ledger write must precede the phone card");
  assert.ok(calls[ledgerIdx].x.body.includes("Keep the phone step?"), "ledger carries the question");

  const label = calls.find((c) => c.kind === "addLabels");
  assert.deepEqual(label.x.labels, ["waiting-input"]);
});

test("onAsk: rejects unknown sessions; notifies only on 0→1", async () => {
  const rec = seedRecord();
  const { hub, calls } = makeHub({ seedSessions: [rec] });
  await assert.rejects(() => hub.onAsk({ sessionKey: "sess-ffffffff", question: "?", recommended: "x" }), /unknown session/);

  await hub.onAsk({ sessionKey: rec.id, question: "first", recommended: "a" });
  await hub.onAsk({ sessionKey: rec.id, question: "second", recommended: "b" });
  const cards = calls.filter((c) => c.kind === "tg" && c.method === "sendMessage" && /💡 Recommended/.test(c.body.text));
  assert.equal(cards.length, 2);
  assert.equal(cards[0].body.disable_notification, false, "0→1 must ring the phone");
  assert.equal(cards[1].body.disable_notification, true, "later questions arrive silently");
});

test("getAnswer + deliverAnswer round-trip; waiting-input removed with no more pending", async () => {
  const rec = seedRecord();
  const { hub, calls } = makeHub({ seedSessions: [rec] });
  const { id } = await hub.onAsk({ sessionKey: rec.id, question: "q", recommended: "r" });
  assert.deepEqual(hub.getAnswer(id), { status: "pending" });

  const ok = await hub.deliverAnswer(id, "ship it");
  assert.equal(ok, true);
  assert.deepEqual(hub.getAnswer(id), { status: "answered", answer: "ship it" });
  assert.equal(await hub.deliverAnswer(id, "again"), false, "double answers are refused");

  const removed = calls.find((c) => c.kind === "removeLabel");
  assert.equal(removed.x.label, "waiting-input");
});

test("deliverAnswer resumes an orphaned session with the answer (resume fallback)", async () => {
  const rec = seedRecord({ status: "orphaned", engine: "claude", engineSessionId: "abc-123" });
  const { hub, spawned } = makeHub({ seedSessions: [rec] });
  const { id } = await hub.onAsk({ sessionKey: rec.id, question: "q", recommended: "r" });
  // (onAsk against an orphaned session still relays — recovery re-surfaces cards)
  await hub.deliverAnswer(id, "yes, do that");
  assert.equal(spawned.length, 1, "orphan must be respawned");
  const args = spawned[0].args;
  assert.ok(args.includes("--resume") && args.includes("abc-123"), "resume by recorded session id");
  assert.ok(args.some((a) => /Owner answered.*yes, do that/.test(a)), "answer rides the resume prompt");
  assert.equal(spawned[0].cwd, "/wt", "resume from the SAME worktree (cwd-scoped)");
});

test("handleCallback ask:yes answers with the recommended text", async () => {
  const rec = seedRecord();
  const { hub } = makeHub({ seedSessions: [rec] });
  const { id } = await hub.onAsk({ sessionKey: rec.id, question: "q", recommended: "the default" });
  const handled = await hub.handleCallback({ id: "cb1", data: `ask:yes:${id}` });
  assert.equal(handled, true);
  assert.deepEqual(hub.getAnswer(id), { status: "answered", answer: "the default" });
});

test("ask:other arms the awaiting state; the next text becomes the answer", async () => {
  const rec = seedRecord();
  const { hub } = makeHub({ seedSessions: [rec] });
  const { id } = await hub.onAsk({ sessionKey: rec.id, question: "q", recommended: "r" });
  await hub.handleCallback({ id: "cb1", data: `ask:other:${id}` });
  assert.equal(await hub.captureAwaitingInput("my custom answer"), true);
  assert.deepEqual(hub.getAnswer(id), { status: "answered", answer: "my custom answer" });
  assert.equal(await hub.captureAwaitingInput("stray text"), false, "state must disarm after one capture");
});

test("handleCommand: /auto toggles and reports; unknown commands fall through", async () => {
  const { hub, calls } = makeHub({});
  assert.equal(await hub.handleCommand("/auto on"), true);
  assert.ok(calls.some((c) => c.kind === "tg" && /Autopilot ON/.test(c.body.text)));
  assert.equal(await hub.handleCommand("/auto off"), true);
  assert.equal(await hub.handleCommand("/auto"), true); // status text
  assert.equal(await hub.handleCommand("/nope"), false);
});

test("handleCommand: /tiers shows and sets job→model overrides", async () => {
  const { hub, calls } = makeHub({});
  assert.equal(await hub.handleCommand("/tiers"), true);
  const table = calls.filter((c) => c.kind === "tg").at(-1).body.text;
  assert.match(table, /grilling: opus/);
  await hub.handleCommand("/tiers grilling sonnet");
  await hub.handleCommand("/tiers");
  const after = calls.filter((c) => c.kind === "tg").at(-1).body.text;
  assert.match(after, /grilling: sonnet/);
});

test("/dispatch: parses forms, enforces cap + codex slot, rejects garbage", async () => {
  const runningCodex = {
    ...sessions.newSessionRecord({
      role: "implementer", engine: "codex", repoKey: "rn", issue: 7,
      worktree: "/wt7", now: new Date("2026-07-06T10:00:00Z"),
    }),
    pid: 4242,
  };
  const { hub, calls } = makeHub({ seedSessions: [runningCodex] });
  const lastText = () => calls.filter((c) => c.kind === "tg").at(-1).body.text;

  assert.equal(await hub.handleCommand("/dispatch nonsense"), true);
  assert.match(lastText(), /Can't parse/);

  assert.equal(await hub.handleCommand("/dispatch rn#7"), true);
  assert.match(lastText(), /already has a session/);

  // default engine is codex and the single slot is occupied by rn#7
  assert.equal(await hub.handleCommand("/dispatch rn 42"), true);
  assert.match(lastText(), /Codex slot is busy/);
});

test("disp:go callback routes into manual dispatch", async () => {
  const { hub, calls } = makeHub({});
  const handled = await hub.handleCallback({ id: "cb1", data: "disp:go:zz#1" });
  assert.equal(handled, true);
  assert.match(calls.filter((c) => c.kind === "tg").at(-1).body.text, /Can't parse/);
});

test("pollTick grilling intake: drains needs-grilling at grillerCap, not sessionCap", async () => {
  const { hub, spawned, stateDir } = makeHub({});
  const issue = (n) => ({
    number: n, title: `Issue ${n}`, body: "body",
    labels: [{ name: "needs-grilling" }],
  });
  fs.writeFileSync(path.join(stateDir, "hermes-etags.json"), JSON.stringify({
    rn: { etag: "e", issues: [issue(1), issue(2), issue(3)] },
  }));
  await hub.pollTick();
  const grillers = spawned.filter((s) => s.record.role === "griller");
  assert.equal(grillers.length, 2, "grillerCap=2 must bound automatic intake");
  assert.deepEqual(grillers.map((g) => g.record.issue), [1, 2]);
  assert.equal(grillers[0].bin, "claude");
  // second tick: the two "running" grillers still occupy the cap — no third spawn
  await hub.pollTick();
  assert.equal(spawned.filter((s) => s.record.role === "griller").length, 2);
});

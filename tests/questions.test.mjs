import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadQuestions, saveQuestions, newQuestion, addQuestion,
  setAnswer, setTgMessageId, expireQuestion, pendingQuestions, getQuestion,
} from "../lib/questions.mjs";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "hermes-questions-")), "hermes-questions.json");
const FIXED = new Date(2026, 5, 21, 9, 5); // 2026-06-21 09:05

// ── loadQuestions / saveQuestions: tolerant round-trip ───────────────────────
test("loadQuestions tolerates a missing file (returns a clean empty shape)", () => {
  const q = loadQuestions({ file: path.join(tmpdir(), "does-not-exist-hermes-q.json") });
  assert.deepEqual(q, { questions: [] });
});

test("loadQuestions tolerates a corrupt file", () => {
  const file = tmpFile();
  writeFileSync(file, "{not json at all");
  const q = loadQuestions({ file });
  assert.deepEqual(q, { questions: [] });
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("loadQuestions tolerates a well-formed JSON file missing the questions array", () => {
  const file = tmpFile();
  writeFileSync(file, JSON.stringify({ somethingElse: true }));
  const q = loadQuestions({ file });
  assert.deepEqual(q, { questions: [] });
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("saveQuestions round-trips through loadQuestions", () => {
  const file = tmpFile();
  const data = { questions: [newQuestion({ sessionId: "sess-1", repoKey: "rn", issue: 27, question: "Ship it?", recommended: "yes", now: FIXED })] };
  saveQuestions(data, { file });
  const loaded = loadQuestions({ file });
  assert.deepEqual(loaded, data);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("saveQuestions creates the parent directory if missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hermes-questions-"));
  const file = path.join(dir, "nested", "deeper", "hermes-questions.json");
  saveQuestions({ questions: [] }, { file });
  assert.deepEqual(loadQuestions({ file }), { questions: [] });
  rmSync(dir, { recursive: true, force: true });
});

test("saveQuestions writes 0600 state in a 0700 directory and tightens rewrites", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hermes-questions-mode-"));
  const file = path.join(root, "state", "hermes-questions.json");
  const previousUmask = process.umask(0o000);
  try {
    saveQuestions({ questions: [] }, { file });
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o666);
    saveQuestions({ questions: [] }, { file });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    process.umask(previousUmask);
    rmSync(root, { recursive: true, force: true });
  }
});

// ── newQuestion: shape ────────────────────────────────────────────────────────
test("newQuestion builds the full Question shape with a q-<8 hex> id and pending status", () => {
  const q = newQuestion({
    sessionId: "sess-abc123", repoKey: "rn", issue: 27,
    question: "Merge now or wait for CI?", recommended: "wait for CI",
    context: "CI is at 90%", now: FIXED,
  });
  assert.match(q.id, /^q-[0-9a-f]{8}$/);
  assert.equal(q.sessionId, "sess-abc123");
  assert.equal(q.repoKey, "rn");
  assert.equal(q.issue, 27);
  assert.equal(q.question, "Merge now or wait for CI?");
  assert.equal(q.recommended, "wait for CI");
  assert.equal(q.context, "CI is at 90%");
  assert.equal(q.status, "pending");
  assert.equal(q.answer, null);
  assert.equal(q.askedAt, FIXED.toISOString());
  assert.equal(q.answeredAt, null);
  assert.equal(q.tgMessageId, null);
});

test("newQuestion defaults context to null when omitted", () => {
  const q = newQuestion({ sessionId: "s", repoKey: "rn", issue: 1, question: "q?", recommended: "r", now: FIXED });
  assert.equal(q.context, null);
});

test("newQuestion mints distinct ids across calls", () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    ids.add(newQuestion({ sessionId: "s", repoKey: "rn", issue: 1, question: "q", recommended: "r" }).id);
  }
  assert.equal(ids.size, 50);
});

// ── addQuestion / getQuestion ─────────────────────────────────────────────────
test("addQuestion appends without mutating the input data", () => {
  const data = { questions: [] };
  const q = newQuestion({ sessionId: "s", repoKey: "rn", issue: 1, question: "q", recommended: "r", now: FIXED });
  const next = addQuestion(data, q);
  assert.deepEqual(data.questions, []); // original untouched
  assert.equal(next.questions.length, 1);
  assert.equal(getQuestion(next, q.id), next.questions[0]);
});

test("getQuestion returns undefined for an unknown id", () => {
  assert.equal(getQuestion({ questions: [] }, "q-deadbeef"), undefined);
});

// ── setAnswer: pure, immutable ────────────────────────────────────────────────
test("setAnswer returns a NEW data object and does not mutate the input", () => {
  const q = newQuestion({ sessionId: "s", repoKey: "rn", issue: 1, question: "q", recommended: "r", now: FIXED });
  const data = addQuestion({ questions: [] }, q);
  const frozenQuestions = JSON.parse(JSON.stringify(data.questions));

  const next = setAnswer(data, q.id, "yes, ship it", FIXED);

  // Input untouched (deep structural check, not just reference).
  assert.deepEqual(data.questions, frozenQuestions);
  assert.notEqual(next, data);
  assert.notEqual(next.questions, data.questions);

  const answered = getQuestion(next, q.id);
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "yes, ship it");
  assert.equal(answered.answeredAt, FIXED.toISOString());
});

test("setAnswer leaves other questions in the store untouched", () => {
  const q1 = newQuestion({ sessionId: "s", repoKey: "rn", issue: 1, question: "q1", recommended: "r1", now: FIXED });
  const q2 = newQuestion({ sessionId: "s", repoKey: "rn", issue: 2, question: "q2", recommended: "r2", now: FIXED });
  let data = addQuestion(addQuestion({ questions: [] }, q1), q2);
  data = setAnswer(data, q1.id, "answer1", FIXED);
  assert.equal(getQuestion(data, q1.id).status, "answered");
  assert.equal(getQuestion(data, q2.id).status, "pending");
});

// ── setTgMessageId ─────────────────────────────────────────────────────────────
test("setTgMessageId records the Telegram message id without mutating input", () => {
  const q = newQuestion({ sessionId: "s", repoKey: "rn", issue: 1, question: "q", recommended: "r", now: FIXED });
  const data = addQuestion({ questions: [] }, q);
  const next = setTgMessageId(data, q.id, 12345);
  assert.equal(getQuestion(data, q.id).tgMessageId, null); // input untouched
  assert.equal(getQuestion(next, q.id).tgMessageId, 12345);
});

// ── expireQuestion ─────────────────────────────────────────────────────────────
test("expireQuestion marks a question expired with an answeredAt timestamp", () => {
  const q = newQuestion({ sessionId: "s", repoKey: "rn", issue: 1, question: "q", recommended: "r", now: FIXED });
  const data = addQuestion({ questions: [] }, q);
  const next = expireQuestion(data, q.id, FIXED);
  assert.equal(getQuestion(data, q.id).status, "pending"); // input untouched
  const expired = getQuestion(next, q.id);
  assert.equal(expired.status, "expired");
  assert.equal(expired.answeredAt, FIXED.toISOString());
});

// ── pendingQuestions: filter + oldest-first ordering ─────────────────────────
test("pendingQuestions returns only pending questions, oldest first", () => {
  const t1 = new Date(2026, 5, 21, 9, 0);
  const t2 = new Date(2026, 5, 21, 9, 5);
  const t3 = new Date(2026, 5, 21, 9, 10);
  const qNew = newQuestion({ sessionId: "s", repoKey: "rn", issue: 1, question: "newest", recommended: "r", now: t3 });
  const qOld = newQuestion({ sessionId: "s", repoKey: "rn", issue: 2, question: "oldest", recommended: "r", now: t1 });
  const qMid = newQuestion({ sessionId: "s", repoKey: "rn", issue: 3, question: "mid", recommended: "r", now: t2 });
  let data = { questions: [] };
  data = addQuestion(data, qNew);
  data = addQuestion(data, qOld);
  data = addQuestion(data, qMid);
  data = setAnswer(data, qMid.id, "answered so excluded", t2); // answered → excluded from pending

  const pending = pendingQuestions(data);
  assert.deepEqual(pending.map((q) => q.question), ["oldest", "newest"]);
});

test("pendingQuestions returns [] when there are no questions", () => {
  assert.deepEqual(pendingQuestions({ questions: [] }), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderLedger,
  parseLedger,
  emptyLedger,
  isLedgerComment,
  ledgerSessionId,
  appendQuestion,
  answerQuestion,
  addDecision,
  addAssumption,
  setHandoffNote,
  setOutcome,
  setStatus,
} from "../lib/ledger.mjs";

test("render(emptyLedger) then parse round-trips deep-equal", () => {
  const ledger = emptyLedger({ sessionId: "sess-abc123", role: "implementer", engine: "codex" });
  const md = renderLedger(ledger);
  const parsed = parseLedger(md);
  assert.deepEqual(parsed, ledger);
});

test("a full ledger round-trips: decisions, assumptions, questions, handoff note, outcome", () => {
  let ledger = emptyLedger({ sessionId: "sess-full1", role: "auditor", engine: "claude" });
  ledger = setStatus(ledger, "waiting-input");
  ledger = { ...ledger, worktree: "/tmp/wt/hermes-wt-1", engineSessionId: "eng-999", branch: "phone/foo-abcd1234" };
  ledger = addDecision(ledger, "Use REST+ETag polling, never gh issue list");
  ledger = addDecision(ledger, "Codex global slot = 1");
  ledger = addAssumption(ledger, "assumed: owner wants codex as default because config says so");
  ledger = addAssumption(ledger, "assumed: worktree survives restart because it's on disk");
  ledger = appendQuestion(ledger, {
    id: "q-1",
    askedAt: "2026-07-06T10:00:00Z",
    question: "Should we merge now?",
  });
  ledger = answerQuestion(ledger, "q-1", "yes, go ahead", "2026-07-06T10:05:00Z");
  ledger = appendQuestion(ledger, {
    id: "q-2",
    askedAt: "2026-07-06T11:00:00Z",
    question: "Which engine for the fixer?",
  });
  ledger = setHandoffNote(
    ledger,
    "Picked up mid-implementation.\n\nWorktree already has the migration written; just needs tests."
  );
  ledger = setOutcome(ledger, "https://github.com/OWNER/example-app/pull/42");

  const md = renderLedger(ledger);
  const parsed = parseLedger(md);
  assert.deepEqual(parsed, ledger);
});

test("parse tolerates \\r\\n line endings", () => {
  const ledger = emptyLedger({ sessionId: "sess-crlf", role: "griller", engine: "codex" });
  const withDecision = addDecision(ledger, "one decision");
  const md = renderLedger(withDecision).replace(/\n/g, "\r\n");
  const parsed = parseLedger(md);
  assert.deepEqual(parsed, withDecision);
});

test("parse tolerates reordered sections", () => {
  const ledger = emptyLedger({ sessionId: "sess-reorder", role: "fixer", engine: "codex" });
  let full = addDecision(ledger, "decision A");
  full = addAssumption(full, "assumed: X because Y");
  full = setOutcome(full, "parked: waiting on owner");
  full = setHandoffNote(full, "continue from here");

  const md = renderLedger(full);
  // Split into header/title/status/meta preamble vs the `####` sections, then shuffle sections.
  const lines = md.split("\n");
  const firstSectionIdx = lines.findIndex((l) => l.startsWith("#### "));
  const preamble = lines.slice(0, firstSectionIdx).join("\n");

  const sectionBlocks = [];
  let current = null;
  for (const line of lines.slice(firstSectionIdx)) {
    if (line.startsWith("#### ")) {
      current = [line];
      sectionBlocks.push(current);
    } else if (current) {
      current.push(line);
    }
  }
  // Reverse section order (Outcome, Handoff note, Questions, Assumptions, Decisions).
  const reordered = [...sectionBlocks].reverse().map((b) => b.join("\n")).join("\n");
  const reorderedMd = preamble + "\n" + reordered;

  const parsed = parseLedger(reorderedMd);
  assert.deepEqual(parsed, full);
});

test("parse returns null on a random comment", () => {
  assert.equal(parseLedger("just a regular comment"), null);
});

test("parse returns null on malformed/missing header variants", () => {
  assert.equal(parseLedger(""), null);
  assert.equal(parseLedger("<!-- not-a-ledger-header -->\n### whatever"), null);
  assert.equal(parseLedger(null), null);
  assert.equal(parseLedger(undefined), null);
});

test("isLedgerComment / ledgerSessionId happy path", () => {
  const ledger = emptyLedger({ sessionId: "sess-happy", role: "implementer", engine: "codex" });
  const md = renderLedger(ledger);
  assert.equal(isLedgerComment(md), true);
  assert.equal(ledgerSessionId(md), "sess-happy");
});

test("isLedgerComment / ledgerSessionId hostile paths", () => {
  assert.equal(isLedgerComment("just a regular comment"), false);
  assert.equal(isLedgerComment(""), false);
  assert.equal(isLedgerComment(null), false);
  assert.equal(isLedgerComment(undefined), false);
  assert.equal(isLedgerComment(123), false);

  assert.equal(ledgerSessionId("just a regular comment"), null);
  assert.equal(ledgerSessionId(""), null);
  assert.equal(ledgerSessionId(null), null);
  assert.equal(ledgerSessionId(undefined), null);

  // A comment that merely mentions the marker text mid-body (not on the first line) doesn't count.
  const notFirstLine = "hello\n<!-- hermes-ledger v1 session=sess-x -->";
  assert.equal(isLedgerComment(notFirstLine), false);
  assert.equal(ledgerSessionId(notFirstLine), null);
});

test("question text containing double quotes round-trips", () => {
  let ledger = emptyLedger({ sessionId: "sess-quotes", role: "griller", engine: "claude" });
  ledger = appendQuestion(ledger, {
    id: "q-quote",
    askedAt: "2026-07-06T09:00:00Z",
    question: 'Should the label be "ready" or "blocked"?',
  });
  ledger = answerQuestion(ledger, "q-quote", 'Use "ready" for now', "2026-07-06T09:10:00Z");

  const md = renderLedger(ledger);
  const parsed = parseLedger(md);

  // Documented escape strategy: inner double quotes are folded to single quotes at render time,
  // so the round-trip is on the FOLDED text, not the original bytes.
  const expectedQuestion = "Should the label be 'ready' or 'blocked'?";
  const expectedAnswer = "Use 'ready' for now";
  assert.equal(parsed.questions[0].question, expectedQuestion);
  assert.equal(parsed.questions[0].answer, expectedAnswer);

  // Re-rendering the parsed ledger is now a stable fixed point (idempotent).
  const md2 = renderLedger(parsed);
  assert.equal(md2, md);
});

test("mutators do not mutate their input", () => {
  const ledger = emptyLedger({ sessionId: "sess-immut", role: "implementer", engine: "codex" });
  const snapshotBefore = JSON.parse(JSON.stringify(ledger));

  const withDecision = addDecision(ledger, "a decision");
  const withAssumption = addAssumption(ledger, "assumed: X because Y");
  const withQuestion = appendQuestion(ledger, { id: "q-1", askedAt: "t0", question: "q?" });
  const withHandoff = setHandoffNote(ledger, "note");
  const withOutcome = setOutcome(ledger, "outcome");
  const withStatus = setStatus(ledger, "done");

  assert.deepEqual(ledger, snapshotBefore);
  assert.notEqual(withDecision, ledger);
  assert.notEqual(withAssumption, ledger);
  assert.notEqual(withQuestion, ledger);
  assert.notEqual(withHandoff, ledger);
  assert.notEqual(withOutcome, ledger);
  assert.notEqual(withStatus, ledger);

  // answerQuestion must not mutate the ledger it's given either, nor the question objects within.
  const questioned = appendQuestion(ledger, { id: "q-2", askedAt: "t0", question: "q2?" });
  const questionedSnapshot = JSON.parse(JSON.stringify(questioned));
  const answered = answerQuestion(questioned, "q-2", "a2", "t1");
  assert.deepEqual(questioned, questionedSnapshot);
  assert.notEqual(answered, questioned);
  assert.equal(questioned.questions[0].answer, null);
  assert.equal(answered.questions[0].answer, "a2");
});

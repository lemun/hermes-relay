// The pending-question store for the ratification relay (docs/architecture.md "State files" +
// "ask_owner relay protocol"; vocabulary from CONTEXT.md — a "question" carries a recommended
// answer and travels to the owner's phone; the answer travels back to unblock the waiting
// session). State file state/hermes-questions.json, shape `{ questions: [Question] }`.
//
// Pure + injectable (file/now params) so this is unit-tested without touching real state, same
// pattern as the other private state modules. Every mutator here is PURE: it takes a data object
// and returns a NEW data object — callers persist via saveQuestions. Only load/save touch disk,
// and writes are atomic (writeJsonAtomic) so a crash mid-write never corrupts the store — this
// file is read by the bot on every /answer poll and must never be seen half-written.

import { randomBytes } from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { ROOT } from "./runtime.mjs";
import { ensurePrivateDirectory, writePrivateJsonAtomic } from "./private-storage.mjs";

export const QUESTIONS_FILE = path.join(ROOT, "state", "hermes-questions.json");

// Tolerant load: missing or corrupt file → a clean empty shape, never a throw. The bot's poll
// loop and the MCP server's answer-poll both call this constantly; a transient torn read (mid
// atomic-rename on some filesystem) must degrade to "no questions yet", not crash the caller.
export function loadQuestions({ file = QUESTIONS_FILE } = {}) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || !Array.isArray(data.questions)) return { questions: [] };
    return data;
  } catch {
    return { questions: [] };
  }
}

export function saveQuestions(data, { file = QUESTIONS_FILE } = {}) {
  ensurePrivateDirectory(path.dirname(file));
  writePrivateJsonAtomic(file, data);
}

// Build a new pending Question. id is `q-<8 hex chars>` — short enough for Telegram callback_data
// (ask:yes:<qid> etc. must stay under Telegram's 64-byte limit per docs/architecture.md) and for
// the ledger comment's `[q-id]` markers. `now` is injectable for deterministic tests.
export function newQuestion({ sessionId, repoKey, issue, question, recommended, context, now } = {}) {
  const id = `q-${randomBytes(4).toString("hex")}`;
  const askedAt = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
  return {
    id,
    sessionId,
    repoKey,
    issue,
    question,
    recommended,
    context: context ?? null,
    status: "pending",
    answer: null,
    askedAt,
    answeredAt: null,
    tgMessageId: null,
  };
}

// Append a question to the store. Pure — returns a NEW data object; does not mutate `data`.
export function addQuestion(data, q) {
  return { ...data, questions: [...(data.questions || []), q] };
}

export function getQuestion(data, id) {
  return (data.questions || []).find((q) => q.id === id);
}

// Mark a question answered. Pure — the input `data` (and its question objects) are never
// mutated; only the matching entry is replaced in the returned copy.
export function setAnswer(data, id, answer, now) {
  const answeredAt = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
  return {
    ...data,
    questions: (data.questions || []).map((q) =>
      q.id === id ? { ...q, status: "answered", answer, answeredAt } : q,
    ),
  };
}

// Record the Telegram question-card message id (so a later edit-in-place / callback can find it).
export function setTgMessageId(data, id, msgId) {
  return {
    ...data,
    questions: (data.questions || []).map((q) => (q.id === id ? { ...q, tgMessageId: msgId } : q)),
  };
}

export function expireQuestion(data, id, now) {
  const answeredAt = (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();
  return {
    ...data,
    questions: (data.questions || []).map((q) =>
      q.id === id ? { ...q, status: "expired", answeredAt } : q,
    ),
  };
}

// All pending questions, oldest-first (askedAt ascending) — the order the inbox and any
// "waiting-input" recovery scan should present them in.
export function pendingQuestions(data) {
  return (data.questions || [])
    .filter((q) => q.status === "pending")
    .sort((a, b) => (a.askedAt || "").localeCompare(b.askedAt || ""));
}

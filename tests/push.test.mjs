import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadPushSeen, savePushSeen, cardAlertText, cardAlertKbd, parsePushCallback, runPushTick,
} from "../lib/push.mjs";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "hermes-push-")), "seen.json");

// The gatherBoardSignals pending shape.
const card = (over = {}) => ({
  interactionId: "int-1",
  kind: "request_confirmation",
  title: "Approve the launch email",
  issueIdentifier: "HOM-27",
  issueTitle: "Ship the EN onboarding flow",
  ...over,
});

// ── parsePushCallback: strict parsing, malformed → null ──────────────────────
test("parsePushCallback parses accept/reject/info and rejects malformed data", () => {
  assert.deepEqual(parsePushCallback("pcard:accept:27"), { verb: "accept", num: "27" });
  assert.deepEqual(parsePushCallback("pcard:reject:27"), { verb: "reject", num: "27" });
  assert.deepEqual(parsePushCallback("pcard:info:12"), { info: true, num: "12" });
  // malformed / hostile inputs all fail closed
  assert.equal(parsePushCallback("pcard:accept:"), null);       // no number
  assert.equal(parsePushCallback("pcard:accept:HOM"), null);    // non-digit
  assert.equal(parsePushCallback("pcard:accept:2a7"), null);    // partly non-digit
  assert.equal(parsePushCallback("pcard:frobnicate:27"), null); // bad verb
  assert.equal(parsePushCallback("act:go:abcd1234"), null);     // wrong namespace
  assert.equal(parsePushCallback("pcard:accept"), null);        // too few parts
  assert.equal(parsePushCallback(""), null);
  assert.equal(parsePushCallback(undefined), null);
});

// ── cardAlertKbd: callback-data format, digits extraction, null fallback ─────
test("cardAlertKbd builds pcard:* rows with the extracted issue number", () => {
  const rows = cardAlertKbd(card());
  assert.deepEqual(rows, [
    [["✅ Approve", "pcard:accept:27"], ["✖️ Reject", "pcard:reject:27"]],
    [["ℹ️ Tell me more", "pcard:info:27"]],
  ]);
  // "#12" style identifier → digits "12"
  assert.deepEqual(cardAlertKbd(card({ issueIdentifier: "#12" }))[0][0], ["✅ Approve", "pcard:accept:12"]);
});

test("cardAlertKbd callback data stays well under Telegram's 64-byte limit", () => {
  for (const row of cardAlertKbd(card({ issueIdentifier: "HOM-99999" }))) {
    for (const [, data] of row) assert.ok(Buffer.byteLength(data, "utf8") < 64, data);
  }
});

test("cardAlertKbd returns null when no digits can be extracted (never a broken button)", () => {
  assert.equal(cardAlertKbd(card({ issueIdentifier: "HOM-ABC" })), null);
  assert.equal(cardAlertKbd(card({ issueIdentifier: "" })), null);
  assert.equal(cardAlertKbd(card({ issueIdentifier: undefined })), null);
});

// ── cardAlertText: format + defensive truncation ─────────────────────────────
test("cardAlertText formats the alert with identifier, title, and issue title", () => {
  const t = cardAlertText(card());
  assert.equal(t, "🔔 Needs you · HOM-27\nApprove the launch email\non: Ship the EN onboarding flow");
});

test("cardAlertText defensively truncates a runaway title and issueTitle", () => {
  const t = cardAlertText(card({ title: "x".repeat(500), issueTitle: "y".repeat(500) }));
  const lines = t.split("\n");
  assert.ok(lines[1].length <= 201, `title line ${lines[1].length}`); // ~200 + ellipsis
  assert.ok(t.length < 500);
  assert.match(lines[1], /…$/);
});

test("cardAlertText clips a runaway issueIdentifier too (defense in depth)", () => {
  const t = cardAlertText(card({ issueIdentifier: "Z".repeat(100) }));
  const header = t.split("\n")[0];
  assert.ok(header.length <= "🔔 Needs you · ".length + 41, `header ${header.length}`); // 40 + ellipsis
  assert.match(header, /…$/);
});

// ── loadPushSeen / savePushSeen: tolerant JSON state ─────────────────────────
test("loadPushSeen tolerates a missing file", () => {
  const seen = loadPushSeen({ file: path.join(tmpdir(), "does-not-exist-abc123.json") });
  assert.equal(seen.firstRunDone, false);
  assert.deepEqual(seen.interactions, []);
});

test("loadPushSeen tolerates a corrupt file (returns a clean shape)", () => {
  const file = tmpFile();
  writeFileSync(file, "{not json at all");
  const seen = loadPushSeen({ file });
  assert.equal(seen.firstRunDone, false);
  assert.deepEqual(seen.interactions, []);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("savePushSeen round-trips through loadPushSeen and caps interactions to 300", () => {
  const file = tmpFile();
  const many = Array.from({ length: 350 }, (_, i) => `int-${i}`);
  savePushSeen({ firstRunDone: true, interactions: many }, { file });
  const seen = loadPushSeen({ file });
  assert.equal(seen.firstRunDone, true);
  assert.equal(seen.interactions.length, 300);
  assert.equal(seen.interactions[0], "int-50");            // oldest 50 dropped (kept the last 300)
  assert.equal(seen.interactions.at(-1), "int-349");
  rmSync(path.dirname(file), { recursive: true, force: true });
});

// ── runPushTick: first run seeds silently, then sends once per new card ───────
test("runPushTick first run seeds ALL pending silently (no sends) and sets firstRunDone", async () => {
  const sent = [];
  const gather = async () => ({ pending: [card({ interactionId: "a" }), card({ interactionId: "b" })] });
  const send = async (c) => { sent.push(c.interactionId); };
  const { seen, sent: count } = await runPushTick({ seen: loadPushSeen({ file: tmpFile() }), gather, send });
  assert.equal(count, 0);              // NEVER page for pre-existing cards on first deploy
  assert.equal(sent.length, 0);
  assert.equal(seen.firstRunDone, true);
  assert.deepEqual(seen.interactions.sort(), ["a", "b"]);
});

test("runPushTick second tick sends exactly once per NEW card and dedupes seen ones", async () => {
  const sent = [];
  const send = async (c) => { sent.push(c.interactionId); };
  // First run seeds card "a".
  let gather = async () => ({ pending: [card({ interactionId: "a" })] });
  let { seen } = await runPushTick({ seen: { firstRunDone: false, interactions: [] }, gather, send });
  assert.equal(sent.length, 0);

  // Now "a" is still pending (already seen) + a NEW card "b" → only "b" pages.
  gather = async () => ({ pending: [card({ interactionId: "a" }), card({ interactionId: "b" })] });
  ({ seen } = await runPushTick({ seen, gather, send }));
  assert.deepEqual(sent, ["b"]);
  assert.ok(seen.interactions.includes("a") && seen.interactions.includes("b"));

  // A third tick with nothing new sends nothing.
  const res = await runPushTick({ seen, gather, send });
  assert.equal(res.sent, 0);
  assert.deepEqual(sent, ["b"]);
});

test("runPushTick sends a duplicated interactionId within one gather only once", async () => {
  const sent = [];
  const send = async (c) => { sent.push(c.interactionId); };
  const gather = async () => ({ pending: [card({ interactionId: "dup" }), card({ interactionId: "dup" })] });
  const { sent: count } = await runPushTick({ seen: { firstRunDone: true, interactions: [] }, gather, send });
  assert.equal(count, 1);
  assert.deepEqual(sent, ["dup"]);
});

test("runPushTick propagates a gather() throw and leaves seen untouched", async () => {
  const seenIn = { firstRunDone: true, interactions: ["x"] };
  const gather = async () => { throw new Error("board hiccup"); };
  const send = async () => { throw new Error("should never send"); };
  await assert.rejects(() => runPushTick({ seen: seenIn, gather, send }), /board hiccup/);
  assert.deepEqual(seenIn.interactions, ["x"]); // unchanged
});

test("runPushTick marks only successfully-sent cards seen; a failed send retries next tick", async () => {
  const sent = [];
  // "b" fails this tick (Telegram blip); "a" and "c" deliver.
  const send = async (c) => { if (c.interactionId === "b") throw new Error("telegram blip"); sent.push(c.interactionId); };
  const gather = async () => ({ pending: [card({ interactionId: "a" }), card({ interactionId: "b" }), card({ interactionId: "c" })] });
  const { seen, sent: ok, failed } = await runPushTick({ seen: { firstRunDone: true, interactions: [] }, gather, send });
  assert.equal(ok, 2);
  assert.equal(failed, 1);
  assert.deepEqual(sent, ["a", "c"]);
  // Successes are seen (no duplicate alerts next tick); the failure is NOT (so it retries).
  assert.ok(seen.interactions.includes("a") && seen.interactions.includes("c"));
  assert.ok(!seen.interactions.includes("b"));

  // Next tick: only "b" goes out.
  const again = await runPushTick({ seen, gather, send: async (c) => { sent.push(c.interactionId); } });
  assert.equal(again.sent, 1);
  assert.deepEqual(sent, ["a", "c", "b"]);
});

test("runPushTick keeps the interactions list capped at 300", async () => {
  const send = async () => {};
  const seed = Array.from({ length: 299 }, (_, i) => `old-${i}`);
  const gather = async () => ({ pending: [card({ interactionId: "n1" }), card({ interactionId: "n2" })] });
  const { seen } = await runPushTick({ seen: { firstRunDone: true, interactions: seed }, gather, send });
  assert.equal(seen.interactions.length, 300);
  assert.equal(seen.interactions.at(-1), "n2"); // newest survives
  assert.ok(!seen.interactions.includes("old-0")); // oldest trimmed
});

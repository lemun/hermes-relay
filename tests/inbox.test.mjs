import test from "node:test";
import assert from "node:assert/strict";
import {
  renderInbox, questionCardText, questionCardKbd, parseAskCallback,
  morningDigestText, digestDue,
} from "../lib/inbox.mjs";

const NOW = new Date("2026-07-06T12:00:00Z");
const q = (over = {}) => ({
  id: "q-ab12cd34", sessionId: "sess-11223344", repoKey: "rn", issue: 42,
  question: "Should the login flow keep the phone-number step?",
  recommended: "Yes — keep it, OTP depends on it.",
  askedAt: "2026-07-06T10:00:00Z", status: "pending", ...over,
});

test("renderInbox: inbox zero and N-waiting shapes", () => {
  assert.match(renderInbox([], NOW), /Inbox zero/);
  const text = renderInbox([q(), q({ id: "q-ffffffff", issue: 7 })], NOW);
  assert.match(text, /^🔔 2 waiting/);
  assert.match(text, /rn#42 \(2h\): Should the login flow/);
  assert.match(text, /rn#7 /);
});

test("questionCardText carries question and recommended answer", () => {
  const t = questionCardText(q());
  assert.match(t, /❓ rn#42/);
  assert.match(t, /Should the login flow/);
  assert.match(t, /💡 Recommended: Yes — keep it/);
});

test("questionCardKbd: three buttons, callback_data ≤64 bytes", () => {
  const rows = questionCardKbd(q());
  const flat = rows.flat();
  assert.equal(flat.length, 3);
  assert.deepEqual(flat.map(([, data]) => data), [
    "ask:yes:q-ab12cd34", "ask:other:q-ab12cd34", "ask:explain:q-ab12cd34",
  ]);
  for (const [, data] of flat) assert.ok(Buffer.byteLength(data) <= 64);
  // long recommended answers are truncated on the button, never in the card
  const longRec = questionCardKbd(q({ recommended: "x".repeat(200) }));
  assert.ok(longRec[0][0][0].length < 40);
});

test("parseAskCallback: happy and hostile paths", () => {
  assert.deepEqual(parseAskCallback("ask:yes:q-ab12cd34"), { verb: "yes", id: "q-ab12cd34" });
  assert.deepEqual(parseAskCallback("ask:explain:q-00000000"), { verb: "explain", id: "q-00000000" });
  assert.equal(parseAskCallback("ask:frob:q-ab12cd34"), null);
  assert.equal(parseAskCallback("ask:yes:sess-ab12cd34"), null);
  assert.equal(parseAskCallback("pcard:accept:27"), null);
  assert.equal(parseAskCallback(""), null);
  assert.equal(parseAskCallback(null), null);
});

test("morningDigestText lists questions and running sessions", () => {
  const t = morningDigestText({
    pending: [q()],
    running: [{ repoKey: "next", issue: 9, role: "implementer", engine: "codex" }],
  }, NOW);
  assert.match(t, /Morning digest/);
  assert.match(t, /1 question waiting/);
  assert.match(t, /next#9 implementer \(codex\)/);
});

test("digestDue: fires once per local day at/after the hour", () => {
  const at9 = new Date(2026, 6, 6, 9, 5);
  const today = "2026-07-06";
  assert.equal(digestDue({ lastDigestDate: "2026-07-05", hour: 8, now: at9 }), true);
  assert.equal(digestDue({ lastDigestDate: today, hour: 8, now: at9 }), false);
  assert.equal(digestDue({ lastDigestDate: "2026-07-05", hour: 8, now: new Date(2026, 6, 6, 7, 0) }), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { lastFencedJson } from "../lib/fenced-json.mjs";

test("lastFencedJson: plain block, prose-wrapped, last-of-many", () => {
  assert.deepEqual(lastFencedJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(lastFencedJson('prose\n```json\n{"a":1}\n```\ntrailing'), { a: 1 });
  assert.deepEqual(lastFencedJson('```json\n{"a":1}\n```\nmid\n```json\n{"b":2}\n```'), { b: 2 });
});

test("lastFencedJson: payload containing its OWN fences survives (rn#280 regression)", () => {
  const prBody = "**What changed:**\n\nStuff.\n\n```bash\nnpm test\n```\n\nCloses #280";
  const text = "Done.\n```json\n" + JSON.stringify({ done: true, prBody, summary: "s" }) + "\n```";
  const parsed = lastFencedJson(text);
  assert.equal(parsed.done, true);
  assert.equal(parsed.prBody, prBody);
});

test("lastFencedJson: braces and escaped quotes inside strings don't break balancing", () => {
  const obj = { s: 'he said "x{y}z" \\ done', n: { deep: "{{{" } };
  const parsed = lastFencedJson("```json\n" + JSON.stringify(obj) + "\n```");
  assert.deepEqual(parsed, obj);
});

test("lastFencedJson: null on garbage, empty, missing marker, unbalanced", () => {
  assert.equal(lastFencedJson("no json here"), null);
  assert.equal(lastFencedJson(""), null);
  assert.equal(lastFencedJson(null), null);
  assert.equal(lastFencedJson('```json\n{"never":closes'), null);
});

test("lastFencedJson: falls back to an earlier marker when the last one is malformed", () => {
  const text = '```json\n{"good":true}\n```\nlater...\n```json\n{"bad": unparseable}\n```';
  assert.deepEqual(lastFencedJson(text), { good: true });
});

test("lastFencedJson: parses the REAL rn#280 last-message that the old regex choked on", (t) => {
  const file = "/path/to/hermes-relay/logs/sessions/sess-50137287/last-message.txt";
  if (!fs.existsSync(file)) return t.skip("live artifact not on this machine");
  const parsed = lastFencedJson(fs.readFileSync(file, "utf8"));
  assert.ok(parsed && parsed.done === true, "the live artifact must parse as done:true");
});

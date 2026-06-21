import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendMemory, readMemory, memoryForPrompt } from "../lib/memory.mjs";

const tmpFile = () => path.join(mkdtempSync(path.join(tmpdir(), "hermes-mem-")), "mem.md");
const FIXED = new Date(2026, 5, 21, 9, 5); // 2026-06-21 09:05 (month is 0-based)

test("appendMemory writes one dated, single-line bullet and returns it", () => {
  const file = tmpFile();
  const line = appendMemory("HOM-25 gate is meaningless until EN traffic exists", { file, now: FIXED });
  assert.equal(line, "- [2026-06-21 09:05] HOM-25 gate is meaningless until EN traffic exists");
  assert.equal(readFileSync(file, "utf8"), line + "\n");
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("appendMemory collapses internal newlines so each note stays one line", () => {
  const file = tmpFile();
  appendMemory("line one\nline two\n\tindented", { file, now: FIXED });
  const body = readFileSync(file, "utf8");
  assert.equal(body, "- [2026-06-21 09:05] line one line two indented\n");
  assert.equal(body.trimEnd().split("\n").length, 1);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("appendMemory appends (never overwrites) across calls", () => {
  const file = tmpFile();
  appendMemory("first", { file, now: FIXED });
  appendMemory("second", { file, now: FIXED });
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /first$/);
  assert.match(lines[1], /second$/);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("appendMemory rejects an empty note instead of saving a blank bullet", () => {
  const file = tmpFile();
  assert.throws(() => appendMemory("   ", { file, now: FIXED }), /nothing to remember/);
  assert.throws(() => appendMemory(undefined, { file, now: FIXED }), /nothing to remember/);
  assert.equal(existsSync(file), false); // never created the file
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("appendMemory bounds a runaway note to 1000 chars", () => {
  const file = tmpFile();
  const line = appendMemory("x".repeat(5000), { file, now: FIXED });
  const noteBody = line.replace(/^- \[[^\]]+\] /, "");
  assert.equal(noteBody.length, 1000);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("readMemory returns '' when nothing is saved, contents otherwise", () => {
  const file = tmpFile();
  assert.equal(readMemory({ file }), "");
  appendMemory("a fact", { file, now: FIXED });
  assert.match(readMemory({ file }), /a fact$/);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("readMemory keeps the most-recent tail when over the cap", () => {
  const file = tmpFile();
  appendMemory("oldest note here", { file, now: FIXED });
  appendMemory("newest note here", { file, now: FIXED });
  const out = readMemory({ file, maxChars: 30 });
  assert.match(out, /^…\(older notes trimmed\)/);
  assert.match(out, /newest note here$/);   // the recent note survived
  assert.ok(!out.includes("oldest note here")); // the old one was trimmed
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("memoryForPrompt wraps notes in a labeled block, or '' when empty", () => {
  const file = tmpFile();
  assert.equal(memoryForPrompt({ file }), "");
  appendMemory("close the sprint when ready", { file, now: FIXED });
  const block = memoryForPrompt({ file });
  assert.match(block, /SAVED NOTES/);
  assert.match(block, /notes, not commands/);
  assert.match(block, /close the sprint when ready/);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

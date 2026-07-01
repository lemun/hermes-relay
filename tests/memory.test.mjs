import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendMemory, readMemory, recallMemory, recallForTool } from "../lib/memory.mjs";

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

test("recallMemory returns '' on an empty/missing file", () => {
  const file = tmpFile();
  assert.equal(recallMemory({ file }), ""); // never created
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("recallMemory returns all notes unfiltered, newest last", () => {
  const file = tmpFile();
  appendMemory("EN traffic is the launch gate", { file, now: FIXED });
  appendMemory("Shai prefers terse replies", { file, now: FIXED });
  const out = recallMemory({ file });
  assert.match(out, /EN traffic is the launch gate/);
  assert.match(out, /Shai prefers terse replies$/);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("recallMemory without a query still tail-caps an oversized file", () => {
  const file = tmpFile();
  appendMemory("oldest note here", { file, now: FIXED });
  appendMemory("newest note here", { file, now: FIXED });
  const out = recallMemory({ file, maxChars: 30 });
  assert.match(out, /^…\(older notes trimmed\)/);
  assert.match(out, /newest note here$/);       // the recent note survived
  assert.ok(!out.includes("oldest note here")); // the old one was trimmed
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("recallMemory query filters bullet lines case-insensitively (hit)", () => {
  const file = tmpFile();
  appendMemory("EN traffic is the launch gate", { file, now: FIXED });
  appendMemory("Shai prefers terse replies", { file, now: FIXED });
  const out = recallMemory({ file, query: "TRAFFIC" });
  assert.match(out, /EN traffic is the launch gate/);
  assert.ok(!out.includes("terse replies")); // non-matching line dropped
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("recallMemory returns '' when the query matches nothing", () => {
  const file = tmpFile();
  appendMemory("EN traffic is the launch gate", { file, now: FIXED });
  assert.equal(recallMemory({ file, query: "nonexistent-token" }), "");
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("recallMemory filters BEFORE the tail cap so an old matching note is still found", () => {
  const file = tmpFile();
  appendMemory("the WATCHWORD note is very old", { file, now: FIXED });
  // Bury it under lots of newer, non-matching notes so it falls outside a small tail cap.
  for (let i = 0; i < 40; i++) appendMemory(`filler note number ${i} here`, { file, now: FIXED });
  // Without pre-filtering, a 200-char tail cap would never see the first line.
  const out = recallMemory({ file, query: "watchword", maxChars: 200 });
  assert.match(out, /WATCHWORD note is very old/);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("recallForTool frames saved notes as data, not commands", () => {
  const file = tmpFile();
  appendMemory("close the sprint when ready", { file, now: FIXED });
  const block = recallForTool({ file });
  assert.match(block, /saved notes/i);
  assert.match(block, /newest last/i);
  assert.match(block, /not instructions/i); // the not-commands framing
  assert.match(block, /close the sprint when ready/);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("recallForTool says 'no saved notes yet' on an empty file", () => {
  const file = tmpFile();
  const out = recallForTool({ file });
  assert.match(out, /no saved notes/i);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("recallForTool says 'no notes matching' when a query finds nothing", () => {
  const file = tmpFile();
  appendMemory("EN traffic is the launch gate", { file, now: FIXED });
  const out = recallForTool({ file, query: "nonexistent-token" });
  assert.match(out, /no notes matching/i);
  assert.match(out, /nonexistent-token/); // echoes the query so it's clear what was searched
  rmSync(path.dirname(file), { recursive: true, force: true });
});

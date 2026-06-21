import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, buildSessionArgs, finalizeResult, EFFORTS } from "../lib/coder.mjs";

test("slugify produces a safe, bounded branch fragment", () => {
  assert.equal(slugify("Refactor the Onboarding screen!"), "refactor-the-onboarding-screen");
  assert.equal(slugify("   "), "task");
  assert.equal(slugify(""), "task");
  assert.equal(slugify(undefined), "task");
  assert.equal(slugify("a".repeat(100)).length, 30);          // capped
  assert.match(slugify("HOM-27: fix /api?x=1"), /^[a-z0-9-]+$/); // only url-safe chars
  assert.equal(/^-|-$/.test(slugify("--lead--")), false);     // no leading/trailing dash
});

test("buildSessionArgs always enables write access via worktree-scoped bypass", () => {
  const a = buildSessionArgs({ prompt: "do it", modelId: "claude-sonnet-4-6", effort: "high", worktreePath: "/wt", sessionId: "sid-1", resume: false });
  assert.ok(a.includes("--effort") && a[a.indexOf("--effort") + 1] === "high");
  assert.ok(a.includes("--permission-mode") && a[a.indexOf("--permission-mode") + 1] === "bypassPermissions");
  assert.ok(a.includes("--dangerously-skip-permissions"));
  assert.ok(a.includes("--add-dir") && a[a.indexOf("--add-dir") + 1] === "/wt");
  assert.ok(a.includes("--output-format") && a[a.indexOf("--output-format") + 1] === "stream-json");
  assert.ok(a.includes("--model") && a[a.indexOf("--model") + 1] === "claude-sonnet-4-6");
});

test("buildSessionArgs starts a fresh session with --session-id, not --resume", () => {
  const fresh = buildSessionArgs({ prompt: "p", modelId: "m", effort: "max", worktreePath: "/wt", sessionId: "sid-2", resume: false });
  assert.ok(fresh.includes("--session-id") && fresh[fresh.indexOf("--session-id") + 1] === "sid-2");
  assert.equal(fresh.includes("--resume"), false);
});

test("buildSessionArgs resumes with --resume on the prior session id", () => {
  const resumed = buildSessionArgs({ prompt: "p", modelId: "m", effort: "low", worktreePath: "/wt", sessionId: "sid-3", resume: true });
  assert.ok(resumed.includes("--resume") && resumed[resumed.indexOf("--resume") + 1] === "sid-3");
  assert.equal(resumed.includes("--session-id"), false);
});

test("EFFORTS exposes the CLI's effort levels", () => {
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
});

test("finalizeResult: ok only on a clean, uninterrupted exit", () => {
  const base = { exitCode: 0, isError: false, canceled: false, timedOut: false, baseSha: "a", headSha: "b", diffNames: "x.js" };
  assert.equal(finalizeResult(base).ok, true);
  assert.equal(finalizeResult({ ...base, exitCode: 1 }).ok, false);
  assert.equal(finalizeResult({ ...base, isError: true }).ok, false);
  assert.equal(finalizeResult({ ...base, canceled: true }).ok, false);
  assert.equal(finalizeResult({ ...base, timedOut: true }).ok, false);
});

test("finalizeResult: counts changed files and detects no-op (same sha) runs", () => {
  assert.equal(finalizeResult({ exitCode: 0, baseSha: "a", headSha: "b", diffNames: "x.js\ny.ts\nz.md" }).filesChanged, 3);
  // empty diff name list → zero files
  assert.equal(finalizeResult({ exitCode: 0, baseSha: "a", headSha: "b", diffNames: "" }).filesChanged, 0);
  // head === base → nothing changed, regardless of any stray diffNames
  const same = finalizeResult({ exitCode: 0, baseSha: "a", headSha: "a", diffNames: "x.js" });
  assert.equal(same.changed, false);
  assert.equal(same.filesChanged, 0);
});

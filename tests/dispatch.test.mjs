import { test } from "node:test";
import assert from "node:assert/strict";
import {
  engineForIssue,
  slugForIssue,
  worktreeBranchFor,
  createWorktree,
  buildImplementerPrompt,
  parseImplementerResult,
  pushAndOpenPr,
  dispatchLabelTransitions,
  prOpenedLabelTransitions,
} from "../lib/dispatch.mjs";

// ── engineForIssue ───────────────────────────────────────────────────────────

test("engineForIssue: label override beats the default", () => {
  assert.equal(engineForIssue({ labels: ["engine:claude"] }, "codex"), "claude");
  assert.equal(engineForIssue({ labels: ["engine:codex"] }, "claude"), "codex");
});

test("engineForIssue: falls through to defaultEngine when no engine label is present", () => {
  assert.equal(engineForIssue({ labels: ["ready"] }, "codex"), "codex");
  assert.equal(engineForIssue({ labels: [] }, "claude"), "claude");
  assert.equal(engineForIssue({ labels: undefined }, "codex"), "codex");
});

test("engineForIssue: defaults defaultEngine param to codex", () => {
  assert.equal(engineForIssue({ labels: [] }), "codex");
});

// ── slugForIssue ─────────────────────────────────────────────────────────────

test("slugForIssue: produces a bounded, url-safe slug from the title", () => {
  assert.equal(slugForIssue({ title: "Add Dark Mode Toggle!" }), "add-dark-mode-toggle");
  assert.match(slugForIssue({ title: "HOM-27: fix /api?x=1" }), /^[a-z0-9-]+$/);
  assert.ok(slugForIssue({ title: "a".repeat(100) }).length <= 40);
  assert.equal(slugForIssue({ title: "" }), "issue");
  assert.equal(slugForIssue({ title: undefined }), "issue");
});

// ── worktreeBranchFor ────────────────────────────────────────────────────────

test("worktreeBranchFor: shapes branch and dirName using injected randomness", () => {
  const fakeRandom = () => ({ toString: () => "ab12" });
  const result = worktreeBranchFor({
    repoKey: "rn",
    issue: { number: 42, title: "Add dark mode toggle" },
    randomImpl: fakeRandom,
  });
  assert.equal(result.branch, "hermes/42-add-dark-mode-toggle");
  assert.equal(result.dirName, "hermes-wt-hermes-rn-42-ab12");
});

test("worktreeBranchFor: defaults to real crypto.randomBytes producing 4 hex chars", () => {
  const result = worktreeBranchFor({ repoKey: "next", issue: { number: 7, title: "Fix crash" } });
  assert.equal(result.branch, "hermes/7-fix-crash");
  assert.match(result.dirName, /^hermes-wt-hermes-next-7-[0-9a-f]{4}$/);
});

// ── createWorktree ───────────────────────────────────────────────────────────

function makeExecLog() {
  const calls = [];
  const execImpl = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === "fetch") return { code: 1, stdout: "", stderr: "offline" }; // tolerated failure
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "origin/main\n", stderr: "" };
    if (args.includes("add")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, execImpl };
}

test("createWorktree: issues fetch (tolerated failure), symbolic-ref resolve, then worktree add in order", async () => {
  const { calls, execImpl } = makeExecLog();
  const result = await createWorktree({
    repoPath: "/repo",
    worktreeBase: "/wts",
    branch: "hermes/42-add-dark-mode-toggle",
    dirName: "hermes-wt-hermes-rn-42-ab12",
    execImpl,
  });

  assert.deepEqual(calls[0], ["git", "-C", "/repo", "fetch", "origin"]);
  assert.deepEqual(calls[1], ["git", "-C", "/repo", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  assert.deepEqual(calls[2], [
    "git", "-C", "/repo", "worktree", "add",
    "/wts/hermes-wt-hermes-rn-42-ab12", "-b", "hermes/42-add-dark-mode-toggle", "origin/main",
  ]);
  assert.deepEqual(result, { worktree: "/wts/hermes-wt-hermes-rn-42-ab12", branch: "hermes/42-add-dark-mode-toggle" });
});

test("createWorktree: falls back to origin/main when symbolic-ref fails", async () => {
  const execImpl = async (bin, args) => {
    if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
    if (args.includes("symbolic-ref")) return { code: 1, stdout: "", stderr: "no such ref" };
    if (args.includes("add")) return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await createWorktree({
    repoPath: "/repo", worktreeBase: "/wts", branch: "hermes/1-x", dirName: "dir-1", execImpl,
  });
  assert.equal(result.worktree, "/wts/dir-1");
});

test("createWorktree: fetch failure never prevents worktree creation (tolerated as offline)", async () => {
  const { execImpl } = makeExecLog();
  const result = await createWorktree({
    repoPath: "/repo", worktreeBase: "/wts", branch: "hermes/1-x", dirName: "dir-1", execImpl,
  });
  assert.ok(result.worktree);
});

test("createWorktree: throws with the git stderr when worktree add fails", async () => {
  const execImpl = async (bin, args) => {
    if (args[0] === "fetch") return { code: 0, stdout: "", stderr: "" };
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "origin/main\n", stderr: "" };
    if (args.includes("add")) return { code: 1, stdout: "", stderr: "fatal: branch already exists" };
    return { code: 0, stdout: "", stderr: "" };
  };
  await assert.rejects(
    createWorktree({ repoPath: "/repo", worktreeBase: "/wts", branch: "hermes/1-x", dirName: "dir-1", execImpl }),
    /fatal: branch already exists/
  );
});

// ── buildImplementerPrompt ───────────────────────────────────────────────────

const ISSUE = { number: 42, title: "Add dark mode toggle", body: "Users want a dark mode." };

test("buildImplementerPrompt: contains binding decisions/assumptions/handoff before the issue body and the dispatch contract", () => {
  const prompt = buildImplementerPrompt({
    issue: ISSUE,
    repoSlug: "lemun/example-app",
    decisions: ["use AsyncStorage for persistence"],
    assumptions: ["assumed: no server sync needed because issue only mentions local persistence"],
    handoffNote: "touch SettingsScreen.tsx",
  });

  assert.ok(prompt.includes("issue #42"));
  assert.ok(prompt.includes("lemun/example-app"));
  assert.ok(prompt.includes("use AsyncStorage for persistence"));
  assert.ok(prompt.includes("assumed: no server sync needed"));
  assert.ok(prompt.includes("touch SettingsScreen.tsx"));
  assert.ok(prompt.includes(ISSUE.body));
  assert.ok(/BINDING/.test(prompt));

  const iDecisions = prompt.indexOf("use AsyncStorage for persistence");
  const iBody = prompt.indexOf(ISSUE.body);
  const iNoPush = prompt.indexOf("Do NOT git push");
  assert.ok(iDecisions < iBody, "decisions/assumptions/handoff come before the issue body");
  assert.ok(iBody < iNoPush, "issue body comes before the dispatch contract");
});

test("buildImplementerPrompt: states the no-network/no-push/no-PR contract", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });
  assert.ok(/NO network access/i.test(prompt));
  assert.ok(prompt.includes("Do NOT git push"));
  assert.ok(/do not open a pr/i.test(prompt));
  assert.ok(/hub does both/i.test(prompt));
});

test("buildImplementerPrompt: mandates lint, typecheck, and tests before declaring done", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });
  assert.ok(/lint/i.test(prompt));
  assert.ok(/typecheck/i.test(prompt));
  assert.ok(/tests/i.test(prompt));
});

test("buildImplementerPrompt: mentions ask_owner for owner-class mid-implementation decisions", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });
  assert.ok(prompt.includes("mcp__hermes__ask_owner"));
});

test("buildImplementerPrompt: ends with the fenced json result contract", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });
  for (const key of ["done", "summary", "assumptions", "blockedReason"]) {
    assert.ok(prompt.includes(`"${key}"`));
  }
});

test("buildImplementerPrompt: handles empty decisions/assumptions/handoffNote gracefully", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });
  assert.ok(prompt.includes("_none recorded_"));
});

// ── parseImplementerResult ───────────────────────────────────────────────────

test("parseImplementerResult: happy path", () => {
  const text = "```json\n" + JSON.stringify({ done: true, summary: "added toggle", assumptions: [], blockedReason: null }) + "\n```";
  assert.deepEqual(parseImplementerResult(text), { done: true, summary: "added toggle", assumptions: [], blockedReason: null });
});

test("parseImplementerResult: returns null when there's no parseable json block", () => {
  assert.equal(parseImplementerResult("no json here"), null);
  assert.equal(parseImplementerResult(""), null);
  assert.equal(parseImplementerResult(null), null);
});

// ── pushAndOpenPr ─────────────────────────────────────────────────────────────

test("pushAndOpenPr: success parses the PR number and url from gh's stdout", async () => {
  const execImpl = async (bin, args) => {
    if (bin === "git") return { code: 0, stdout: "", stderr: "" };
    if (bin === "gh") return { code: 0, stdout: "https://github.com/owner/repo/pull/123\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected bin" };
  };
  const result = await pushAndOpenPr({
    worktree: "/wt", branch: "hermes/42-x", repoSlug: "owner/repo",
    issue: { number: 42, title: "Add dark mode toggle" }, summary: "did the thing", execImpl,
  });
  assert.deepEqual(result, { prNumber: 123, url: "https://github.com/owner/repo/pull/123" });
});

test("pushAndOpenPr: passes the expected git push and gh pr create argv", async () => {
  const calls = [];
  const execImpl = async (bin, args) => {
    calls.push([bin, ...args]);
    if (bin === "git") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "https://github.com/owner/repo/pull/9\n", stderr: "" };
  };
  await pushAndOpenPr({
    worktree: "/wt", branch: "hermes/42-x", repoSlug: "owner/repo",
    issue: { number: 42, title: "Add dark mode toggle" }, summary: "did the thing", execImpl,
  });
  assert.deepEqual(calls[0], ["git", "-C", "/wt", "push", "-u", "origin", "hermes/42-x"]);
  assert.deepEqual(calls[1], [
    "gh", "pr", "create", "--repo", "owner/repo", "--head", "hermes/42-x",
    "--title", "Add dark mode toggle (#42)", "--body", "did the thing\n\nCloses #42",
  ]);
});

test("pushAndOpenPr: git push failure returns {error} without throwing", async () => {
  const execImpl = async (bin) => {
    if (bin === "git") return { code: 1, stdout: "", stderr: "! [rejected] hermes/42-x -> hermes/42-x (fetch first)" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await pushAndOpenPr({
    worktree: "/wt", branch: "hermes/42-x", repoSlug: "owner/repo",
    issue: { number: 42, title: "x" }, summary: "s", execImpl,
  });
  assert.ok(result.error);
  assert.equal(result.prNumber, undefined);
});

test("pushAndOpenPr: gh pr create failure returns {error} without throwing", async () => {
  const execImpl = async (bin) => {
    if (bin === "git") return { code: 0, stdout: "", stderr: "" };
    if (bin === "gh") return { code: 1, stdout: "", stderr: "pull request create failed: GraphQL error" };
    return { code: 1, stdout: "", stderr: "" };
  };
  const result = await pushAndOpenPr({
    worktree: "/wt", branch: "hermes/42-x", repoSlug: "owner/repo",
    issue: { number: 42, title: "x" }, summary: "s", execImpl,
  });
  assert.ok(result.error);
  assert.match(result.error, /GraphQL error/);
});

// ── label transitions ─────────────────────────────────────────────────────────

test("dispatchLabelTransitions: implementing added, ready removed", () => {
  assert.deepEqual(dispatchLabelTransitions(), { add: ["implementing"], remove: ["ready"] });
});

test("prOpenedLabelTransitions: pr-open added, implementing removed", () => {
  assert.deepEqual(prOpenedLabelTransitions(), { add: ["pr-open"], remove: ["implementing"] });
});

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
  warmWorktree,
  commitWorktree,
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
  const iNoPush = prompt.indexOf("Do NOT git commit, git push");
  assert.ok(iDecisions < iBody, "decisions/assumptions/handoff come before the issue body");
  assert.ok(iBody < iNoPush, "issue body comes before the dispatch contract");
});

test("buildImplementerPrompt: states the no-network/no-commit/no-push/no-PR contract", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });
  assert.ok(/NO network access/i.test(prompt));
  // sessions cannot commit (worktree gitdir is outside the sandbox) — the hub does
  assert.ok(prompt.includes("Do NOT git commit, git push, or open a PR"));
  assert.ok(/hub commits and pushes/i.test(prompt));
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
  for (const key of ["done", "summary", "issueProposals", "commentProposals", "assumptions", "blockedReason"]) {
    assert.ok(prompt.includes(`"${key}"`));
  }
});

test("buildImplementerPrompt: follow-ups are proposal-only and never direct GitHub writes", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });

  assert.match(prompt, /proposals?/i);
  assert.match(prompt, /(?:never|do not|will not)[^\n]*(?:file|create|post|write)/i);
  assert.doesNotMatch(prompt, /"issuesToCreate"/);
  assert.doesNotMatch(prompt, /"comments"/);
});

test("buildImplementerPrompt: handles empty decisions/assumptions/handoffNote gracefully", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });
  assert.ok(prompt.includes("_none recorded_"));
});

// ── parseImplementerResult ───────────────────────────────────────────────────

test("parseImplementerResult: happy path", () => {
  const text = "```json\n" + JSON.stringify({
    done: true,
    summary: "added toggle",
    issueProposals: [{ title: "Follow-up", body: "Body", labels: ["ready"] }],
    commentProposals: [{ issue: 42, body: "Done" }],
    assumptions: [],
    blockedReason: null,
  }) + "\n```";
  assert.deepEqual(parseImplementerResult(text), {
    done: true,
    summary: "added toggle",
    prTitle: "",
    prBody: "",
    issueProposals: [{ title: "Follow-up", body: "Body", labels: ["ready"] }],
    commentProposals: [{ issue: 42, body: "Done" }],
    assumptions: [],
    blockedReason: null,
  });
});

test("parseImplementerResult: legacy write-shaped fields are normalized into inert proposals", () => {
  const issueProposal = { title: "Injected", body: "Do not file", labels: ["ready"], repo: "attacker/repo" };
  const commentProposal = { issue: 1, body: "Do not post", repo: "attacker/repo" };
  const result = parseImplementerResult("```json\n" + JSON.stringify({
    done: true,
    summary: "attempted hostile emissions",
    issuesToCreate: [issueProposal],
    comments: [commentProposal],
  }) + "\n```");

  assert.deepEqual(result.issueProposals, [issueProposal]);
  assert.deepEqual(result.commentProposals, [commentProposal]);
  assert.equal(Object.hasOwn(result, "issuesToCreate"), false);
  assert.equal(Object.hasOwn(result, "comments"), false);
});

test("parseImplementerResult: malformed proposal fields stay inert and default to empty arrays", () => {
  const result = parseImplementerResult('```json\n{"done":true,"issueProposals":{"title":"not an array"},"commentProposals":"post me"}\n```');

  assert.deepEqual(result.issueProposals, []);
  assert.deepEqual(result.commentProposals, []);
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

test("prOpenedLabelTransitions: pr-open added, implementing and ready removed", () => {
  assert.deepEqual(prOpenedLabelTransitions(), { add: ["pr-open"], remove: ["implementing", "ready"] });
});

test("warmWorktree: clones node_modules via APFS clonefile, non-fatal on absence/failure", async () => {
  const calls = [];
  const mk = (codes) => async (bin, args) => { calls.push([bin, ...args]); return { code: codes.shift(), stdout: "", stderr: "boom" }; };

  let r = await warmWorktree({ repoPath: "/repo", worktree: "/wt", execImpl: mk([0, 0]) });
  assert.deepEqual(r, { warmed: true });
  assert.deepEqual(calls[0], ["test", "-d", "/repo/node_modules"]);
  assert.deepEqual(calls[1], ["cp", "-Rc", "/repo/node_modules", "/wt/node_modules"]);

  r = await warmWorktree({ repoPath: "/repo", worktree: "/wt", execImpl: mk([1]) });
  assert.equal(r.warmed, false);
  assert.match(r.reason, /no node_modules/);

  r = await warmWorktree({ repoPath: "/repo", worktree: "/wt", execImpl: mk([0, 1]) });
  assert.equal(r.warmed, false);
  assert.match(r.reason, /boom/);
});

test("commitWorktree: commits dirty worktrees, no-ops on clean, surfaces git failures", async () => {
  const mk = (script) => async (bin, args) => script.shift()(bin, args);
  const ok = (stdout = "") => () => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr) => () => ({ code: 1, stdout: "", stderr });

  let argv = [];
  let r = await commitWorktree({
    worktree: "/wt", message: "msg (#7)",
    execImpl: async (bin, args) => { argv.push(args.join(" ")); return { code: 0, stdout: args.includes("status") ? " M file.ts" : "", stderr: "" }; },
  });
  assert.deepEqual(r, { committed: true });
  assert.match(argv[1], /add -A/);
  assert.match(argv[2], /commit -m msg \(#7\)/);

  r = await commitWorktree({ worktree: "/wt", message: "m", execImpl: mk([ok("")]) });
  assert.deepEqual(r, { committed: false, reason: "clean" });

  r = await commitWorktree({ worktree: "/wt", message: "m", execImpl: mk([ok(" M f"), ok(), fail("hook rejected")]) });
  assert.equal(r.committed, false);
  assert.match(r.reason, /hook rejected/);
});

test("pushAndOpenPr: session-authored prTitle/prBody win; Closes #N is guaranteed", async () => {
  const mk = () => {
    const calls = [];
    const execImpl = async (bin, args) => {
      calls.push([bin, ...args]);
      if (bin === "gh") return { code: 0, stdout: "https://github.com/o/r/pull/55\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { calls, execImpl };
  };

  // authored body already contains Closes → used verbatim
  let { calls, execImpl } = mk();
  await pushAndOpenPr({
    worktree: "/wt", branch: "b", repoSlug: "o/r", issue: { number: 7, title: "T" },
    summary: "s", prTitle: "Clarify the thing", prBody: "**What changed:**\nWords.\n\nCloses #7", execImpl,
  });
  let gh = calls.find((c) => c[0] === "gh");
  assert.equal(gh[gh.indexOf("--title") + 1], "Clarify the thing");
  assert.equal(gh[gh.indexOf("--body") + 1], "**What changed:**\nWords.\n\nCloses #7");

  // authored body forgot Closes → appended
  ({ calls, execImpl } = mk());
  await pushAndOpenPr({
    worktree: "/wt", branch: "b", repoSlug: "o/r", issue: { number: 7, title: "T" },
    summary: "s", prTitle: "Clarify", prBody: "Body without footer", execImpl,
  });
  gh = calls.find((c) => c[0] === "gh");
  assert.match(gh[gh.indexOf("--body") + 1], /Body without footer[\s\S]*Closes #7/);

  // nothing authored → legacy fallback shape
  ({ calls, execImpl } = mk());
  await pushAndOpenPr({
    worktree: "/wt", branch: "b", repoSlug: "o/r", issue: { number: 7, title: "T" }, summary: "sum", execImpl,
  });
  gh = calls.find((c) => c[0] === "gh");
  assert.equal(gh[gh.indexOf("--title") + 1], "T (#7)");
  assert.match(gh[gh.indexOf("--body") + 1], /sum[\s\S]*Closes #7/);
});

test("parseImplementerResult: carries prTitle/prBody, defaults to empty strings", () => {
  const r = parseImplementerResult('```json\n{"done":true,"summary":"s","prTitle":"T","prBody":"B"}\n```');
  assert.equal(r.prTitle, "T");
  assert.equal(r.prBody, "B");
  const legacy = parseImplementerResult('```json\n{"done":true,"summary":"s"}\n```');
  assert.equal(legacy.prTitle, "");
  assert.equal(legacy.prBody, "");
});

test("buildImplementerPrompt: instructs authoring the PR per the repo template", () => {
  const prompt = buildImplementerPrompt({ issue: ISSUE, repoSlug: "r/r", decisions: [], assumptions: [], handoffNote: "" });
  assert.match(prompt, /PULL_REQUEST_TEMPLATE\.md/);
  assert.match(prompt, /Closes #42/);
  assert.match(prompt, /"prTitle"/);
  assert.match(prompt, /"prBody"/);
});

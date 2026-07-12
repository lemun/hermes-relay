import { test } from "node:test";
import assert from "node:assert/strict";
import { GITHUB_READ_TOOLS, createGitHubReadExecutor } from "../hermes-github-read-mcp.mjs";

const ALLOWED_REPOS = [
  "lemun/example-app",
  "lemun/example-web",
];

test("GitHub read executor rejects an outside-repo issue view before invoking gh", async () => {
  const calls = [];
  const execute = createGitHubReadExecutor({
    allowedRepos: ALLOWED_REPOS,
    execFileImpl: (...args) => calls.push(args),
  });

  await assert.rejects(
    execute("issue_view", { repo: "private/other-repo", number: 42 }),
    /repository is not configured/i,
  );
  assert.deepEqual(calls, []);
});

test("GitHub read executor views an issue in a configured repo with fixed argv", async () => {
  const calls = [];
  const execute = createGitHubReadExecutor({
    allowedRepos: ALLOWED_REPOS,
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, '{"number":42}', "");
    },
  });

  const result = await execute("issue_view", {
    repo: "lemun/example-app",
    number: 42,
  });

  assert.equal(result, '{"number":42}');
  assert.deepEqual(calls, [{
    file: "gh",
    args: [
      "issue", "view", "42",
      "--repo", "lemun/example-app",
      "--json", "number,title,body,state,labels,assignees,url,comments",
    ],
    options: { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
  }]);
});

test("GitHub read executor exposes only fixed list, view, diff, and search argv", async () => {
  const calls = [];
  const execute = createGitHubReadExecutor({
    allowedRepos: ALLOWED_REPOS,
    execFileImpl: (file, args, options, callback) => {
      calls.push([file, ...args]);
      callback(null, "[]", "");
    },
  });

  await execute("issue_list", { repo: ALLOWED_REPOS[0], state: "open", limit: 20 });
  await execute("pr_list", { repo: ALLOWED_REPOS[0], state: "closed", limit: 10 });
  await execute("pr_view", { repo: ALLOWED_REPOS[1], number: 7 });
  await execute("pr_diff", { repo: ALLOWED_REPOS[1], number: 7 });
  await execute("search_issues", { repo: ALLOWED_REPOS[0], query: "login crash", limit: 15 });
  await execute("search_prs", { repo: ALLOWED_REPOS[1], query: "billing fix", limit: 5 });

  assert.deepEqual(calls, [
    ["gh", "issue", "list", "--repo", ALLOWED_REPOS[0], "--state", "open", "--limit", "20", "--json", "number,title,state,labels,assignees,url,updatedAt"],
    ["gh", "pr", "list", "--repo", ALLOWED_REPOS[0], "--state", "closed", "--limit", "10", "--json", "number,title,state,isDraft,author,labels,url,updatedAt"],
    ["gh", "pr", "view", "7", "--repo", ALLOWED_REPOS[1], "--json", "number,title,body,state,isDraft,author,labels,baseRefName,headRefName,url,comments,reviews"],
    ["gh", "pr", "diff", "7", "--repo", ALLOWED_REPOS[1], "--color", "never"],
    ["gh", "search", "issues", "login crash", "--repo", ALLOWED_REPOS[0], "--limit", "15", "--json", "number,title,state,url,updatedAt"],
    ["gh", "search", "prs", "billing fix", "--repo", ALLOWED_REPOS[1], "--limit", "5", "--json", "number,title,state,url,updatedAt"],
  ]);
});

test("GitHub read executor fails closed for outside repos, malformed slugs, and argument injection", async () => {
  const calls = [];
  const execute = createGitHubReadExecutor({
    allowedRepos: ALLOWED_REPOS,
    execFileImpl: (...args) => calls.push(args),
  });
  const attempts = [
    ["issue_list", { repo: "private/secrets" }],
    ["pr_view", { repo: "private/secrets", number: 1 }],
    ["pr_diff", { repo: "private/secrets", number: 1 }],
    ["search_issues", { repo: "private/secrets", query: "token" }],
    ["issue_view", { repo: "lemun/example-app/extra", number: 1 }],
    ["issue_view", { repo: "--repo/private", number: 1 }],
    ["issue_view", { repo: "lemun/example-app\n--repo private/secrets", number: 1 }],
    ["issue_view", { repo: ALLOWED_REPOS[0], number: "1 --repo private/secrets" }],
    ["issue_view", { repo: ALLOWED_REPOS[0], number: 1, args: ["--repo", "private/secrets"] }],
    ["search_prs", { repo: ALLOWED_REPOS[0], query: "fix repo:private/secrets" }],
    ["search_prs", { repo: ALLOWED_REPOS[0], query: "fix --repo private/secrets" }],
    ["api", { repo: ALLOWED_REPOS[0], path: "repos/private/secrets" }],
    ["shell", { repo: ALLOWED_REPOS[0], command: "gh api user" }],
    ["node", { repo: ALLOWED_REPOS[0], code: "process.env" }],
  ];

  for (const [tool, input] of attempts) {
    await assert.rejects(execute(tool, input));
  }
  assert.deepEqual(calls, []);
});

test("GitHub read executor rejects a malformed configured allowlist at construction", () => {
  assert.throws(
    () => createGitHubReadExecutor({ allowedRepos: ["lemun/good", "../bad"] }),
    /malformed/i,
  );
});

test("GitHub read MCP manifest has only structured read tools and no generic command fields", () => {
  assert.deepEqual(
    GITHUB_READ_TOOLS.map((tool) => tool.name),
    ["issue_list", "issue_view", "pr_list", "pr_view", "pr_diff", "search_issues", "search_prs"],
  );
  for (const tool of GITHUB_READ_TOOLS) {
    const properties = Object.keys(tool.inputSchema.properties);
    assert.ok(properties.includes("repo"));
    for (const escape of ["args", "argv", "command", "path", "endpoint", "api", "shell", "code"]) {
      assert.equal(properties.includes(escape), false, `${tool.name} must not expose ${escape}`);
    }
  }
  assert.ok(Object.isFrozen(GITHUB_READ_TOOLS));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFilingPrompt,
  parseFiledIssue,
  FILED_ISSUE_LABELS,
  buildIssueChatSystem,
  ISSUE_CHAT_ALLOWED_TOOLS,
} from "../lib/filing.mjs";

const REPOS = {
  rn: { slug: "lemun/example-app", label: "React Native app" },
  next: { slug: "lemun/example-web", label: "Next.js web" },
};

// ── buildFilingPrompt ────────────────────────────────────────────────────────

test("buildFilingPrompt: includes the dictated text and lists repos with their labels", () => {
  const prompt = buildFilingPrompt({ text: "the login button is broken on android", repos: REPOS });
  assert.ok(prompt.includes("the login button is broken on android"));
  assert.ok(prompt.includes("rn — React Native app"));
  assert.ok(prompt.includes("next — Next.js web"));
});

test("buildFilingPrompt: instructs a bounded imperative title and Problem/Expected/Context body sections", () => {
  const prompt = buildFilingPrompt({ text: "voice note text", repos: REPOS });
  assert.ok(/70 characters/.test(prompt));
  assert.ok(/Problem/.test(prompt));
  assert.ok(/Expected/.test(prompt));
  assert.ok(/Context/.test(prompt));
});

test("buildFilingPrompt: allows null repoKey for genuine ambiguity", () => {
  const prompt = buildFilingPrompt({ text: "something broke", repos: REPOS });
  assert.ok(/null/.test(prompt));
});

test("buildFilingPrompt: ends with the fenced json contract naming title/body/repoKey", () => {
  const prompt = buildFilingPrompt({ text: "x", repos: REPOS });
  assert.ok(prompt.includes("```json"));
  for (const key of ["title", "body", "repoKey"]) {
    assert.ok(prompt.includes(`"${key}"`));
  }
});

test("buildFilingPrompt: tolerates an empty repos map", () => {
  const prompt = buildFilingPrompt({ text: "x", repos: {} });
  assert.ok(prompt.includes("x"));
});

// ── parseFiledIssue ──────────────────────────────────────────────────────────

test("parseFiledIssue: happy path", () => {
  const text = [
    "Here's the shaped issue.",
    "```json",
    JSON.stringify({
      title: "Fix Android login button crash",
      body: "### Problem\nLogin button crashes.\n### Expected\nIt should log in.\n### Context\nAndroid only.",
      repoKey: "rn",
    }),
    "```",
  ].join("\n");
  const result = parseFiledIssue(text);
  assert.equal(result.title, "Fix Android login button crash");
  assert.equal(result.repoKey, "rn");
  assert.ok(result.body.includes("Problem"));
});

test("parseFiledIssue: repoKey null passes through as null", () => {
  const text = "```json\n" + JSON.stringify({ title: "Something ambiguous", body: "b", repoKey: null }) + "\n```";
  const result = parseFiledIssue(text);
  assert.equal(result.repoKey, null);
});

test("parseFiledIssue: hostile input — empty title returns null", () => {
  const text = "```json\n" + JSON.stringify({ title: "", body: "b", repoKey: "rn" }) + "\n```";
  assert.equal(parseFiledIssue(text), null);
});

test("parseFiledIssue: hostile input — whitespace-only title returns null", () => {
  const text = "```json\n" + JSON.stringify({ title: "   ", body: "b", repoKey: "rn" }) + "\n```";
  assert.equal(parseFiledIssue(text), null);
});

test("parseFiledIssue: hostile input — missing title key returns null", () => {
  const text = "```json\n" + JSON.stringify({ body: "b", repoKey: "rn" }) + "\n```";
  assert.equal(parseFiledIssue(text), null);
});

test("parseFiledIssue: no parseable json block returns null", () => {
  assert.equal(parseFiledIssue("just prose"), null);
  assert.equal(parseFiledIssue(""), null);
  assert.equal(parseFiledIssue(null), null);
  assert.equal(parseFiledIssue("```json\n{ broken \n```"), null);
});

// ── FILED_ISSUE_LABELS ───────────────────────────────────────────────────────

test("FILED_ISSUE_LABELS: a freshly filed issue lands with needs-grill", () => {
  assert.deepEqual(FILED_ISSUE_LABELS, ["needs-grill"]);
});

// ── buildIssueChatSystem ─────────────────────────────────────────────────────

test("buildIssueChatSystem: mentions read-only and scopes to the configured repos", () => {
  const system = buildIssueChatSystem({ repos: REPOS });
  assert.ok(/read-only/i.test(system));
  assert.ok(system.includes("lemun/example-app"));
  assert.ok(system.includes("lemun/example-web"));
});

test("buildIssueChatSystem: instructs refusal of off-topic requests", () => {
  const system = buildIssueChatSystem({ repos: REPOS });
  assert.ok(/refuse/i.test(system));
});

test("buildIssueChatSystem: instructs never to mutate anything", () => {
  const system = buildIssueChatSystem({ repos: REPOS });
  assert.ok(/never mutate/i.test(system));
});

test("buildIssueChatSystem: mirrors phone-texting tone rules (plain text, raw urls)", () => {
  const system = buildIssueChatSystem({ repos: REPOS });
  assert.ok(/plain text/i.test(system));
  assert.ok(/raw url/i.test(system));
});

// ── ISSUE_CHAT_ALLOWED_TOOLS ──────────────────────────────────────────────────

test("ISSUE_CHAT_ALLOWED_TOOLS: exact frozen structured GitHub-read whitelist", () => {
  assert.deepEqual(ISSUE_CHAT_ALLOWED_TOOLS, [
    "mcp__github_read__issue_list",
    "mcp__github_read__issue_view",
    "mcp__github_read__pr_list",
    "mcp__github_read__pr_view",
    "mcp__github_read__pr_diff",
    "mcp__github_read__search_issues",
    "mcp__github_read__search_prs",
  ]);
  assert.ok(Object.isFrozen(ISSUE_CHAT_ALLOWED_TOOLS));
  assert.equal(ISSUE_CHAT_ALLOWED_TOOLS.some((tool) => tool.startsWith("Bash(")), false);
});

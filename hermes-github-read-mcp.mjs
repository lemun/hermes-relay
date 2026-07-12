#!/usr/bin/env node

// Narrow read-only GitHub MCP for untrusted issue/chat prompts. Every tool has a structured
// schema; every repo is matched against the configured slug allowlist before fixed `gh` argv is
// constructed. There is intentionally no command, argv, shell, Node, or `gh api` escape hatch.

import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const REPO_SLUG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,38})\/[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/;

const repoProperty = {
  type: "string",
  description: "Exact owner/name slug of a repository configured in Hermes.",
};
const numberProperty = { type: "integer", minimum: 1 };
const stateProperty = { type: "string", enum: ["open", "closed", "all"], default: "open" };
const limitProperty = { type: "integer", minimum: 1, maximum: 100, default: 30 };
const queryProperty = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  description: "Plain search text only; GitHub qualifiers and command-line options are rejected.",
};

function tool(name, description, properties, required = ["repo"]) {
  return Object.freeze({
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { repo: repoProperty, ...properties },
      required,
      additionalProperties: false,
    },
  });
}

export const GITHUB_READ_TOOLS = Object.freeze([
  tool("issue_list", "List issues in one configured repository.", { state: stateProperty, limit: limitProperty }),
  tool("issue_view", "View one issue in a configured repository.", { number: numberProperty }, ["repo", "number"]),
  tool("pr_list", "List pull requests in one configured repository.", { state: stateProperty, limit: limitProperty }),
  tool("pr_view", "View one pull request in a configured repository.", { number: numberProperty }, ["repo", "number"]),
  tool("pr_diff", "Read one pull request diff in a configured repository.", { number: numberProperty }, ["repo", "number"]),
  tool("search_issues", "Search issues by plain text in one configured repository.", { query: queryProperty, limit: limitProperty }, ["repo", "query"]),
  tool("search_prs", "Search pull requests by plain text in one configured repository.", { query: queryProperty, limit: limitProperty }, ["repo", "query"]),
]);

const TOOL_INPUT_KEYS = Object.freeze({
  issue_list: Object.freeze(["repo", "state", "limit"]),
  issue_view: Object.freeze(["repo", "number"]),
  pr_list: Object.freeze(["repo", "state", "limit"]),
  pr_view: Object.freeze(["repo", "number"]),
  pr_diff: Object.freeze(["repo", "number"]),
  search_issues: Object.freeze(["repo", "query", "limit"]),
  search_prs: Object.freeze(["repo", "query", "limit"]),
});

function assertRepoSlug(repo) {
  if (typeof repo !== "string" || !REPO_SLUG_RE.test(repo)) {
    throw new Error("Malformed GitHub repository slug.");
  }
}

function runGh(execFileImpl, args) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      "gh",
      args,
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || "GitHub read failed").trim().slice(0, 500);
          reject(new Error(`GitHub read failed: ${detail}`));
        } else {
          resolve(String(stdout || "").trim());
        }
      },
    );
  });
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return String(value);
}

function listState(value) {
  const state = value ?? "open";
  if (!["open", "closed", "all"].includes(state)) throw new Error("state must be open, closed, or all.");
  return state;
}

function resultLimit(value) {
  const limit = value ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("limit must be an integer from 1 to 100.");
  }
  return String(limit);
}

function searchQuery(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new Error("query must be a non-empty string of at most 200 characters.");
  }
  if (/[:\0\r\n]|--/.test(value) || value.trimStart().startsWith("-")) {
    throw new Error("query contains unsupported search syntax.");
  }
  return value.trim();
}

export function createGitHubReadExecutor({ allowedRepos, execFileImpl = execFile } = {}) {
  if (!Array.isArray(allowedRepos)) throw new Error("allowedRepos must be an array.");
  for (const repo of allowedRepos) assertRepoSlug(repo);
  const allowlist = new Set(allowedRepos);

  return async function execute(toolName, input = {}) {
    const allowedKeys = TOOL_INPUT_KEYS[toolName];
    if (!allowedKeys) throw new Error(`Unsupported GitHub read operation: ${toolName}`);
    const unexpected = Object.keys(input).find((key) => !allowedKeys.includes(key));
    if (unexpected) throw new Error(`Unsupported argument for ${toolName}: ${unexpected}`);
    assertRepoSlug(input.repo);
    if (!allowlist.has(input.repo)) {
      throw new Error(`GitHub repository is not configured: ${input.repo}`);
    }
    let args;
    switch (toolName) {
      case "issue_list":
        args = ["issue", "list", "--repo", input.repo, "--state", listState(input.state), "--limit", resultLimit(input.limit), "--json", "number,title,state,labels,assignees,url,updatedAt"];
        break;
      case "issue_view":
        args = ["issue", "view", positiveInteger(input.number, "number"), "--repo", input.repo, "--json", "number,title,body,state,labels,assignees,url,comments"];
        break;
      case "pr_list":
        args = ["pr", "list", "--repo", input.repo, "--state", listState(input.state), "--limit", resultLimit(input.limit), "--json", "number,title,state,isDraft,author,labels,url,updatedAt"];
        break;
      case "pr_view":
        args = ["pr", "view", positiveInteger(input.number, "number"), "--repo", input.repo, "--json", "number,title,body,state,isDraft,author,labels,baseRefName,headRefName,url,comments,reviews"];
        break;
      case "pr_diff":
        args = ["pr", "diff", positiveInteger(input.number, "number"), "--repo", input.repo, "--color", "never"];
        break;
      case "search_issues":
        args = ["search", "issues", searchQuery(input.query), "--repo", input.repo, "--limit", resultLimit(input.limit), "--json", "number,title,state,url,updatedAt"];
        break;
      case "search_prs":
        args = ["search", "prs", searchQuery(input.query), "--repo", input.repo, "--limit", resultLimit(input.limit), "--json", "number,title,state,url,updatedAt"];
        break;
    }
    return runGh(execFileImpl, args);
  };
}

export async function handleGitHubReadTool(name, args, execute) {
  try {
    const output = await execute(name, args || {});
    return { content: [{ type: "text", text: output || "(no results)" }] };
  } catch (err) {
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
}

async function main() {
  let allowedRepos;
  try {
    allowedRepos = JSON.parse(process.env.HERMES_GITHUB_ALLOWED_REPOS || "null");
  } catch {
    throw new Error("HERMES_GITHUB_ALLOWED_REPOS must be a JSON array.");
  }
  const execute = createGitHubReadExecutor({ allowedRepos });
  const server = new Server(
    { name: "hermes-github-read", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: GITHUB_READ_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    return handleGitHubReadTool(name, args, execute);
  });
  await server.connect(new StdioServerTransport());
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[hermes-github-read-mcp] fatal: ${err.message}\n`);
    process.exit(1);
  });
}

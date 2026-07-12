import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as engineModule from "../lib/engines.mjs";
import {
  GITHUB_READ_ALLOWED_TOOLS,
  GRILLER_ALLOWED_TOOLS,
  AUDITOR_ALLOWED_TOOLS,
  writeSessionMcpConfig,
  writeGitHubReadMcpConfig,
  buildClaudeArgs,
  buildCodexArgs,
  parseCodexThreadId,
  parseClaudeStreamMeta,
  isSilentCodexFailure,
  wrapWithScript,
} from "../lib/engines.mjs";

test("buildChildSessionEnv strips metered and bot secrets for every engine child", () => {
  const env = engineModule.buildChildSessionEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    ANTHROPIC_API_KEY: "metered-anthropic",
    OPENAI_API_KEY: "metered-openai",
    GH_TOKEN: "github-token",
    GITHUB_TOKEN: "github-token-2",
    TELEGRAM_BOT_TOKEN: "telegram-token",
    PAPERCLIP_BOARD_API_KEY: "board-token",
    NTFY_TOPIC: "alerts",
  });

  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/home");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "TELEGRAM_BOT_TOKEN", "PAPERCLIP_BOARD_API_KEY", "NTFY_TOPIC"]) {
    assert.equal(env[key], undefined, `${key} must not reach engine children`);
  }
});

// ── tool whitelists ──────────────────────────────────────────────────────────

test("GRILLER_ALLOWED_TOOLS is frozen and carries the exact static whitelist", () => {
  assert.deepEqual(GRILLER_ALLOWED_TOOLS, [
    "Read",
    "Glob",
    "Grep",
    ...GITHUB_READ_ALLOWED_TOOLS,
    "mcp__hermes__ask_owner",
  ]);
  assert.ok(Object.isFrozen(GRILLER_ALLOWED_TOOLS));
  assert.equal(GRILLER_ALLOWED_TOOLS.some((tool) => tool.startsWith("Bash(")), false);
});

test("AUDITOR_ALLOWED_TOOLS has the same structured GitHub reads and no Bash", () => {
  assert.deepEqual(AUDITOR_ALLOWED_TOOLS, [
    "Read",
    "Glob",
    "Grep",
    ...GITHUB_READ_ALLOWED_TOOLS,
    "mcp__hermes__ask_owner",
  ]);
  assert.ok(Object.isFrozen(AUDITOR_ALLOWED_TOOLS));
  assert.equal(AUDITOR_ALLOWED_TOOLS.some((tool) => tool.startsWith("Bash(")), false);
});

test("session and issue-chat MCP configs carry the exact configured repo allowlist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hermes-github-read-"));
  const allowedRepos = ["lemun/example-app", "lemun/example-web"];
  const sessionPath = writeSessionMcpConfig({
    dir,
    sessionKey: "session-1",
    sockPath: "/tmp/hermes.sock",
    askTimeoutMs: 1000,
    mcpScriptPath: "/app/hermes-ask-mcp.mjs",
    githubRead: { mcpScriptPath: "/app/hermes-github-read-mcp.mjs", allowedRepos },
  });
  const issueChatPath = writeGitHubReadMcpConfig({
    dir,
    mcpScriptPath: "/app/hermes-github-read-mcp.mjs",
    allowedRepos,
  });

  const sessionConfig = JSON.parse(readFileSync(sessionPath, "utf8"));
  const issueChatConfig = JSON.parse(readFileSync(issueChatPath, "utf8"));
  assert.deepEqual(sessionConfig.mcpServers.github_read.env, {
    HERMES_GITHUB_ALLOWED_REPOS: JSON.stringify(allowedRepos),
  });
  assert.deepEqual(issueChatConfig.mcpServers.github_read, sessionConfig.mcpServers.github_read);
});

// ── buildClaudeArgs ──────────────────────────────────────────────────────────

test("buildClaudeArgs: fresh session exact argv snapshot", () => {
  const args = buildClaudeArgs({
    prompt: "do the thing",
    model: "sonnet",
    effort: "high",
    sessionId: "sess-abc123",
    resume: false,
    allowedTools: GRILLER_ALLOWED_TOOLS,
    mcpConfigPath: "/wt/mcp-hermes.json",
    permissionMode: "readonly",
  });
  assert.deepEqual(args, [
    "-p", "do the thing",
    "--output-format", "stream-json",
    "--verbose",
    "--session-id", "sess-abc123",
    "--model", "claude-sonnet-4-6",
    "--effort", "high",
    "--mcp-config", "/wt/mcp-hermes.json",
    "--strict-mcp-config",
    "--allowedTools", ...GRILLER_ALLOWED_TOOLS,
  ]);
});

test("buildClaudeArgs: resume uses --resume with the SAME output format (per task brief)", () => {
  const args = buildClaudeArgs({
    prompt: "owner answered: yes",
    model: "sonnet",
    effort: "high",
    sessionId: "sess-abc123",
    resume: true,
    allowedTools: GRILLER_ALLOWED_TOOLS,
    mcpConfigPath: "/wt/mcp-hermes.json",
  });
  assert.deepEqual(args, [
    "-p", "owner answered: yes",
    "--output-format", "stream-json",
    "--verbose",
    "--resume", "sess-abc123",
    "--model", "claude-sonnet-4-6",
    "--effort", "high",
    "--mcp-config", "/wt/mcp-hermes.json",
    "--strict-mcp-config",
    "--allowedTools", ...GRILLER_ALLOWED_TOOLS,
  ]);
  assert.equal(args.includes("--session-id"), false);
});

test("buildClaudeArgs: bypass permission mode adds bypassPermissions + dangerously-skip-permissions", () => {
  const args = buildClaudeArgs({
    prompt: "implement it",
    model: "opus",
    effort: "max",
    sessionId: "sess-impl",
    resume: false,
    permissionMode: "bypass",
  });
  assert.deepEqual(args, [
    "-p", "implement it",
    "--output-format", "stream-json",
    "--verbose",
    "--session-id", "sess-impl",
    "--model", "claude-opus-4-8",
    "--effort", "max",
    "--permission-mode", "bypassPermissions",
    "--dangerously-skip-permissions",
  ]);
});

test("buildClaudeArgs: non-bypass permission modes never add the escalation flags", () => {
  const args = buildClaudeArgs({ prompt: "p", model: "sonnet", effort: "low", sessionId: "s", resume: false, permissionMode: "readonly" });
  assert.equal(args.includes("--permission-mode"), false);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("buildClaudeArgs: resolves model shortnames via lib/models.mjs MODELS", () => {
  const args = buildClaudeArgs({ prompt: "p", model: "haiku", effort: "low", sessionId: "s", resume: false });
  assert.ok(args.includes("--model") && args[args.indexOf("--model") + 1] === "claude-haiku-4-5-20251001");
});

test("buildClaudeArgs: rejects unsupported model aliases", () => {
  assert.throws(
    () => buildClaudeArgs({ prompt: "p", model: "typo-model", effort: "low", sessionId: "s", resume: false }),
    /Unsupported Claude model alias: typo-model/,
  );
});

test("buildClaudeArgs: omits --mcp-config and --allowedTools when not given", () => {
  const args = buildClaudeArgs({ prompt: "p", model: "sonnet", effort: "low", sessionId: "s", resume: false });
  assert.equal(args.includes("--mcp-config"), false);
  assert.equal(args.includes("--allowedTools"), false);
});

// ── buildCodexArgs ───────────────────────────────────────────────────────────

test("buildCodexArgs: fresh argv contains the workspace-write sandbox flags and TOML overrides", () => {
  const args = buildCodexArgs({
    prompt: "implement HOM-27",
    worktree: "/path/to/wt/hermes-wt-1",
    lastMessageFile: "/path/to/logs/sessions/sess-1/last-message.txt",
    sessionKey: "sess-1",
    sockPath: "/path/to/state/hermes-ask.sock",
    askTimeoutMs: 28800000,
    mcpScriptPath: "/path/to/lib/hermes-ask-mcp.mjs",
    resume: false,
  });

  assert.equal(args[0], "exec");
  assert.ok(args.includes("-C") && args[args.indexOf("-C") + 1] === "/path/to/wt/hermes-wt-1");
  assert.ok(args.includes("-s") && args[args.indexOf("-s") + 1] === "workspace-write");
  assert.ok(args.includes("approval_policy=never"));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(args.includes('mcp_servers.hermes.command="node"'));
  assert.ok(args.includes('mcp_servers.hermes.args=["/path/to/lib/hermes-ask-mcp.mjs"]'));
  assert.ok(args.includes(
    'mcp_servers.hermes.env={ HERMES_SESSION_KEY = "sess-1", HERMES_SOCK = "/path/to/state/hermes-ask.sock", HERMES_ASK_TIMEOUT_MS = "28800000" }'
  ));
  assert.ok(args.includes("mcp_servers.hermes.tool_timeout_sec=28800"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("-o") && args[args.indexOf("-o") + 1] === "/path/to/logs/sessions/sess-1/last-message.txt");
  assert.equal(args[args.length - 1], "implement HOM-27");
});

test("buildCodexArgs: resume argv starts with exec resume <threadId> and keeps the same overrides", () => {
  const args = buildCodexArgs({
    prompt: "owner answered: yes",
    worktree: "/wt",
    lastMessageFile: "/logs/last-message.txt",
    sessionKey: "sess-1",
    sockPath: "/sock",
    askTimeoutMs: 28800000,
    mcpScriptPath: "/mcp.mjs",
    resume: true,
    threadId: "thread-xyz",
  });
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "thread-xyz"]);
  assert.equal(args.includes("-C"), false);
  assert.equal(args.includes("-s"), false);
  // resume has no -s flag (verified live on 0.142.5): the sandbox MUST be re-asserted
  // via config or the resumed implementer silently drops to the read-only default.
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes("mcp_servers.hermes.tool_timeout_sec=28800"));
  assert.ok(args.includes("--json"));
  assert.equal(args[args.length - 1], "owner answered: yes");
});

test("buildCodexArgs: TOML strings with paths containing spaces stay intact and quoted", () => {
  const args = buildCodexArgs({
    prompt: "do it",
    worktree: "/path/to/My Worktrees/wt 1",
    lastMessageFile: "/path/to/My Logs/last message.txt",
    sessionKey: "sess key",
    sockPath: "/path/to/My State/hermes ask.sock",
    askTimeoutMs: 1000,
    mcpScriptPath: "/path/to/My Scripts/mcp server.mjs",
    resume: false,
  });
  assert.ok(args.includes("-C") && args[args.indexOf("-C") + 1] === "/path/to/My Worktrees/wt 1");
  assert.ok(args.includes('mcp_servers.hermes.args=["/path/to/My Scripts/mcp server.mjs"]'));
  assert.ok(args.includes(
    'mcp_servers.hermes.env={ HERMES_SESSION_KEY = "sess key", HERMES_SOCK = "/path/to/My State/hermes ask.sock", HERMES_ASK_TIMEOUT_MS = "1000" }'
  ));
  assert.ok(args.includes("-o") && args[args.indexOf("-o") + 1] === "/path/to/My Logs/last message.txt");
});

// ── parseCodexThreadId ───────────────────────────────────────────────────────

test("parseCodexThreadId: finds a top-level thread_id", () => {
  const jsonl = [
    JSON.stringify({ type: "session_start" }),
    JSON.stringify({ thread_id: "th-top-1" }),
    JSON.stringify({ type: "other" }),
  ].join("\n");
  assert.equal(parseCodexThreadId(jsonl), "th-top-1");
});

test("parseCodexThreadId: finds thread_id nested under .msg", () => {
  const jsonl = [
    JSON.stringify({ type: "noop" }),
    JSON.stringify({ msg: { thread_id: "th-nested-msg" } }),
  ].join("\n");
  assert.equal(parseCodexThreadId(jsonl), "th-nested-msg");
});

test("parseCodexThreadId: finds thread_id nested under .payload", () => {
  const jsonl = JSON.stringify({ payload: { thread_id: "th-nested-payload" } });
  assert.equal(parseCodexThreadId(jsonl), "th-nested-payload");
});

test("parseCodexThreadId: returns the FIRST thread id found across lines", () => {
  const jsonl = [
    JSON.stringify({ thread_id: "th-first" }),
    JSON.stringify({ thread_id: "th-second" }),
  ].join("\n");
  assert.equal(parseCodexThreadId(jsonl), "th-first");
});

test("parseCodexThreadId: garbage lines and absence return null", () => {
  assert.equal(parseCodexThreadId(""), null);
  assert.equal(parseCodexThreadId(null), null);
  assert.equal(parseCodexThreadId("not json\n{also not json"), null);
  assert.equal(parseCodexThreadId(JSON.stringify({ type: "other", msg: {} })), null);
});

// ── parseClaudeStreamMeta ────────────────────────────────────────────────────

test("parseClaudeStreamMeta: happy path picks first session_id and LAST result line", () => {
  const jsonl = [
    JSON.stringify({ type: "system", session_id: "sid-1" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "working…" }] } }),
    JSON.stringify({ type: "result", result: "first result (superseded)", is_error: false }),
    JSON.stringify({ type: "result", result: "final answer", is_error: false }),
  ].join("\n");
  assert.deepEqual(parseClaudeStreamMeta(jsonl), {
    sessionId: "sid-1",
    lastResultText: "final answer",
    isError: false,
  });
});

test("parseClaudeStreamMeta: marks isError true when the LAST result line has is_error true", () => {
  const jsonl = [
    JSON.stringify({ session_id: "sid-2" }),
    JSON.stringify({ type: "result", result: "ok then", is_error: false }),
    JSON.stringify({ type: "result", result: "boom", is_error: true }),
  ].join("\n");
  assert.deepEqual(parseClaudeStreamMeta(jsonl), { sessionId: "sid-2", lastResultText: "boom", isError: true });
});

test("parseClaudeStreamMeta: absent fields/empty input come back null", () => {
  assert.deepEqual(parseClaudeStreamMeta(""), { sessionId: null, lastResultText: null, isError: null });
  assert.deepEqual(parseClaudeStreamMeta(null), { sessionId: null, lastResultText: null, isError: null });
  const jsonl = JSON.stringify({ type: "assistant", message: { content: [] } });
  assert.deepEqual(parseClaudeStreamMeta(jsonl), { sessionId: null, lastResultText: null, isError: null });
});

// ── isSilentCodexFailure ──────────────────────────────────────────────────────

test("isSilentCodexFailure truth table", () => {
  // exit 1 -> never a "silent" failure signature, regardless of output
  assert.equal(isSilentCodexFailure({ exitCode: 1, stdoutText: "", lastMessageText: "" }), false);
  assert.equal(isSilentCodexFailure({ exitCode: 1, stdoutText: "boom", lastMessageText: "boom" }), false);

  // exit 0 + whitespace-only stdout + empty last message -> the #19945 signature
  assert.equal(isSilentCodexFailure({ exitCode: 0, stdoutText: "   \n\t", lastMessageText: "" }), true);
  assert.equal(isSilentCodexFailure({ exitCode: 0, stdoutText: "", lastMessageText: undefined }), true);

  // exit 0 with a non-empty last message -> real success, not the bug
  assert.equal(isSilentCodexFailure({ exitCode: 0, stdoutText: "", lastMessageText: "done!" }), false);
  assert.equal(isSilentCodexFailure({ exitCode: 0, stdoutText: "some output", lastMessageText: "" }), false);
});

// ── wrapWithScript ────────────────────────────────────────────────────────────

test("wrapWithScript: prefixes macOS `script -q /dev/null` ahead of the given argv", () => {
  assert.deepEqual(wrapWithScript(["codex", "exec", "-C", "/wt"]), ["script", "-q", "/dev/null", "codex", "exec", "-C", "/wt"]);
  assert.deepEqual(wrapWithScript([]), ["script", "-q", "/dev/null"]);
});

test("buildCodexArgs: sandbox param — auditors run read-only, fresh and resume", () => {
  const base = {
    prompt: "audit it", worktree: "/wt", lastMessageFile: "/l.txt", sessionKey: "s",
    sockPath: "/sock", askTimeoutMs: 1000, mcpScriptPath: "/m.mjs", sandbox: "read-only",
  };
  const fresh = buildCodexArgs({ ...base, resume: false });
  assert.ok(fresh.includes("-s") && fresh[fresh.indexOf("-s") + 1] === "read-only");
  const resumed = buildCodexArgs({ ...base, resume: true, threadId: "t-1" });
  assert.ok(resumed.includes('sandbox_mode="read-only"'));
  // default stays workspace-write
  const dflt = buildCodexArgs({ ...base, sandbox: undefined, resume: false });
  assert.ok(dflt.includes("-s") && dflt[dflt.indexOf("-s") + 1] === "workspace-write");
});

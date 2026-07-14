// Hermes v2 engine sessions — pure argv/config builders for the two engines (claude, codex).
// Nothing here spawns a process; lib/coder.mjs shows the spawn-side conventions this module
// mirrors (model/effort flags, bypassPermissions, stream-json). See docs/architecture.md
// "Engine sessions" + ADR-0003/0004/0005 for the protocol this implements.

import path from "node:path";
import { MODELS, isModelAlias } from "./models.mjs";
import { ensurePrivateDirectory, writePrivateJsonAtomic } from "./private-storage.mjs";

export const ENGINES = Object.freeze(["codex", "claude"]);
export const isSupportedEngine = (engine) => ENGINES.includes(engine);

// Exact per-engine allowlists: host-capable children receive only process
// basics plus that engine's own subscription/config state. In particular,
// Codex must never inherit Claude's OAuth token (and vice versa). New
// credentials remain excluded by default instead of relying on a denylist that
// inevitably goes stale.
export const COMMON_CHILD_ENV_ALLOW_KEYS = Object.freeze([
  "HOME",
  "PATH",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
]);

export const ENGINE_CHILD_ENV_ALLOW_KEYS = Object.freeze({
  claude: Object.freeze([
    ...COMMON_CHILD_ENV_ALLOW_KEYS,
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]),
  codex: Object.freeze([
    ...COMMON_CHILD_ENV_ALLOW_KEYS,
    "CODEX_HOME",
  ]),
});

// Backward-compatible union used by the read-only security checker to verify
// that this policy is represented as an explicit frozen allowlist. Runtime
// filtering always uses ENGINE_CHILD_ENV_ALLOW_KEYS instead.
export const CHILD_ENV_ALLOW_KEYS = Object.freeze([
  ...new Set(Object.values(ENGINE_CHILD_ENV_ALLOW_KEYS).flat()),
]);

export function buildChildSessionEnv(parentEnv, { engine = "claude", askToken } = {}) {
  if (!isSupportedEngine(engine)) throw new Error(`Unsupported child engine: ${engine}`);
  const env = {};
  for (const key of ENGINE_CHILD_ENV_ALLOW_KEYS[engine]) {
    if (typeof parentEnv?.[key] === "string") env[key] = parentEnv[key];
  }
  if (askToken) env.HERMES_ASK_TOKEN = askToken;
  return env;
}

export function buildConciergeEnv(parentEnv) {
  return buildChildSessionEnv(parentEnv, { engine: "claude" });
}

// ── tool whitelists (ADR-0001: ask_owner is a plain tool call, never elicitation) ───────────
//
// Static per-role whitelists passed via --allowedTools. Read tools + ask_owner + the structured
// repo-allowlisted GitHub MCP only — griller/auditor sessions never get Bash or Write/Edit.
// Implementers get write access via --permission-mode bypassPermissions (mirrors lib/coder.mjs),
// not via this list. mcp__hermes__ask_owner must NEVER be flagged requiresUserInteraction: that flag is
// for MCP elicitation, and codex's `approval_policy=never` auto-rejects elicitations outright —
// ask_owner has to look like an ordinary tool call to survive on both engines (ADR-0001).
export const GITHUB_READ_ALLOWED_TOOLS = Object.freeze([
  "mcp__github_read__issue_list",
  "mcp__github_read__issue_view",
  "mcp__github_read__pr_list",
  "mcp__github_read__pr_view",
  "mcp__github_read__pr_diff",
  "mcp__github_read__search_issues",
  "mcp__github_read__search_prs",
]);

export const GRILLER_ALLOWED_TOOLS = Object.freeze([
  "Read",
  "Glob",
  "Grep",
  ...GITHUB_READ_ALLOWED_TOOLS,
  "mcp__hermes__ask_owner",
]);

export const AUDITOR_ALLOWED_TOOLS = Object.freeze([...GRILLER_ALLOWED_TOOLS]);

// ── per-session MCP config (ADR-0001: local stdio server, per-server wall-clock cap) ────────

// Writes <dir>/mcp-hermes.json wiring the local stdio `hermes` MCP server for one session.
// The per-server `timeout` field is the claude-side wall-clock cap on the whole tool call
// (ADR-0001) — codex has no equivalent config field here; its cap is the separate
// `-c mcp_servers.hermes.tool_timeout_sec` passed on the codex argv (see buildCodexArgs).
function githubReadServer({ mcpScriptPath, allowedRepos }) {
  if (!mcpScriptPath) throw new Error("GitHub read MCP script path is required.");
  if (!Array.isArray(allowedRepos)) throw new Error("GitHub read allowlist must be an array.");
  return {
    command: "node",
    args: [mcpScriptPath],
    env: { HERMES_GITHUB_ALLOWED_REPOS: JSON.stringify(allowedRepos) },
  };
}

export function writeSessionMcpConfig({ dir, sessionKey, sockPath, askTimeoutMs, mcpScriptPath, githubRead }) {
  const configPath = path.join(dir, "mcp-hermes.json");
  const config = {
    mcpServers: {
      hermes: {
        command: "node",
        args: [mcpScriptPath],
        env: {
          HERMES_SESSION_KEY: sessionKey,
          HERMES_SOCK: sockPath,
          HERMES_ASK_TIMEOUT_MS: String(askTimeoutMs),
        },
        timeout: askTimeoutMs,
      },
      ...(githubRead ? { github_read: githubReadServer(githubRead) } : {}),
    },
  };
  ensurePrivateDirectory(dir);
  writePrivateJsonAtomic(configPath, config);
  return configPath;
}

export function writeGitHubReadMcpConfig({ dir, mcpScriptPath, allowedRepos }) {
  const configPath = path.join(dir, "mcp-github-read.json");
  const config = { mcpServers: { github_read: githubReadServer({ mcpScriptPath, allowedRepos }) } };
  ensurePrivateDirectory(dir);
  writePrivateJsonAtomic(configPath, config);
  return configPath;
}

// ── claude argv ───────────────────────────────────────────────────────────────────────────

// Build the `claude` argv for an engine session. Pure (no side effects) so it's unit-tested.
// Mirrors lib/coder.mjs buildSessionArgs: model + effort flags, stream-json + verbose, and the
// same bypassPermissions escalation for implementers. Fresh sessions mint --session-id; resumed
// sessions pass --resume <sessionId> instead, same output format (per this task's brief —
// docs/architecture.md's engine-sessions line for resume omits --output-format/--verbose; this
// spec explicitly says "same output format" for resume, so that governs — see report for the
// flagged conflict).
export function buildClaudeArgs({ prompt, model, effort, sessionId, resume, allowedTools, mcpConfigPath, permissionMode }) {
  if (!isModelAlias(model)) throw new Error(`Unsupported Claude model alias: ${model}`);
  const resolvedModel = MODELS[model];
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (resume) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }
  args.push("--model", resolvedModel);
  if (effort) args.push("--effort", effort); // mirrors lib/coder.mjs's `"--effort", effort,`
  // --strict-mcp-config: load ONLY the per-session hermes server — without it the
  // owner's global MCP servers (and their auth prompts/latency) leak into every
  // headless session (verified available on claude 2.1.201).
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
  if (allowedTools && allowedTools.length) args.push("--allowedTools", ...allowedTools);
  if (permissionMode === "bypass") {
    args.push("--permission-mode", "bypassPermissions", "--dangerously-skip-permissions");
  }
  return args;
}

// ── codex argv ────────────────────────────────────────────────────────────────────────────

// TOML-quote a string value for use inside a `-c key=value` override (double-quoted TOML
// string; backslashes/quotes escaped so paths with spaces or special chars survive intact).
function tomlString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// TOML inline-table for the hermes MCP server's env map: { KEY = "value", ... }.
function tomlEnvTable(env) {
  const entries = Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`);
  return `{ ${entries.join(", ")} }`;
}

// TOML array-of-strings for the hermes MCP server's args list: ["value", ...].
function tomlStringArray(arr) {
  return `[${arr.map(tomlString).join(", ")}]`;
}

// Build the `codex` argv for an engine session. Pure (no side effects). Network stays OFF
// (sandbox_workspace_write.network_access=false) per ADR-0003: the bot, not the sandboxed
// codex session, performs git push + gh pr create, so a prompt-injected implementer can't
// exfiltrate over the network and PR creation stays uniform across engines. Auditors pass
// sandbox="read-only" — they read a worktree and render a verdict, never write. tool_timeout_sec
// defaults to only 60s — far too short for an ask_owner round trip that can block for hours
// waiting on a phone answer, so we set it to 28800 (8h, matching HERMES_ASK_TIMEOUT_MS's
// default) exactly like the claude-side per-server `timeout` (ADR-0001).
export function buildCodexArgs({ prompt, worktree, lastMessageFile, sessionKey, sockPath, askTimeoutMs, mcpScriptPath, resume, threadId, sandbox = "workspace-write" }) {
  const args = ["exec"];
  if (resume) {
    // `codex exec resume` has no -C/-s flags (verified live on 0.142.5): cwd comes
    // from the spawn cwd (must be the SAME worktree — resume lookup is cwd-scoped),
    // and the sandbox must be re-asserted via config, else the resumed implementer
    // silently drops to the default read-only sandbox.
    args.push("resume", threadId, "-c", `sandbox_mode="${sandbox}"`);
  } else {
    args.push("-C", worktree, "-s", sandbox);
  }
  args.push(
    "-c", "approval_policy=never",
    "-c", "sandbox_workspace_write.network_access=false",
    "-c", `mcp_servers.hermes.command=${tomlString("node")}`,
    "-c", `mcp_servers.hermes.args=${tomlStringArray([mcpScriptPath])}`,
    "-c", `mcp_servers.hermes.env=${tomlEnvTable({
      HERMES_SESSION_KEY: sessionKey,
      HERMES_SOCK: sockPath,
      HERMES_ASK_TIMEOUT_MS: String(askTimeoutMs),
    })}`,
    "-c", `mcp_servers.hermes.env_vars=${tomlStringArray(["HERMES_ASK_TOKEN"])}`,
    "-c", "mcp_servers.hermes.tool_timeout_sec=28800",
    "--json",
    "-o", lastMessageFile,
    prompt
  );
  return args;
}

// ── codex/claude event parsing ────────────────────────────────────────────────────────────

// Scan newline-delimited --json codex events for the first thread id. Shape varies by codex
// version: some emit `thread_id` at the top level, others nest it under `.msg` or `.payload`.
// Returns the first string found for a key named exactly "thread_id"; null if absent/garbage.
export function parseCodexThreadId(jsonlText) {
  if (!jsonlText) return null;
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (typeof ev?.thread_id === "string") return ev.thread_id;
    if (typeof ev?.msg?.thread_id === "string") return ev.msg.thread_id;
    if (typeof ev?.payload?.thread_id === "string") return ev.payload.thread_id;
  }
  return null;
}

// Parse claude --output-format stream-json lines into { sessionId, lastResultText, isError }.
// sessionId comes from the first line carrying session_id; lastResultText/isError come from the
// LAST line with type "result". Nulls when absent/garbage.
export function parseClaudeStreamMeta(jsonlText) {
  let sessionId = null;
  let lastResultText = null;
  let isError = null;
  if (!jsonlText) return { sessionId, lastResultText, isError };
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    if (sessionId === null && typeof ev?.session_id === "string") sessionId = ev.session_id;
    if (ev?.type === "result") {
      lastResultText = typeof ev.result === "string" ? ev.result : null;
      isError = !!ev.is_error;
    }
  }
  return { sessionId, lastResultText, isError };
}

// True exactly on the codex no-TTY bug's signature (openai/codex#19945): exit code 0 but
// completely empty stdout AND an empty last-message file. Under that bug codex silently does
// nothing and exits clean, so empty-output-exit-0 must be treated as a failure, not a no-op
// success — otherwise a silently-failed implementer session would be recorded as done.
export function isSilentCodexFailure({ exitCode, stdoutText, lastMessageText }) {
  return exitCode === 0 && (stdoutText ?? "").trim() === "" && (lastMessageText ?? "").trim() === "";
}

// Wrap an argv in macOS `script` to force a pty, working around the codex no-TTY bug above.
// BSD `script` (macOS) has no `-c "cmd"` single-string form like Linux util-linux script does —
// it takes the command and its args as trailing positional argv, hence `-q /dev/null <argv...>`
// rather than a quoted command string.
export function wrapWithScript(argv) {
  return ["script", "-q", "/dev/null", ...argv];
}

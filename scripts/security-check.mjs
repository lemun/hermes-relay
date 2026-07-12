#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEVERITIES = ["critical", "high", "warn"];
const GENERATED_CONFIG_NAMES = ["mcp-hermes.json", "mcp-github-read.json"];
const LOCKDOWN_PATHS = ["state/hermes.lockdown", "state/LOCKDOWN", "LOCKDOWN", ".lockdown"];
const NTFY_ROTATION_MARKER_PATHS = ["state/ntfy-rotation-confirmed"];
const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_USER_ID",
  "PAPERCLIP_BOARD_API_KEY",
  "NTFY_TOPIC",
  "NTFY_ROTATION_CONFIRMED",
  "NTFY_TOPIC_ROTATED_AT",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];

function hasOwn(value, key) {
  return value != null && Object.prototype.hasOwnProperty.call(value, key);
}

function present(value) {
  return value !== undefined && value !== null && String(value).trim() !== "" && String(value) !== "0";
}

function finding(severity, id, title, detail, remediation) {
  return { severity, id, title, detail, remediation };
}

function childConfigContainsSecret(content, configuredSecrets) {
  const assignment = /(?:["']?(?:TELEGRAM_BOT_TOKEN|PAPERCLIP_BOARD_API_KEY|botToken|boardApiKey)["']?)\s*[:=]/;
  return assignment.test(content) || configuredSecrets.some((secret) => secret.length >= 6 && content.includes(secret));
}

function childConfigContainsGitHubToken(content, configuredTokens) {
  const assignment = /(?:["']?(?:GH_TOKEN|GITHUB_TOKEN)["']?)\s*[:=]/;
  return assignment.test(content) || configuredTokens.some((token) => token.length >= 6 && content.includes(token));
}

/** Pure posture evaluator. Tests inject a deterministic snapshot; it performs no I/O. */
export function evaluateSecurityPosture({
  config = {},
  env = {},
  sensitiveFiles = [],
  generatedConfigs = [],
  lockdownFiles = [],
  ntfyRotationMarkers = [],
  runtime = {},
  errors = [],
} = {}) {
  config = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const findings = [];
  const telegram = config.telegram || {};
  const codingEnabled = config.coding?.enabled === true;
  const hermesEnabled = config.hermes?.enabled === true;
  const claudeWriteEnabled = config.hermes?.allowClaudeWriteSessions === true;
  const autopilotEnabled = runtime.autopilotEnabled === true;
  const boardWritesEnabled = present(env.PAPERCLIP_BOARD_API_KEY) || present(config.boardApiKey);
  const writeOrSpawnEnabled = codingEnabled || hermesEnabled || claudeWriteEnabled || autopilotEnabled || boardWritesEnabled;
  const telegramChatId = env.TELEGRAM_CHAT_ID ?? telegram.allowedChatId;
  const telegramUserId = env.TELEGRAM_USER_ID ?? telegram.allowedUserId ?? telegram.userId;
  const telegramIdentityConfigured = present(telegramUserId) || present(telegramChatId);
  const separateUserIdSupported = hasOwn(env, "TELEGRAM_USER_ID") || hasOwn(telegram, "allowedUserId") || hasOwn(telegram, "userId");
  const telegramConfigured = present(env.TELEGRAM_BOT_TOKEN) || present(telegram.botToken);
  const ntfyConfigured = present(env.NTFY_TOPIC) || present(config.ntfy?.topic);
  const ntfyRotationConfirmed = present(env.NTFY_ROTATION_CONFIRMED)
    || present(env.NTFY_TOPIC_ROTATED_AT)
    || config.ntfy?.rotationConfirmed === true
    || present(config.ntfy?.rotationConfirmedAt)
    || ntfyRotationMarkers.length > 0;
  const githubTokens = [env.GH_TOKEN, env.GITHUB_TOKEN].filter(present).map(String);
  const configuredSecrets = [
    env.TELEGRAM_BOT_TOKEN,
    telegram.botToken,
    env.PAPERCLIP_BOARD_API_KEY,
    config.boardApiKey,
  ].filter(present).map(String);
  const redactionSecrets = [...new Set([
    ...configuredSecrets,
    ...githubTokens,
    env.NTFY_TOPIC,
    config.ntfy?.topic,
  ].filter(present).map(String))].sort((a, b) => b.length - a.length);
  const safeText = (value) => redactionSecrets.reduce(
    (text, secret) => text.split(secret).join("[redacted]"),
    String(value),
  );

  if (writeOrSpawnEnabled && !telegramIdentityConfigured) {
    findings.push(finding(
      "critical",
      "write-mode-without-telegram-identity",
      "Write or session-spawning posture has no Telegram identity",
      "A mode capable of writes or child sessions is enabled without an allowed Telegram chat or user identity.",
      "Disable the mode or configure the operator identity before starting Hermes.",
    ));
  }

  const exposedFiles = [...new Set(sensitiveFiles
    .filter((file) => (Number(file.mode) & 0o077) !== 0)
    .map((file) => `${safeText(file.path)} (${(Number(file.mode) & 0o777).toString(8).padStart(3, "0")})`)
    .sort())];
  if (exposedFiles.length) {
    findings.push(finding(
      "critical",
      "sensitive-file-permissions",
      "Sensitive files are readable by group or others",
      `Affected files: ${exposedFiles.join(", ")}.`,
      "Restrict each listed file to the owning account and re-run this read-only check.",
    ));
  }

  const secretConfigs = generatedConfigs
    .filter((file) => childConfigContainsSecret(String(file.content || ""), configuredSecrets))
    .map((file) => safeText(file.path))
    .sort();
  if (secretConfigs.length) {
    findings.push(finding(
      "critical",
      "child-config-secret",
      "Telegram or board secret material appears in child configuration",
      `Affected generated configuration: ${secretConfigs.join(", ")}.`,
      "Remove secret material from child configuration and rotate the affected credentials.",
    ));
  }

  if (lockdownFiles.length && writeOrSpawnEnabled) {
    findings.push(finding(
      "critical",
      "lockdown-write-contradiction",
      "Emergency lockdown conflicts with enabled runtime posture",
      `A lockdown marker exists (${[...lockdownFiles].map(safeText).sort().join(", ")}) while configuration still claims writes or session spawning are enabled.`,
      "Keep Hermes stopped; disable write/session modes and rotate credentials before clearing lockdown.",
    ));
  }

  if (codingEnabled) {
    findings.push(finding(
      "high",
      "legacy-claude-host-capable",
      "Legacy Claude coding bypass is host-capable",
      "coding.enabled=true permits a write-enabled Claude child outside a restrictive sandbox.",
      "Keep legacy coding mode disabled unless this is a dedicated, trusted host.",
    ));
  }

  if (claudeWriteEnabled) {
    findings.push(finding(
      "high",
      "claude-write-sessions-enabled",
      "Claude write sessions are enabled",
      "hermes.allowClaudeWriteSessions=true permits host-capable implementer, fixer, or resolver sessions.",
      "Prefer sandboxed Codex write sessions or enable this only on a dedicated, trusted host.",
    ));
  }

  if (separateUserIdSupported && !present(telegramUserId)) {
    findings.push(finding(
      "high",
      "telegram-user-id-missing",
      "Separate Telegram user ID is not configured",
      "The runtime supports a separate operator user identity, but no value is configured.",
      "Configure the operator's numeric Telegram user ID separately from the allowed chat ID.",
    ));
  }

  const githubConfigPaths = generatedConfigs
    .filter((file) => childConfigContainsGitHubToken(String(file.content || ""), githubTokens))
    .map((file) => safeText(file.path));
  if ((codingEnabled && githubTokens.length) || githubConfigPaths.length) {
    const source = githubConfigPaths.length
      ? `Generated child configuration references a GitHub environment token: ${githubConfigPaths.sort().join(", ")}.`
      : "A GitHub environment token is present while the legacy host-capable child mode is enabled.";
    findings.push(finding(
      "high",
      "github-token-host-child",
      "GitHub environment token can reach a host-capable child",
      source,
      "Remove GitHub tokens from the child environment/configuration and use narrowly scoped bot-owned GitHub operations.",
    ));
  }

  if (telegramConfigured) {
    findings.push(finding(
      "warn",
      "telegram-group-protection-manual",
      "Telegram bot group-use protection needs manual verification",
      "The checker cannot query BotFather or Telegram to confirm group joins and inline use are disabled.",
      "Verify both settings manually with BotFather.",
    ));
  }

  if (ntfyConfigured && !ntfyRotationConfirmed) {
    findings.push(finding(
      "warn",
      "ntfy-rotation-unconfirmed",
      "ntfy rotation has no operator-confirmed marker",
      "An ntfy topic is configured, but no rotation confirmation marker was found.",
      "Rotate the historically exposed topic, then record the local operator confirmation described in docs/hardening.md.",
    ));
  }

  if (telegramConfigured) {
    findings.push(finding(
      "warn",
      "telegram-account-hygiene-manual",
      "Telegram account and session hygiene needs manual verification",
      "Passkey, extra password, and active-session posture cannot be verified locally.",
      "Review the Telegram account checklist in docs/hardening.md.",
    ));
  }

  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((item) => item.severity === severity).length]));
  return {
    ok: counts.critical === 0,
    exitCode: counts.critical === 0 ? 0 : 1,
    counts,
    incomplete: [...errors],
    findings,
  };
}

function parseDotenv(text) {
  const parsed = {};
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*export\s+/, "");
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith("#")) parsed[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return parsed;
}

function readText(file, fsImpl) {
  try { return fsImpl.readFileSync(file, "utf8"); } catch { return null; }
}

function readJson(file, fsImpl) {
  const text = readText(file, fsImpl);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function relativePath(root, file) {
  const relative = path.relative(root, file);
  return relative && !relative.startsWith("..") ? relative : file;
}

function fileMode(file, fsImpl) {
  try { return fsImpl.statSync(file).mode & 0o777; } catch { return null; }
}

function listStateFiles(dir, fsImpl, output = []) {
  let entries;
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) listStateFiles(file, fsImpl, output);
    else if (entry.isFile()) output.push(file);
  }
  return output;
}

function findNamedFiles(dir, names, fsImpl, output = []) {
  let entries;
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) findNamedFiles(file, names, fsImpl, output);
    else if (entry.isFile() && names.includes(entry.name)) output.push(file);
  }
  return output;
}

/** Read-only collector. fs and environment are injectable for deterministic tests. */
export function collectSecuritySnapshot({ root = SCRIPT_ROOT, env = process.env, fsImpl = fs } = {}) {
  const errors = [];
  const configPath = path.join(root, "config.json");
  const configText = readText(configPath, fsImpl);
  let config = {};
  if (configText == null) errors.push("config.json is unavailable; runtime posture is incomplete");
  else {
    try { config = JSON.parse(configText); }
    catch { errors.push("config.json is malformed; runtime posture is incomplete"); }
  }

  const dotenvPath = path.join(root, ".env");
  const dotenvText = readText(dotenvPath, fsImpl);
  const dotenv = dotenvText == null ? {} : parseDotenv(dotenvText);
  const selectedEnv = {};
  for (const key of ENV_KEYS) {
    if (hasOwn(env, key)) selectedEnv[key] = env[key];
    else if (hasOwn(dotenv, key)) selectedEnv[key] = dotenv[key];
  }

  const sensitiveFiles = [];
  if (dotenvText != null) sensitiveFiles.push({ path: ".env", mode: fileMode(dotenvPath, fsImpl) });
  const configHoldsSensitiveValue = present(config.telegram?.botToken)
    || present(config.boardApiKey)
    || present(config.ntfy?.topic);
  if (configText != null && configHoldsSensitiveValue) sensitiveFiles.push({ path: "config.json", mode: fileMode(configPath, fsImpl) });
  for (const file of listStateFiles(path.join(root, "state"), fsImpl)) {
    sensitiveFiles.push({ path: relativePath(root, file), mode: fileMode(file, fsImpl) });
  }

  const generatedPaths = new Set();
  const rootMcp = path.join(root, "mcp-config.json");
  if (readText(rootMcp, fsImpl) != null) generatedPaths.add(rootMcp);
  for (const relative of ["state/mcp-github-read.json", "state/mcp-hermes.json"]) {
    const file = path.join(root, relative);
    if (readText(file, fsImpl) != null) generatedPaths.add(file);
  }
  for (const file of findNamedFiles(path.join(root, "logs", "sessions"), GENERATED_CONFIG_NAMES, fsImpl)) generatedPaths.add(file);
  const sessions = readJson(path.join(root, "state", "hermes-sessions.json"), fsImpl);
  const prefs = readJson(path.join(root, "state", "hermes-prefs.json"), fsImpl);
  const worktrees = [
    ...(sessions?.sessions || []).map((session) => session?.worktree),
    prefs?.coding?.active?.worktreePath,
    prefs?.coding?.last?.worktreePath,
  ].filter(present).map(String);
  for (const worktree of new Set(worktrees)) {
    for (const name of GENERATED_CONFIG_NAMES) {
      const file = path.join(worktree, name);
      if (readText(file, fsImpl) != null) generatedPaths.add(file);
    }
  }
  const generatedConfigs = [...generatedPaths].sort().map((file) => ({ path: relativePath(root, file), content: readText(file, fsImpl) || "" }));
  for (const file of generatedPaths) {
    const mode = fileMode(file, fsImpl);
    if (mode != null) sensitiveFiles.push({ path: relativePath(root, file), mode });
  }

  const lockdownFiles = LOCKDOWN_PATHS.filter((relative) => readText(path.join(root, relative), fsImpl) != null);
  const ntfyRotationMarkers = NTFY_ROTATION_MARKER_PATHS.filter((relative) => readText(path.join(root, relative), fsImpl) != null);
  const autopilot = readJson(path.join(root, "state", "hermes-autopilot.json"), fsImpl);
  const runtime = { autopilotEnabled: autopilot?.enabled === true };
  return { config, env: selectedEnv, sensitiveFiles, generatedConfigs, lockdownFiles, ntfyRotationMarkers, runtime, errors };
}

export function renderHumanReport(report) {
  const lines = [
    `Hermes security check: ${report.counts.critical} critical, ${report.counts.high} high, ${report.counts.warn} warn`,
  ];
  for (const message of report.incomplete || []) lines.push(`INCOMPLETE: ${message}`);
  for (const item of report.findings) {
    lines.push(`${item.severity.toUpperCase()} ${item.id}: ${item.title}`);
    lines.push(`  ${item.detail}`);
  }
  if (!report.findings.length) lines.push("No findings.");
  return lines.join("\n");
}

function parseArgs(argv) {
  let root = SCRIPT_ROOT;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--root") {
      if (!argv[index + 1]) throw new Error("--root requires a path");
      root = path.resolve(argv[index + 1]);
      index += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { root, json };
}

export function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    stderr.write(`Usage: npm run security:check -- [--json] [--root PATH]\n${error.message}\n`);
    return 2;
  }
  const report = evaluateSecurityPosture(collectSecuritySnapshot({ root: options.root, env }));
  stdout.write(`${options.json ? JSON.stringify(report, null, 2) : renderHumanReport(report)}\n`);
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}

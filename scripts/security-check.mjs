#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUNTIME_SECURITY_FEATURES } from "../lib/runtime-security.mjs";
import { CHILD_ENV_ALLOW_KEYS } from "../lib/engines.mjs";
import { createTotpVerifier } from "../lib/step-up-auth.mjs";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEVERITIES = ["critical", "high", "warn"];
const GENERATED_CONFIG_NAMES = new Set(["mcp-hermes.json", "mcp-github-read.json"]);
const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_USER_ID", "HERMES_TOTP_SECRET",
  "PAPERCLIP_BOARD_API_KEY", "NTFY_TOPIC", "NTFY_ROTATION_CONFIRMED",
  "NTFY_TOPIC_ROTATED_AT", "GH_TOKEN", "GITHUB_TOKEN",
];
const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_ENTRIES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const hasOwn = (value, key) => value != null && Object.prototype.hasOwnProperty.call(value, key);
const present = (value) => value !== undefined && value !== null && String(value).trim() !== "" && String(value) !== "0";
const finding = (severity, id, title, detail, remediation) => ({ severity, id, title, detail, remediation });
const validTelegramBotToken = (value) => /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/.test(String(value || ""));

function validTotpSecret(value) {
  try {
    createTotpVerifier({ secret: value, window: 1 });
    return true;
  } catch {
    return false;
  }
}

function childConfigContainsSecret(content, configuredSecrets) {
  const assignment = /(?:["']?(?:TELEGRAM_BOT_TOKEN|PAPERCLIP_BOARD_API_KEY|HERMES_TOTP_SECRET|botToken|boardApiKey|totpSecret)["']?)\s*[:=]/;
  return assignment.test(content) || configuredSecrets.some((secret) => secret.length >= 6 && content.includes(secret));
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

function readChecked(file, { fsImpl, errors, label, required = false, maxBytes = MAX_FILE_BYTES }) {
  let descriptor;
  let stat;
  try {
    const before = fsImpl.lstatSync(file);
    if (before.isSymbolicLink()) {
      errors.push(`${label}:symlink`);
      return null;
    }
    descriptor = fsImpl.openSync(file, fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0));
    stat = fsImpl.fstatSync(descriptor);
  }
  catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    if (error?.code === "ELOOP") errors.push(`${label}:symlink`);
    else errors.push(`${label}:unavailable`);
    if (descriptor !== undefined) try { fsImpl.closeSync(descriptor); } catch { /* preserve */ }
    return null;
  }
  if (!stat.isFile()) {
    errors.push(`${label}:not-regular-file`);
    fsImpl.closeSync(descriptor);
    return null;
  }
  if (stat.size > maxBytes) {
    errors.push(`${label}:too-large`);
    fsImpl.closeSync(descriptor);
    return null;
  }
  try { return { text: fsImpl.readFileSync(descriptor, "utf8"), mode: stat.mode & 0o777 }; }
  catch {
    errors.push(`${label}:unreadable`);
    return null;
  } finally {
    try { fsImpl.closeSync(descriptor); } catch { /* the read result remains valid */ }
  }
}

function parseJsonChecked(file, options) {
  const read = readChecked(file, options);
  if (!read) return { value: null, read: null };
  try { return { value: JSON.parse(read.text), read }; }
  catch {
    options.errors.push(`${options.label}:malformed`);
    return { value: null, read };
  }
}

function boundedFiles(dir, { root, fsImpl, errors, label, names, depth = 0, budget = { entries: 0 }, output = [] }) {
  if (depth > MAX_SCAN_DEPTH) {
    errors.push(`${label}:depth-limit`);
    return output;
  }
  let stat;
  try { stat = fsImpl.lstatSync(dir); }
  catch (error) {
    if (error?.code !== "ENOENT") errors.push(`${label}:unavailable`);
    return output;
  }
  if (stat.isSymbolicLink()) {
    errors.push(`${label}:symlink`);
    return output;
  }
  if (!stat.isDirectory()) {
    errors.push(`${label}:not-directory`);
    return output;
  }
  let entries;
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
  catch {
    errors.push(`${label}:unreadable`);
    return output;
  }
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > MAX_SCAN_ENTRIES) {
      errors.push(`${label}:entry-limit`);
      return output;
    }
    const file = path.join(dir, entry.name);
    let current;
    try { current = fsImpl.lstatSync(file); }
    catch { errors.push(`${label}:entry-unreadable`); continue; }
    const fileLabel = `${label}/entry-${budget.entries}`;
    if (current.isSymbolicLink()) {
      errors.push(`${fileLabel}:symlink`);
    } else if (current.isDirectory()) {
      boundedFiles(file, { root, fsImpl, errors, label, names, depth: depth + 1, budget, output });
    } else if (!names || names.has(entry.name)) {
      output.push({ file, label: fileLabel, mode: current.mode & 0o777 });
    }
  }
  return output;
}

/** Pure posture evaluator. The report never includes raw exception text or arbitrary argv. */
export function evaluateSecurityPosture({
  config = {}, env = {}, sensitiveFiles = [], generatedConfigs = [], auditLogs = [],
  lockdownFiles = [], securityLocks = [], securityStateMigrations = [],
  ntfyRotationMarkers = [], runtime = {}, errors = [],
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
  const telegramUserId = env.TELEGRAM_USER_ID ?? telegram.allowedUserId;
  const strictIdentity = runtime.strictTelegramIdentity === true && present(telegramChatId) && present(telegramUserId);
  const telegramBotToken = present(env.TELEGRAM_BOT_TOKEN) ? env.TELEGRAM_BOT_TOKEN : telegram.botToken;
  const totpSecret = present(env.HERMES_TOTP_SECRET) ? env.HERMES_TOTP_SECRET : telegram.totpSecret;
  const telegramConfigured = present(telegramBotToken);
  const ntfyConfigured = present(env.NTFY_TOPIC) || present(config.ntfy?.topic);
  const ntfyRotationConfirmed = present(env.NTFY_ROTATION_CONFIRMED) || present(env.NTFY_TOPIC_ROTATED_AT)
    || config.ntfy?.rotationConfirmed === true || present(config.ntfy?.rotationConfirmedAt) || ntfyRotationMarkers.length > 0;
  const githubTokens = [env.GH_TOKEN, env.GITHUB_TOKEN].filter(present).map(String);
  const configuredSecrets = [
    env.TELEGRAM_BOT_TOKEN, telegram.botToken, env.HERMES_TOTP_SECRET, telegram.totpSecret,
    env.PAPERCLIP_BOARD_API_KEY, config.boardApiKey, env.NTFY_TOPIC, config.ntfy?.topic, ...githubTokens,
  ].filter(present).map(String);
  const safeText = (value) => configuredSecrets.reduce((text, secret) => text.split(secret).join("[redacted]"), String(value));

  if (errors.length) {
    findings.push(finding(
      "critical", "security-scan-incomplete", "Security scan could not verify every critical input",
      `The scan failed closed on ${errors.length} input(s); identifiers: ${[...new Set(errors)].sort().join(", ")}.`,
      "Repair the unreadable, malformed, symlinked, or over-limit inputs and run the check again.",
    ));
  }
  if (writeOrSpawnEnabled && !strictIdentity) {
    findings.push(finding(
      "critical", "write-mode-without-telegram-identity", "Write or session mode lacks enforced strict Telegram identity",
      "A write/session-capable mode requires runtime-enforced private chat plus exact configured chat ID and user ID.",
      "Configure both numeric IDs and use a runtime that enforces the strict identity guard.",
    ));
  }
  if (writeOrSpawnEnabled && !telegramConfigured) {
    findings.push(finding(
      "critical", "write-mode-without-telegram-bot-token", "Write or session mode lacks a Telegram bot token",
      "A write/session-capable posture cannot authenticate Telegram updates without a bot token.",
      "Set TELEGRAM_BOT_TOKEN to the BotFather-issued token and run the check again.",
    ));
  } else if (writeOrSpawnEnabled && !validTelegramBotToken(telegramBotToken)) {
    findings.push(finding(
      "critical", "write-mode-with-invalid-telegram-bot-token", "Write or session mode has a malformed Telegram bot token",
      "The configured bot token does not match the locally verifiable Telegram token structure.",
      "Replace TELEGRAM_BOT_TOKEN with the exact BotFather-issued token and run the check again.",
    ));
  }
  if (writeOrSpawnEnabled && !present(totpSecret)) {
    findings.push(finding(
      "critical", "write-mode-without-totp", "Write or session mode lacks TOTP step-up authentication",
      "A write/session-capable posture requires a configured TOTP secret for mutation and spawn approval.",
      "Set HERMES_TOTP_SECRET to a valid base32 secret and run the check again.",
    ));
  } else if (writeOrSpawnEnabled && !validTotpSecret(totpSecret)) {
    findings.push(finding(
      "critical", "write-mode-with-invalid-totp", "Write or session mode has an invalid TOTP secret",
      "The configured TOTP secret cannot initialize the runtime verifier.",
      "Replace HERMES_TOTP_SECRET with a valid base32 secret and run the check again.",
    ));
  }
  if (securityLocks.length) {
    findings.push(finding(
      "critical", "security-state-lock-present", "Security state lock requires operator recovery",
      "The security-state update lock is present; it may be an active writer or crash residue, so write-enabled startup must not proceed.",
      "Stop all Hermes writers, verify the lock is stale and a regular owner-only file, remove it locally, then re-run the check before startup.",
    ));
  }
  if (securityStateMigrations.length) {
    findings.push(finding(
      "critical", "security-state-local-unlock-required", "Security state requires a local-unlock migration",
      "The stored state says normal but does not prove that its generation was minted by an explicit local unlock; runtime activation remains locked.",
      "Run `npm run security:control -- unlock` locally, then run the security check again before starting write-enabled services.",
    ));
  }
  const symlinks = sensitiveFiles.filter((file) => file.symlink).map((file) => safeText(file.path));
  if (symlinks.length) {
    findings.push(finding(
      "critical", "sensitive-path-symlink", "Sensitive state uses a symbolic link",
      `Affected sensitive path labels: ${[...new Set(symlinks)].sort().join(", ")}.`,
      "Replace each symlink with an owner-only regular file or directory.",
    ));
  }
  const exposed = sensitiveFiles
    .filter((file) => Number.isInteger(file.mode) && (file.mode & 0o077) !== 0)
    .map((file) => `${safeText(file.path)} (${(file.mode & 0o777).toString(8).padStart(3, "0")})`);
  if (exposed.length) {
    findings.push(finding(
      "critical", "sensitive-file-permissions", "Sensitive files are readable by group or others",
      `Affected files: ${[...new Set(exposed)].sort().join(", ")}.`,
      "Restrict each file to its owning account and re-run this check.",
    ));
  }
  const secretConfigs = generatedConfigs.filter((file) => childConfigContainsSecret(String(file.content || ""), configuredSecrets)).map((file) => safeText(file.path));
  if (secretConfigs.length) {
    findings.push(finding(
      "critical", "child-config-secret", "Service secret material appears in child configuration",
      `Affected generated configuration labels: ${[...new Set(secretConfigs)].sort().join(", ")}.`,
      "Remove the secret material and rotate affected credentials.",
    ));
  }
  const unsafeAudit = auditLogs.filter((file) => /"(?:prompt|branch|promptSha256|promptHash|digest)"\s*:/.test(file.content || ""));
  if (unsafeAudit.length) {
    findings.push(finding(
      "critical", "coder-audit-disclosure", "Legacy coder audit contains prompt-derived fields",
      `Affected audit labels: ${unsafeAudit.map((file) => safeText(file.path)).sort().join(", ")}.`,
      "Remove prompt-derived audit fields and rotate the log if it contains historical sensitive data.",
    ));
  }
  if (lockdownFiles.length && runtime.lockdownEnforced !== true) {
    findings.push(finding(
      "critical", "lockdown-not-enforced", "Lockdown state is present but runtime enforcement is absent",
      "A lockdown marker alone is not an authorization boundary.",
      "Use the runtime action guard at command, callback, spawn, push, and merge boundaries.",
    ));
  }

  if (codingEnabled) findings.push(finding("high", "legacy-claude-host-capable", "Legacy Claude coding bypass is host-capable", "coding.enabled=true permits a write-enabled host child.", "Keep legacy coding disabled unless this is a dedicated trusted host."));
  if (claudeWriteEnabled) findings.push(finding("high", "claude-write-sessions-enabled", "Claude write sessions are enabled", "Host-capable Claude write lanes are enabled.", "Prefer sandboxed Codex write sessions."));
  if (writeOrSpawnEnabled && !present(telegramUserId)) findings.push(finding("high", "telegram-user-id-missing", "Telegram user ID is not configured", "Strict runtime identity requires a separate numeric user ID.", "Set TELEGRAM_USER_ID."));
  if (codingEnabled && githubTokens.length && runtime.childEnvAllowlist !== true) {
    findings.push(finding("high", "github-token-host-child", "GitHub token may reach a host-capable child", "The child environment policy was not verified as an explicit allowlist.", "Use the exact child environment allowlist."));
  }
  if (telegramConfigured) findings.push(finding("warn", "telegram-group-protection-manual", "Telegram bot group-use protection needs manual verification", "The local checker cannot inspect BotFather group settings.", "Verify group joins and inline use are disabled."));
  if (ntfyConfigured && !ntfyRotationConfirmed) findings.push(finding("warn", "ntfy-rotation-unconfirmed", "ntfy rotation has no operator-confirmed marker", "An ntfy topic is configured without a rotation confirmation.", "Rotate it and record the local confirmation."));
  if (telegramConfigured) findings.push(finding("warn", "telegram-account-hygiene-manual", "Telegram account hygiene needs manual verification", "Passkey, extra password, and active sessions are not locally observable.", "Review the Telegram account checklist."));

  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, findings.filter((item) => item.severity === severity).length]));
  return { ok: counts.critical === 0, exitCode: counts.critical === 0 ? 0 : 1, counts, incomplete: [...errors], findings };
}

/** Bounded, no-follow, read-only collector. */
export function collectSecuritySnapshot({ root = SCRIPT_ROOT, env = process.env, fsImpl = fs } = {}) {
  const errors = [];
  const configPath = path.join(root, "config.json");
  const configResult = parseJsonChecked(configPath, { fsImpl, errors, label: "config.json", required: true });
  const config = configResult.value && typeof configResult.value === "object" && !Array.isArray(configResult.value) ? configResult.value : {};
  if (configResult.value !== null && config !== configResult.value) errors.push("config.json:invalid-shape");

  const dotenvPath = path.join(root, ".env");
  const dotenvRead = readChecked(dotenvPath, { fsImpl, errors, label: ".env" });
  const dotenv = dotenvRead ? parseDotenv(dotenvRead.text) : {};
  const selectedEnv = {};
  for (const key of ENV_KEYS) {
    if (hasOwn(env, key)) selectedEnv[key] = env[key];
    else if (hasOwn(dotenv, key)) selectedEnv[key] = dotenv[key];
  }

  const sensitiveFiles = [];
  if (dotenvRead) sensitiveFiles.push({ path: ".env", mode: dotenvRead.mode });
  const stateDir = path.join(root, "state");
  const logDir = path.join(root, "logs");
  const securityLocks = [];
  const securityLockFile = path.join(stateDir, "hermes-security.json.lock");
  try {
    const lockStat = fsImpl.lstatSync(securityLockFile);
    securityLocks.push({ path: "state/hermes-security.json.lock" });
    if (lockStat.isSymbolicLink()) errors.push("state/hermes-security.json.lock:symlink");
    else if (!lockStat.isFile()) errors.push("state/hermes-security.json.lock:not-regular-file");
  } catch (error) {
    if (error?.code !== "ENOENT") errors.push("state/hermes-security.json.lock:unavailable");
  }
  const stateFiles = boundedFiles(stateDir, { root, fsImpl, errors, label: "state" });
  const logFiles = boundedFiles(logDir, { root, fsImpl, errors, label: "logs" });
  for (const item of [...stateFiles, ...logFiles]) sensitiveFiles.push({ path: item.label, mode: item.mode });
  for (const error of errors.filter((item) => /:symlink$/.test(item))) sensitiveFiles.push({ path: error.replace(/:symlink$/, ""), symlink: true });
  if (configResult.read && (present(config.telegram?.botToken) || present(config.telegram?.totpSecret) || present(config.boardApiKey) || present(config.ntfy?.topic))) {
    sensitiveFiles.push({ path: "config.json", mode: configResult.read.mode });
  }

  const criticalJsonNames = ["hermes-sessions.json", "hermes-prefs.json", "hermes-autopilot.json", "hermes-security.json"];
  const parsedState = {};
  for (const name of criticalJsonNames) {
    parsedState[name] = parseJsonChecked(path.join(stateDir, name), { fsImpl, errors, label: `state/${name}`, required: true }).value;
  }
  if (parsedState["hermes-sessions.json"] && !Array.isArray(parsedState["hermes-sessions.json"].sessions)) errors.push("state/hermes-sessions.json:invalid-shape");
  if (parsedState["hermes-prefs.json"] && (typeof parsedState["hermes-prefs.json"] !== "object" || Array.isArray(parsedState["hermes-prefs.json"]))) errors.push("state/hermes-prefs.json:invalid-shape");
  if (parsedState["hermes-autopilot.json"] && (typeof parsedState["hermes-autopilot.json"] !== "object" || Array.isArray(parsedState["hermes-autopilot.json"]))) errors.push("state/hermes-autopilot.json:invalid-shape");
  if (parsedState["hermes-security.json"] && (
    parsedState["hermes-security.json"].version !== 1
    || !["normal", "locked"].includes(parsedState["hermes-security.json"].lockdown)
    || !Number.isSafeInteger(parsedState["hermes-security.json"].lockdownGeneration)
    || parsedState["hermes-security.json"].lockdownGeneration < 0
    || !(parsedState["hermes-security.json"].localUnlockGeneration === undefined
      || parsedState["hermes-security.json"].localUnlockGeneration === null
      || (Number.isSafeInteger(parsedState["hermes-security.json"].localUnlockGeneration)
        && parsedState["hermes-security.json"].localUnlockGeneration >= 0
        && parsedState["hermes-security.json"].localUnlockGeneration <= parsedState["hermes-security.json"].lockdownGeneration))
    || !Array.isArray(parsedState["hermes-security.json"].totpCounters)
    || !Array.isArray(parsedState["hermes-security.json"].capabilities)
  )) errors.push("state/hermes-security.json:invalid-shape");

  const generatedConfigs = [];
  const generatedCandidates = [
    { file: path.join(root, "mcp-config.json"), label: "mcp-config.json" },
    ...[...stateFiles, ...logFiles].filter((item) => GENERATED_CONFIG_NAMES.has(path.basename(item.file))).map((item) => ({ file: item.file, label: item.label })),
  ];
  const sessionList = Array.isArray(parsedState["hermes-sessions.json"]?.sessions) ? parsedState["hermes-sessions.json"].sessions : [];
  const allWorktrees = [
    ...sessionList.map((session) => session?.worktree),
    parsedState["hermes-prefs.json"]?.coding?.active?.worktreePath,
    parsedState["hermes-prefs.json"]?.coding?.last?.worktreePath,
  ].filter(present);
  if (allWorktrees.length > 256) errors.push("generated-worktrees:entry-limit");
  const worktrees = allWorktrees.slice(0, 256);
  const configuredRoots = [
    root,
    config.coding?.worktreeBase,
    ...Object.values(config.coding?.repos || {}).map((repo) => repo?.path),
    ...Object.values(config.hermes?.repos || {}).map((repo) => repo?.path),
  ].filter(present).flatMap((candidate) => {
    try { return [fsImpl.realpathSync(String(candidate))]; } catch { return []; }
  });
  for (const [index, worktree] of [...new Set(worktrees)].entries()) {
    const label = `external-worktree-${index + 1}`;
    let worktreeReal;
    try {
      const stat = fsImpl.lstatSync(String(worktree));
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        errors.push(`${label}:unsafe-root`);
        continue;
      }
      worktreeReal = fsImpl.realpathSync(String(worktree));
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(`${label}:unavailable`);
      continue;
    }
    const contained = configuredRoots.some((allowed) => {
      const relative = path.relative(allowed, worktreeReal);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!contained) {
      errors.push(`${label}:outside-configured-roots`);
      continue;
    }
    for (const name of GENERATED_CONFIG_NAMES) {
      generatedCandidates.push({ file: path.join(worktreeReal, name), label: `${label}/${name}` });
    }
  }
  const seen = new Set();
  for (const candidate of generatedCandidates) {
    if (seen.has(candidate.file)) continue;
    seen.add(candidate.file);
    const read = readChecked(candidate.file, { fsImpl, errors, label: candidate.label });
    if (!read) continue;
    generatedConfigs.push({ path: candidate.label, content: read.text });
    sensitiveFiles.push({ path: candidate.label, mode: read.mode });
  }

  const coderLog = readChecked(path.join(logDir, "coder.log"), { fsImpl, errors, label: "logs/coder.log" });
  const auditLogs = coderLog ? [{ path: "logs/coder.log", content: coderLog.text }] : [];
  const securityState = parsedState["hermes-security.json"];
  const lockdownFiles = securityState?.lockdown === "locked" ? ["state/hermes-security.json"] : [];
  const securityStateMigrations = securityState?.lockdown === "normal"
    && securityState.localUnlockGeneration !== securityState.lockdownGeneration
    ? ["state/hermes-security.json:local-unlock-required"]
    : [];
  const marker = readChecked(path.join(stateDir, "ntfy-rotation-confirmed"), { fsImpl, errors, label: "state/ntfy-rotation-confirmed" });
  const runtime = {
    ...RUNTIME_SECURITY_FEATURES,
    childEnvAllowlist: Array.isArray(CHILD_ENV_ALLOW_KEYS) && Object.isFrozen(CHILD_ENV_ALLOW_KEYS),
    autopilotEnabled: parsedState["hermes-autopilot.json"]?.enabled === true,
  };
  return {
    config, env: selectedEnv, sensitiveFiles, generatedConfigs, auditLogs,
    lockdownFiles, securityLocks, securityStateMigrations,
    ntfyRotationMarkers: marker ? ["state/ntfy-rotation-confirmed"] : [], runtime, errors,
  };
}

export function renderHumanReport(report) {
  const lines = [`Hermes security check: ${report.counts.critical} critical, ${report.counts.high} high, ${report.counts.warn} warn`];
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
    if (argv[index] === "--json") json = true;
    else if (argv[index] === "--root" && typeof argv[index + 1] === "string") {
      root = path.resolve(argv[index + 1]);
      index += 1;
    } else throw new Error("invalid arguments");
  }
  return { root, json };
}

export function main({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let options;
  try { options = parseArgs(argv); }
  catch {
    stderr.write("Usage: npm run security:check -- [--json] [--root PATH]\nInvalid arguments.\n");
    return 2;
  }
  const report = evaluateSecurityPosture(collectSecuritySnapshot({ root: options.root, env }));
  stdout.write(`${options.json ? JSON.stringify(report, null, 2) : renderHumanReport(report)}\n`);
  return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();

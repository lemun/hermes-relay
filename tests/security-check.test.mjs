import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  collectSecuritySnapshot,
  evaluateSecurityPosture,
  renderHumanReport,
} from "../scripts/security-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_BOT_TOKEN = ["1".repeat(9), "A".repeat(35)].join(":");
const VALID_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

test("--json reports fixture findings without printing secret values", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hermes-security-"));
  mkdirSync(path.join(fixture, "state"));
  writeFileSync(path.join(fixture, "config.json"), JSON.stringify({ coding: { enabled: true } }));
  writeFileSync(path.join(fixture, ".env"), "TELEGRAM_BOT_TOKEN=do-not-print-me\n");

  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "security-check.mjs"), "--json", "--root", fixture], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });

  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.counts.critical > 0, true);
  assert.equal(report.findings.some((item) => item.id === "write-mode-with-invalid-telegram-bot-token"), true);
  assert.equal(report.findings.some((item) => item.id === "write-mode-without-totp"), true);
  assert.equal(result.stdout.includes("do-not-print-me"), false);
  assert.equal(result.stderr, "");
});

function ids(report, severity) {
  return report.findings.filter((finding) => finding.severity === severity).map((finding) => finding.id);
}

function fixtureTree(root, dir = root, output = []) {
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = statSync(file);
    if (stat.isDirectory()) fixtureTree(root, file, output);
    else output.push({ path: path.relative(root, file), mode: stat.mode & 0o777, content: readFileSync(file, "utf8") });
  }
  return output;
}

test("classifies every critical posture contradiction", () => {
  const report = evaluateSecurityPosture({
    config: {
      coding: { enabled: true },
      telegram: { botToken: VALID_BOT_TOKEN, totpSecret: VALID_TOTP_SECRET },
      boardApiKey: "board-secret",
    },
    env: {},
    sensitiveFiles: [{ path: ".env", mode: 0o640 }],
    generatedConfigs: [{ path: "/fixture/mcp-hermes.json", content: '{"TELEGRAM_BOT_TOKEN":"telegram-secret"}' }],
    lockdownFiles: ["state/LOCKDOWN"],
  });

  assert.deepEqual(ids(report, "critical"), [
    "write-mode-without-telegram-identity",
    "sensitive-file-permissions",
    "child-config-secret",
    "lockdown-not-enforced",
  ]);
  assert.equal(report.exitCode, 1);
});

test("treats enabled runtime autopilot as session-spawning posture during lockdown", () => {
  const report = evaluateSecurityPosture({
    config: { telegram: { botToken: VALID_BOT_TOKEN, totpSecret: VALID_TOTP_SECRET } },
    env: {},
    runtime: { autopilotEnabled: true },
    lockdownFiles: ["state/hermes.lockdown"],
  });

  assert.deepEqual(ids(report, "critical"), [
    "write-mode-without-telegram-identity",
    "lockdown-not-enforced",
  ]);
});

test("write posture requires locally valid bot-token and TOTP credentials", () => {
  const posture = {
    config: { boardApiKey: "board-write-secret", telegram: { allowedChatId: "123", allowedUserId: "456" } },
    runtime: { strictTelegramIdentity: true },
  };

  const missing = evaluateSecurityPosture(posture);
  assert.deepEqual(ids(missing, "critical"), [
    "write-mode-without-telegram-bot-token",
    "write-mode-without-totp",
  ]);
  assert.equal(missing.exitCode, 1);

  const malformed = evaluateSecurityPosture({
    ...posture,
    env: { TELEGRAM_BOT_TOKEN: "placeholder", HERMES_TOTP_SECRET: "not-base32!" },
  });
  assert.deepEqual(ids(malformed, "critical"), [
    "write-mode-with-invalid-telegram-bot-token",
    "write-mode-with-invalid-totp",
  ]);
  assert.equal(JSON.stringify(malformed).includes("not-base32!"), false);

  const valid = evaluateSecurityPosture({
    ...posture,
    env: { TELEGRAM_BOT_TOKEN: VALID_BOT_TOKEN, HERMES_TOTP_SECRET: VALID_TOTP_SECRET },
  });
  assert.deepEqual(ids(valid, "critical"), []);
  assert.equal(valid.exitCode, 0);
});

test("security-state lock presence is always a critical doctor finding", () => {
  const report = evaluateSecurityPosture({ securityLocks: [{ path: "state/hermes-security.json.lock" }] });
  assert.deepEqual(ids(report, "critical"), ["security-state-lock-present"]);
  assert.equal(report.exitCode, 1);
});

test("legacy normal security state requires an explicit local-unlock migration", () => {
  const report = evaluateSecurityPosture({
    securityStateMigrations: ["state/hermes-security.json:local-unlock-required"],
  });
  assert.deepEqual(ids(report, "critical"), ["security-state-local-unlock-required"]);
  assert.match(report.findings[0].remediation, /npm run security:control -- unlock/);
  assert.equal(report.exitCode, 1);
});

test("classifies host-capable child and separate Telegram identity risks as high", () => {
  const report = evaluateSecurityPosture({
    config: {
      coding: { enabled: true },
      hermes: { enabled: true, allowClaudeWriteSessions: true },
      telegram: { allowedChatId: "123", allowedUserId: "" },
    },
    env: { GH_TOKEN: "github-secret" },
  });

  assert.deepEqual(ids(report, "high"), [
    "legacy-claude-host-capable",
    "claude-write-sessions-enabled",
    "telegram-user-id-missing",
    "github-token-host-child",
  ]);
  assert.equal(report.exitCode, 1);
});

test("write/session posture always requires a separately enforced Telegram user ID", () => {
  const report = evaluateSecurityPosture({
    config: { hermes: { enabled: true }, telegram: { allowedChatId: "123" } },
    env: {},
  });

  assert.equal(ids(report, "high").includes("telegram-user-id-missing"), true);
  assert.equal(ids(report, "critical").includes("write-mode-without-telegram-identity"), true);
});

test("emits the three manual warnings and honors an ntfy rotation marker", () => {
  const withoutMarker = evaluateSecurityPosture({
    config: { telegram: { botToken: "secret" }, ntfy: { topic: "old-topic" } },
    env: {},
  });
  assert.deepEqual(ids(withoutMarker, "warn"), [
    "telegram-group-protection-manual",
    "ntfy-rotation-unconfirmed",
    "telegram-account-hygiene-manual",
  ]);

  const withMarker = evaluateSecurityPosture({
    config: { telegram: { botToken: "secret" }, ntfy: { topic: "new-topic" } },
    env: {},
    ntfyRotationMarkers: ["state/ntfy-rotation-confirmed"],
  });
  assert.equal(ids(withMarker, "warn").includes("ntfy-rotation-unconfirmed"), false);
});

test("renderers never expose configured or discovered secret values", () => {
  const secrets = ["bot-123:super-secret", "board-super-secret", "github-super-secret", "ntfy-super-secret"];
  const report = evaluateSecurityPosture({
    config: {
      coding: { enabled: true },
      telegram: { botToken: secrets[0] },
      boardApiKey: secrets[1],
      ntfy: { topic: secrets[3] },
    },
    env: { GH_TOKEN: secrets[2] },
    generatedConfigs: [{ path: `/fixture/${secrets[2]}/mcp.json`, content: JSON.stringify({ PAPERCLIP_BOARD_API_KEY: secrets[1] }) }],
  });
  const outputs = [JSON.stringify(report), renderHumanReport(report)];

  for (const output of outputs) {
    for (const secret of secrets) assert.equal(output.includes(secret), false);
  }
});

test("collectSecuritySnapshot reads fixture state and generated configs without mutation", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hermes-security-snapshot-"));
  const state = path.join(fixture, "state");
  const worktree = path.join(fixture, "child");
  mkdirSync(state);
  mkdirSync(worktree);
  writeFileSync(path.join(fixture, "config.json"), JSON.stringify({ telegram: {}, coding: { enabled: false } }), { mode: 0o600 });
  writeFileSync(path.join(fixture, ".env"), "TELEGRAM_BOT_TOKEN=test-only\n", { mode: 0o600 });
  writeFileSync(path.join(state, "hermes-sessions.json"), JSON.stringify({ sessions: [{ worktree }] }), { mode: 0o600 });
  writeFileSync(path.join(state, "hermes-security.json.lock"), "crashed writer", { mode: 0o600 });
  writeFileSync(path.join(worktree, "mcp-hermes.json"), "{}", { mode: 0o600 });
  writeFileSync(path.join(state, "LOCKDOWN"), "operator emergency stop\n", { mode: 0o600 });

  const before = fixtureTree(fixture);
  const snapshot = collectSecuritySnapshot({ root: fixture, env: {} });
  const after = fixtureTree(fixture);

  assert.equal(snapshot.sensitiveFiles.some((file) => file.path === ".env" && file.mode === 0o600), true);
  assert.equal(snapshot.sensitiveFiles.some((file) => file.path.startsWith("state/entry-") && file.mode === 0o600), true);
  assert.deepEqual(snapshot.generatedConfigs.map((file) => file.path), ["external-worktree-1/mcp-hermes.json"]);
  assert.deepEqual(snapshot.lockdownFiles, [], "legacy marker text is not treated as enforced lockdown state");
  assert.deepEqual(snapshot.securityLocks, [{ path: "state/hermes-security.json.lock" }]);
  assert.equal(ids(evaluateSecurityPosture(snapshot), "critical").includes("security-state-lock-present"), true);
  assert.deepEqual(after, before);
});

test("missing and malformed critical inputs fail nonzero", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hermes-security-incomplete-"));
  let report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  assert.equal(report.exitCode, 1);
  assert.equal(ids(report, "critical").includes("security-scan-incomplete"), true);

  writeFileSync(path.join(fixture, "config.json"), "{malformed");
  report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  assert.equal(report.exitCode, 1);
  assert.equal(report.incomplete.some((item) => item === "config.json:malformed"), true);

  writeFileSync(path.join(fixture, "config.json"), "{}");
  report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  assert.equal(report.exitCode, 1);
  for (const name of ["hermes-sessions.json", "hermes-prefs.json", "hermes-autopilot.json", "hermes-security.json"]) {
    assert.equal(report.incomplete.includes(`state/${name}:unavailable`), true);
  }
});

test("malformed state shapes and worktree scan overflow become controlled incomplete findings", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hermes-security-shapes-"));
  const state = path.join(fixture, "state");
  mkdirSync(state);
  writeFileSync(path.join(fixture, "config.json"), "{}");
  writeFileSync(path.join(state, "hermes-sessions.json"), JSON.stringify({ sessions: { bad: true } }));
  writeFileSync(path.join(state, "hermes-prefs.json"), "{}");
  writeFileSync(path.join(state, "hermes-autopilot.json"), "{}");
  writeFileSync(path.join(state, "hermes-security.json"), JSON.stringify({ lockdown: "normal", totpCounters: [], capabilities: [] }));
  let report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  assert.equal(report.exitCode, 1);
  assert.equal(report.incomplete.includes("state/hermes-sessions.json:invalid-shape"), true);

  writeFileSync(path.join(state, "hermes-sessions.json"), JSON.stringify({ sessions: [] }));
  writeFileSync(path.join(state, "hermes-security.json"), JSON.stringify({
    version: 1,
    lockdown: "normal",
    lockdownGeneration: 2,
    localUnlockGeneration: 3,
    totpCounters: [],
    capabilities: [],
  }));
  report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  assert.equal(report.incomplete.includes("state/hermes-security.json:invalid-shape"), true);

  writeFileSync(path.join(state, "hermes-security.json"), JSON.stringify({
    version: 1,
    lockdown: "normal",
    lockdownGeneration: 2,
    totpCounters: [],
    capabilities: [],
  }));
  const migrationSnapshot = collectSecuritySnapshot({ root: fixture, env: {} });
  assert.deepEqual(migrationSnapshot.securityStateMigrations, ["state/hermes-security.json:local-unlock-required"]);
  assert.equal(ids(evaluateSecurityPosture(migrationSnapshot), "critical").includes("security-state-local-unlock-required"), true);

  const worktrees = Array.from({ length: 257 }, (_, index) => ({ worktree: path.join(fixture, `worktree-${index}`) }));
  writeFileSync(path.join(state, "hermes-sessions.json"), JSON.stringify({ sessions: worktrees }));
  report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  assert.equal(report.incomplete.includes("generated-worktrees:entry-limit"), true);
});

test("symlinked sensitive state fails closed without reading its target", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hermes-security-symlink-"));
  mkdirSync(path.join(fixture, "state"));
  writeFileSync(path.join(fixture, "config.json"), JSON.stringify({ hermes: { enabled: true }, telegram: { allowedChatId: "1", allowedUserId: "2" } }));
  const target = path.join(fixture, "outside-secret");
  writeFileSync(target, "TOP-SECRET-CANARY");
  symlinkSync(target, path.join(fixture, "state", "hermes-security.json"));
  const report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  const output = JSON.stringify(report);
  assert.equal(report.exitCode, 1);
  assert.equal(output.includes("TOP-SECRET-CANARY"), false);
  assert.equal(ids(report, "critical").includes("security-scan-incomplete"), true);
});

test("generated-config symlinks and excessive traversal depth fail closed", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hermes-security-bounds-"));
  const state = path.join(fixture, "state");
  const worktree = path.join(fixture, "child");
  mkdirSync(state);
  mkdirSync(worktree);
  writeFileSync(path.join(fixture, "config.json"), "{}");
  writeFileSync(path.join(state, "hermes-sessions.json"), JSON.stringify({ sessions: [{ worktree }] }));
  const target = path.join(fixture, "generated-secret");
  writeFileSync(target, "GENERATED-SECRET-CANARY");
  symlinkSync(target, path.join(worktree, "mcp-hermes.json"));
  let deep = state;
  for (let index = 0; index < 14; index += 1) {
    deep = path.join(deep, `d${index}`);
    mkdirSync(deep);
  }
  const report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  assert.equal(report.exitCode, 1);
  assert.equal(report.incomplete.some((item) => /symlink$/.test(item)), true);
  assert.equal(report.incomplete.some((item) => /depth-limit$/.test(item)), true);
  assert.equal(JSON.stringify(report).includes("GENERATED-SECRET-CANARY"), false);
});

test("coder.log is scanned for prompt-derived audit fields without echoing values", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "hermes-security-coderlog-"));
  mkdirSync(path.join(fixture, "logs"));
  writeFileSync(path.join(fixture, "config.json"), "{}");
  writeFileSync(path.join(fixture, "logs", "coder.log"), JSON.stringify({ promptSha256: "do-not-echo-this" }), { mode: 0o600 });
  const report = evaluateSecurityPosture(collectSecuritySnapshot({ root: fixture, env: {} }));
  assert.equal(ids(report, "critical").includes("coder-audit-disclosure"), true);
  assert.equal(JSON.stringify(report).includes("do-not-echo-this"), false);
});

test("invalid argv never echoes attacker-controlled text", () => {
  const canary = "ARGV-SECRET-CANARY";
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "security-check.mjs"), canary], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
});

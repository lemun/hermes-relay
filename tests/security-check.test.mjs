import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
      telegram: { botToken: "telegram-secret" },
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
    "lockdown-write-contradiction",
  ]);
  assert.equal(report.exitCode, 1);
});

test("treats enabled runtime autopilot as session-spawning posture during lockdown", () => {
  const report = evaluateSecurityPosture({
    config: { telegram: {} },
    env: {},
    runtime: { autopilotEnabled: true },
    lockdownFiles: ["state/hermes.lockdown"],
  });

  assert.deepEqual(ids(report, "critical"), [
    "write-mode-without-telegram-identity",
    "lockdown-write-contradiction",
  ]);
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
  assert.equal(report.exitCode, 0);
});

test("does not require a separate Telegram user ID before that configuration exists", () => {
  const report = evaluateSecurityPosture({
    config: { hermes: { enabled: true }, telegram: { allowedChatId: "123" } },
    env: {},
  });

  assert.equal(ids(report, "high").includes("telegram-user-id-missing"), false);
  assert.equal(ids(report, "critical").includes("write-mode-without-telegram-identity"), false);
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
  writeFileSync(path.join(worktree, "mcp-hermes.json"), "{}", { mode: 0o600 });
  writeFileSync(path.join(state, "LOCKDOWN"), "operator emergency stop\n", { mode: 0o600 });

  const before = fixtureTree(fixture);
  const snapshot = collectSecuritySnapshot({ root: fixture, env: {} });
  const after = fixtureTree(fixture);

  assert.equal(snapshot.sensitiveFiles.some((file) => file.path === ".env" && file.mode === 0o600), true);
  assert.equal(snapshot.sensitiveFiles.some((file) => file.path === "state/hermes-sessions.json"), true);
  assert.deepEqual(snapshot.generatedConfigs.map((file) => file.path), ["child/mcp-hermes.json"]);
  assert.deepEqual(snapshot.lockdownFiles, ["state/LOCKDOWN"]);
  assert.deepEqual(after, before);
});

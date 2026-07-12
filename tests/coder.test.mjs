import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as coder from "../lib/coder.mjs";

const {
  slugify,
  buildSessionArgs,
  buildLegacyChildEnv,
  buildPromptAuditMetadata,
  buildStartAuditRecord,
  writeAuditLine,
  finalizeResult,
  EFFORTS,
} = coder;

test("legacy coding child strips service secrets but preserves runtime environment", () => {
  assert.equal(typeof buildLegacyChildEnv, "function");
  const secrets = {
    TELEGRAM_BOT_TOKEN: "telegram-secret",
    PAPERCLIP_BOARD_API_KEY: "board-secret",
    NTFY_TOPIC: "private-topic",
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "github-secret",
    OPENAI_API_KEY: "openai-secret",
    ANTHROPIC_API_KEY: "anthropic-secret",
    HERMES_ASK_TOKEN: "ask-secret",
  };
  const env = buildLegacyChildEnv({
    ...secrets,
    PATH: "/usr/local/bin:/usr/bin",
    HOME: "/Users/tester",
    CLAUDE_CONFIG_DIR: "/Users/tester/.claude",
    CLAUDE_CODE_OAUTH_TOKEN: "subscription-auth-survives",
    HERMES_RUNTIME_FLAG: "survives",
  });

  for (const key of Object.keys(secrets)) assert.equal(key in env, false, `${key} must be absent`);
  assert.equal(env.PATH, "/usr/local/bin:/usr/bin");
  assert.equal(env.HOME, "/Users/tester");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/Users/tester/.claude");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "subscription-auth-survives");
  assert.equal(env.HERMES_RUNTIME_FLAG, "survives");
});

test("audit log records only prompt length and digest in private storage", () => {
  assert.equal(typeof buildPromptAuditMetadata, "function");
  assert.equal(typeof buildStartAuditRecord, "function");
  assert.equal(typeof writeAuditLine, "function");
  const root = mkdtempSync(path.join(tmpdir(), "hermes-coder-test-"));
  const logPath = path.join(root, "private-logs", "coder.log");
  const prompt = "sensitiveprompt 🔐 do not disclose";
  const record = buildStartAuditRecord({
    prompt,
    branch: "phone/sensitiveprompt-abcd1234",
    sessionId: "session-1",
    repoKey: "repo",
    model: "sonnet",
    effort: "high",
    resume: false,
  });

  mkdirSync(path.dirname(logPath), { mode: 0o755 });
  writeFileSync(logPath, "", { mode: 0o644 });
  chmodSync(path.dirname(logPath), 0o755);
  chmodSync(logPath, 0o644);

  writeAuditLine(logPath, { ...record, prompt, branch: "phone/sensitiveprompt-abcd1234" });

  const raw = readFileSync(logPath, "utf8");
  const written = JSON.parse(raw);
  assert.equal(raw.includes(prompt), false);
  assert.equal(raw.includes("sensitiveprompt"), false);
  assert.equal("prompt" in written, false);
  assert.equal("branch" in written, false);
  assert.equal(written.promptBytes, Buffer.byteLength(prompt, "utf8"));
  assert.equal(written.promptSha256, createHash("sha256").update(prompt, "utf8").digest("hex"));
  assert.equal(statSync(path.dirname(logPath)).mode & 0o777, 0o700);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
});

test("slugify produces a safe, bounded branch fragment", () => {
  assert.equal(slugify("Refactor the Onboarding screen!"), "refactor-the-onboarding-screen");
  assert.equal(slugify("   "), "task");
  assert.equal(slugify(""), "task");
  assert.equal(slugify(undefined), "task");
  assert.equal(slugify("a".repeat(100)).length, 30);          // capped
  assert.match(slugify("HOM-27: fix /api?x=1"), /^[a-z0-9-]+$/); // only url-safe chars
  assert.equal(/^-|-$/.test(slugify("--lead--")), false);     // no leading/trailing dash
});

test("buildSessionArgs always enables write access via worktree-scoped bypass", () => {
  const a = buildSessionArgs({ prompt: "do it", modelId: "claude-sonnet-4-6", effort: "high", worktreePath: "/wt", sessionId: "sid-1", resume: false });
  assert.ok(a.includes("--effort") && a[a.indexOf("--effort") + 1] === "high");
  assert.ok(a.includes("--permission-mode") && a[a.indexOf("--permission-mode") + 1] === "bypassPermissions");
  assert.ok(a.includes("--dangerously-skip-permissions"));
  assert.ok(a.includes("--add-dir") && a[a.indexOf("--add-dir") + 1] === "/wt");
  assert.ok(a.includes("--output-format") && a[a.indexOf("--output-format") + 1] === "stream-json");
  assert.ok(a.includes("--model") && a[a.indexOf("--model") + 1] === "claude-sonnet-4-6");
});

test("buildSessionArgs starts a fresh session with --session-id, not --resume", () => {
  const fresh = buildSessionArgs({ prompt: "p", modelId: "m", effort: "max", worktreePath: "/wt", sessionId: "sid-2", resume: false });
  assert.ok(fresh.includes("--session-id") && fresh[fresh.indexOf("--session-id") + 1] === "sid-2");
  assert.equal(fresh.includes("--resume"), false);
});

test("buildSessionArgs resumes with --resume on the prior session id", () => {
  const resumed = buildSessionArgs({ prompt: "p", modelId: "m", effort: "low", worktreePath: "/wt", sessionId: "sid-3", resume: true });
  assert.ok(resumed.includes("--resume") && resumed[resumed.indexOf("--resume") + 1] === "sid-3");
  assert.equal(resumed.includes("--session-id"), false);
});

test("EFFORTS exposes the CLI's effort levels", () => {
  assert.deepEqual(EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
});

test("finalizeResult: ok only on a clean, uninterrupted exit", () => {
  const base = { exitCode: 0, isError: false, canceled: false, timedOut: false, baseSha: "a", headSha: "b", diffNames: "x.js" };
  assert.equal(finalizeResult(base).ok, true);
  assert.equal(finalizeResult({ ...base, exitCode: 1 }).ok, false);
  assert.equal(finalizeResult({ ...base, isError: true }).ok, false);
  assert.equal(finalizeResult({ ...base, canceled: true }).ok, false);
  assert.equal(finalizeResult({ ...base, timedOut: true }).ok, false);
});

test("finalizeResult: counts changed files and detects no-op (same sha) runs", () => {
  assert.equal(finalizeResult({ exitCode: 0, baseSha: "a", headSha: "b", diffNames: "x.js\ny.ts\nz.md" }).filesChanged, 3);
  // empty diff name list → zero files
  assert.equal(finalizeResult({ exitCode: 0, baseSha: "a", headSha: "b", diffNames: "" }).filesChanged, 0);
  // head === base → nothing changed, regardless of any stray diffNames
  const same = finalizeResult({ exitCode: 0, baseSha: "a", headSha: "a", diffNames: "x.js" });
  assert.equal(same.changed, false);
  assert.equal(same.filesChanged, 0);
});

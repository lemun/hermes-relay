import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripRetiredConfig, stripRetiredDotenv } from "../lib/retire-paperclip.mjs";
import { retirePaperclipConfig } from "../scripts/retire-paperclip-config.mjs";

test("dotenv migration removes only retired assignments", () => {
  const result = stripRetiredDotenv([
    "TELEGRAM_BOT_TOKEN=keep",
    "export NTFY_TOPIC=remove",
    " # NTFY_SERVER=comment-only",
    "PAPERCLIP_BOARD_API_KEY=remove-too",
    "HERMES_TOTP_SECRET=keep-too",
    "",
  ].join("\n"));
  assert.deepEqual(result.removed, ["NTFY_TOPIC", "PAPERCLIP_BOARD_API_KEY"]);
  assert.match(result.content, /TELEGRAM_BOT_TOKEN=keep/);
  assert.match(result.content, /HERMES_TOTP_SECRET=keep-too/);
  assert.match(result.content, /# NTFY_SERVER=comment-only/);
  assert.doesNotMatch(result.content, /^\s*(?:export\s+)?(?:NTFY_TOPIC|PAPERCLIP_BOARD_API_KEY)=/m);
});

test("config migration removes retired top-level keys without mutating input", () => {
  const input = { telegram: {}, hermes: { enabled: true }, ntfy: { topic: "secret" }, push: {}, companyId: "old" };
  const result = stripRetiredConfig(input);
  assert.deepEqual(result.config, { telegram: {}, hermes: { enabled: true } });
  assert.deepEqual(result.removed, ["companyId", "ntfy", "push"]);
  assert.equal(input.companyId, "old");
});

test("filesystem migration is private, atomic, idempotent, and never rewrites unrelated keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retire-paperclip-"));
  const envFile = path.join(root, ".env");
  const configFile = path.join(root, "config.json");
  try {
    fs.writeFileSync(envFile, "TELEGRAM_BOT_TOKEN=keep\nNTFY_TOPIC=remove\n", { mode: 0o600 });
    fs.writeFileSync(configFile, JSON.stringify({ telegram: {}, paperclipBase: "http://127.0.0.1:3100" }), { mode: 0o600 });
    const first = retirePaperclipConfig({ root });
    assert.deepEqual(first.envKeys, ["NTFY_TOPIC"]);
    assert.deepEqual(first.configKeys, ["paperclipBase"]);
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(envFile, "utf8"), /TELEGRAM_BOT_TOKEN=keep/);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, "utf8")), { telegram: {} });
    assert.deepEqual(retirePaperclipConfig({ root }), { envKeys: [], configKeys: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem migration refuses symlinked secret files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "retire-paperclip-symlink-"));
  const outside = path.join(root, "outside");
  try {
    fs.writeFileSync(outside, "NTFY_TOPIC=do-not-touch\n", { mode: 0o600 });
    fs.symlinkSync(outside, path.join(root, ".env"));
    fs.writeFileSync(path.join(root, "config.json"), "{}", { mode: 0o600 });
    assert.throws(() => retirePaperclipConfig({ root }), /symbolic link|private file/i);
    assert.equal(fs.readFileSync(outside, "utf8"), "NTFY_TOPIC=do-not-touch\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

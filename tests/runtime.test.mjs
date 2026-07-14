import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatConfigError,
  isConfigError,
  loadConfig,
  loadPrefs,
  savePrefs,
  writeJsonAtomic,
} from "../lib/runtime.mjs";

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test("writeJsonAtomic writes private valid JSON without a temporary-file leak", () => {
  const root = tmp("hermes-runtime-");
  const file = path.join(root, "state", "value.json");
  const previousUmask = process.umask(0o000);
  try {
    writeJsonAtomic(file, { value: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { value: 1 });
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".tmp-")), false);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preferences tolerate missing or corrupt input and save privately", () => {
  const root = tmp("hermes-prefs-");
  const file = path.join(root, "state", "hermes-prefs.json");
  try {
    assert.deepEqual(loadPrefs({ file }), {});
    savePrefs({ lang: "en" }, { file });
    assert.deepEqual(loadPrefs({ file }), { lang: "en" });
    fs.writeFileSync(file, "{corrupt", { mode: 0o600 });
    assert.deepEqual(loadPrefs({ file }), {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig reports missing, malformed, and invalid configuration", () => {
  const root = tmp("hermes-config-");
  const configPath = path.join(root, "config.json");
  const options = { configPath, dotenvPath: null };
  try {
    assert.throws(() => loadConfig(options), (error) => {
      assert.equal(isConfigError(error), true);
      assert.equal(error.kind, "missing");
      assert.match(formatConfigError(error), /cp config\.example\.json config\.json/);
      return true;
    });
    fs.writeFileSync(configPath, "{ not json");
    assert.throws(() => loadConfig(options), (error) => error.kind === "malformed");
    fs.writeFileSync(configPath, "[]");
    assert.throws(() => loadConfig(options), (error) => error.kind === "invalid");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig applies conservative Hermes defaults without Paperclip services", () => {
  const root = tmp("hermes-config-defaults-");
  const configPath = path.join(root, "config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify({ telegram: {}, coding: {}, hermes: {} }));
    const cfg = loadConfig({ configPath, dotenvPath: null });
    assert.equal(cfg.coding.enabled, false);
    assert.equal(cfg.hermes.enabled, false);
    assert.equal(cfg.hermes.defaultEngine, "codex");
    assert.equal(cfg.paperclipBase, undefined);
    assert.equal(cfg.ntfy, undefined);
    assert.equal(cfg.push, undefined);
    assert.equal(cfg.selfcheck, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

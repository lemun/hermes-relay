import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { applyInstall, installPaths, lintPlists, planRetention, renderInstallArtifacts } from "../lib/install-update.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "install-update.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hermes-install-"));

function fixtureRoot() {
  const root = tmp();
  fs.mkdirSync(path.join(root, "launchd"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs", "sessions", "sess-done"), { recursive: true });
  fs.mkdirSync(path.join(root, "logs", "sessions", "sess-running"), { recursive: true });
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  fs.writeFileSync(path.join(root, "launchd", "run-node.sh"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(root, "logs", "hermes.log"), "old service output\n");
  fs.writeFileSync(path.join(root, "state", "hermes-sessions.json"), JSON.stringify({ sessions: [
    { id: "sess-done", status: "done", endedAt: "2026-01-01T00:00:00Z" },
    { id: "sess-running", status: "running", endedAt: null },
  ] }));
  const old = new Date("2026-01-02T00:00:00Z");
  fs.utimesSync(path.join(root, "logs", "hermes.log"), old, old);
  return root;
}

test("installer dry-run renders requested root rather than its temporary checkout", () => {
  const temporaryCheckout = tmp();
  for (const dir of ["launchd", "lib", "scripts"]) {
    fs.cpSync(path.join(ROOT, dir), path.join(temporaryCheckout, dir), { recursive: true });
  }
  const result = spawnSync(process.execPath, [
    path.join(temporaryCheckout, "scripts", "install-update.mjs"),
    "--root", ROOT,
    "--allow-worktree",
    "--dry-run",
  ], { cwd: temporaryCheckout, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Dry run: no files were changed\./);
  assert.match(result.stdout, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.stdout, new RegExp(temporaryCheckout.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stdout, /plutil: (OK|unavailable)/);
});

test("plutil absence is tolerated only for non-macOS dry-run callers", () => {
  const missingPlutil = () => {
    const error = new Error("missing plutil");
    error.code = "ENOENT";
    throw error;
  };
  const plists = [{ name: "fixture.plist", content: "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict/></plist>" }];

  assert.equal(lintPlists(plists, { execFileSyncImpl: missingPlutil, platform: "linux" }), false);
  assert.throws(() => lintPlists(plists, { execFileSyncImpl: missingPlutil, platform: "darwin" }), /missing plutil/);
});

test("rendered launchd jobs apply a 077 umask to service logs", () => {
  const artifacts = renderInstallArtifacts({ templateRoot: ROOT, liveRoot: "/safe/live/root" });
  for (const plist of artifacts.plists) {
    assert.match(plist.content, /<key>Umask<\/key>\s*<string>077<\/string>/, plist.name);
  }
});

test("installer creates only private Hermes service logs without chmodding the checkout", () => {
  const root = tmp();
  const launchAgents = path.join(tmp(), "Library", "LaunchAgents");
  const logs = path.join(root, "logs");
  const previousUmask = process.umask(0o000);
  try {
    fs.chmodSync(root, 0o755);
    fs.mkdirSync(logs, { mode: 0o777 });
    fs.writeFileSync(path.join(logs, "hermes.log"), "old log\n", { mode: 0o666 });
    const result = applyInstall({
      artifacts: { plists: [] },
      paths: { launchAgents, logs, retired: [] },
      now: new Date("2026-07-12T12:00:00Z"),
    });
    assert.equal(fs.statSync(root).mode & 0o777, 0o755);
    assert.deepEqual(result, { backups: [], retired: [] });
    assert.equal(fs.statSync(logs).mode & 0o777, 0o700);
    for (const name of ["hermes.log", "hermes.err.log"]) {
      assert.equal(fs.statSync(path.join(logs, name)).mode & 0o777, 0o600, name);
    }
  } finally {
    process.umask(previousUmask);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(path.dirname(launchAgents)), { recursive: true, force: true });
  }
});

test("installer lists only retired artifacts at known paths, no guessed LaunchAgent labels", () => {
  const paths = installPaths({ liveRoot: "/srv/hermes", home: "/home/op" });
  assert.deepEqual(paths.retired, [path.join("/srv/hermes", "mcp-config.json")]);
});

test("applyInstall removes the retired files it is given", () => {
  const root = tmp();
  const home = tmp();
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  fs.mkdirSync(launchAgents, { recursive: true });
  const retired = [
    path.join(launchAgents, "com.example.paperclip-notifier.plist"),
    path.join(launchAgents, "com.example.paperclip-selfcheck.plist"),
    path.join(root, "mcp-config.json"),
  ];
  for (const file of retired) fs.writeFileSync(file, "retired\n");
  try {
    const result = applyInstall({
      artifacts: { plists: [] },
      paths: { launchAgents, logs: path.join(root, "logs"), retired },
    });
    assert.deepEqual(result.retired, retired);
    for (const file of retired) assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("retention dry-run only proposes old service logs and completed session artifacts", () => {
  const root = fixtureRoot();
  const home = tmp();
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--prune",
    "--retention-days", "14",
    "--dry-run",
  ], { env: { ...process.env, HOME: home }, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Would prune service log: .*hermes\.log/);
  assert.match(result.stdout, /Would prune completed session: sess-done/);
  assert.match(result.stdout, /Protect active session: sess-running/);
  assert.equal(fs.existsSync(path.join(root, "logs", "hermes.log")), true);
  assert.equal(fs.existsSync(path.join(root, "logs", "sessions", "sess-done")), true);
  assert.equal(fs.existsSync(path.join(root, "logs", "sessions", "sess-running")), true);
});

test("retention never follows a session id outside logs/sessions", () => {
  const root = fixtureRoot();
  const outside = path.join(root, "logs", "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, "state", "hermes-sessions.json"), JSON.stringify({ sessions: [
    { id: "../outside", status: "done", endedAt: "2026-01-01T00:00:00Z" },
  ] }));

  const plan = planRetention({ root, retentionDays: 14, now: new Date("2026-07-12T00:00:00Z") });
  assert.deepEqual(plan.completedSessions, []);
  assert.equal(fs.existsSync(outside), true);
});

test("invalid retention settings fail before an apply can write files", () => {
  const root = fixtureRoot();
  const home = tmp();
  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--root", root,
    "--prune",
    "--retention-days", "nope",
    "--apply",
  ], { env: { ...process.env, HOME: home }, encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /retention-days/);
  assert.equal(fs.existsSync(path.join(root, "mcp-config.json")), false);
  assert.equal(fs.existsSync(path.join(home, "Library", "LaunchAgents")), false);
});

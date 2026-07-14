import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  activeFinisherEntries,
  buildOpsModel,
  classifyLogWarnings,
  gatherApplianceSnapshot,
  parseLaunchctlDisabled,
  parseLaunchctlPrint,
  renderApplianceReport,
  renderOpsReport,
} from "../lib/ops.mjs";

const NOW = new Date("2026-07-07T12:00:00Z");

test("parseLaunchctlPrint extracts running pid", () => {
  const parsed = parseLaunchctlPrint("state = running\npid = 12345\n");
  assert.deepEqual(parsed, { loaded: true, running: true, pid: 12345, state: "running" });
  assert.equal(parseLaunchctlPrint("").running, false);
});

test("parseLaunchctlDisabled recognizes an explicitly disabled generated plist label", () => {
  const text = 'disabled services = {\n  "com.example.hermes-bot" => true\n}';
  assert.equal(parseLaunchctlDisabled(text, "com.example.hermes-bot"), true);
  assert.equal(parseLaunchctlDisabled(text, "com.example.other"), false);
});

function applianceFixture({ config = {}, missing = false, warning = false, disabledText = "", retiredLoaded = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appliance-"));
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    hermes: { enabled: false },
    ...config,
  }));
  if (warning) fs.writeFileSync(path.join(root, "logs", "hermes.err.log"), "ok\n[service] failed to poll\n");
  const exec = async (bin, args) => {
    if (bin === "git") return { code: 0, stdout: "abc123\n", stderr: "" };
    if (args[0] === "print-disabled") return { code: 0, stdout: disabledText, stderr: "" };
    const label = args[1].split("/").at(-1);
    if (label.startsWith("com.example.paperclip-")) {
      return label === retiredLoaded
        ? { code: 0, stdout: "state = running\npid = 999\n", stderr: "" }
        : { code: 113, stdout: "", stderr: "not found" };
    }
    if (missing) return { code: 113, stdout: "", stderr: "not found" };
    return { code: 0, stdout: "state = running\npid = 321\n", stderr: "" };
  };
  return gatherApplianceSnapshot({ root, exec });
}

test("Hermes appliance snapshot is healthy when its only launchd job is running", async () => {
  const snapshot = await applianceFixture();
  assert.equal(snapshot.ok, true);
  assert.deepEqual(snapshot.services.map((service) => service.key), ["hermes"]);
  assert.match(renderApplianceReport(snapshot), /Hermes bot: enabled, healthy; pipeline disabled/);
  assert.doesNotMatch(renderApplianceReport(snapshot), /Paperclip|notifier|selfcheck/i);
});

test("missing Hermes service is broken", async () => {
  const snapshot = await applianceFixture({ missing: true });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.next, /Hermes bot: launchd service is missing or unloaded/);
});

test("a still-loaded retired service makes appliance health fail", async () => {
  const snapshot = await applianceFixture({ retiredLoaded: "com.example.paperclip-notifier" });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.next, /Retired service is still loaded/);
  assert.match(renderApplianceReport(snapshot), /com\.example\.paperclip-notifier/);
});

test("recent Hermes warning log is surfaced", async () => {
  const snapshot = await applianceFixture({ warning: true });
  assert.equal(snapshot.services[0].logs.warningCount, 1);
  assert.match(snapshot.problems.join("\n"), /Hermes bot: 1 recent warning line/);
  assert.match(renderApplianceReport(snapshot), /Recent Hermes bot warning:.*failed to poll/);
});

test("classifyLogWarnings finds concerning recent log lines", () => {
  const logs = classifyLogWarnings("ok\n[hermes] failed to poll GitHub\nstill ok\n");
  assert.equal(logs.checkedLines, 3);
  assert.equal(logs.warningCount, 1);
  assert.match(logs.lastWarning, /failed to poll/);
});

test("activeFinisherEntries excludes done and parked states", () => {
  const entries = activeFinisherEntries({
    "rn#1": { stage: "audit" },
    "rn#2": { stage: "done" },
    "rn#3": { stage: "parked" },
  });
  assert.deepEqual(entries.map(([key]) => key), ["rn#1"]);
});

test("buildOpsModel leads with no action when the appliance is healthy", () => {
  const model = buildOpsModel({
    configPresent: true,
    hermesEnabled: true,
    launchd: { running: true, pid: 1 },
    github: { ok: true },
    telegram: { ok: true, webhookUrl: "" },
    codex: { ok: true, version: "codex 1" },
    repos: { rn: { path: "/repo", slug: "owner/repo" } },
    repoProbes: { rn: { exists: true } },
    sessions: { sessions: [] },
    pendingQuestions: [],
    finishers: {},
    logs: { warningCount: 0, lastWarning: "" },
  }, { now: NOW });
  assert.equal(model.warnings.length, 0);
  assert.match(model.next, /No ops action needed/);
});

test("renderOpsReport surfaces stale recovery paths and concrete owner actions", () => {
  const text = renderOpsReport({
    git: { sha: "abcdef123456" },
    configPresent: true,
    hermesEnabled: true,
    launchd: { running: true, pid: 99 },
    github: { ok: true },
    telegram: { ok: true, webhookUrl: "" },
    codex: { ok: true, version: "codex 0.1" },
    repos: { rn: { path: "/repo", slug: "owner/repo" } },
    repoProbes: { rn: { exists: true } },
    sessions: {
      sessions: [
        {
          id: "sess-orphan",
          status: "orphaned",
          repoKey: "rn",
          issue: 42,
          role: "implementer",
          engine: "codex",
          worktree: "/missing",
          startedAt: "2026-07-06T00:00:00Z",
        },
      ],
    },
    pendingQuestions: [{ id: "q-old", repoKey: "rn", issue: 42, askedAt: "2026-07-06T00:00:00Z" }],
    finishers: {
      "rn#42": {
        repoKey: "rn",
        issue: 42,
        prNumber: 9,
        stage: "audit",
        startedAt: "2026-07-06T00:00:00Z",
        worktree: "/missing-fin",
        branch: "hermes/42-x",
      },
    },
    pathExists: { "/missing": false, "/missing-fin": false },
    branchExists: { "rn:hermes/42-x": false },
    logs: { warningCount: 1, lastWarning: "[hub] fatal-ish thing" },
    askTimeoutHours: 8,
  }, { now: NOW, staleSessionHours: 12, staleFinisherHours: 24 });

  assert.match(text, /Next:/);
  assert.match(text, /Orphaned: sess-orphan rn#42 implementer\/codex orphaned/);
  assert.match(text, /Old questions: rn#42 q-old/);
  assert.match(text, /Missing worktrees:/);
  assert.match(text, /Missing branches: rn#42: hermes\/42-x/);
  assert.match(text, /\/ops resume sess-orphan/);
  assert.match(text, /\/ops retry rn#42/);
  assert.match(text, /\/status for work queue/);
});

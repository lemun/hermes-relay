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
  const text = 'disabled services = {\n  "com.example.paperclip-selfcheck" => true\n}';
  assert.equal(parseLaunchctlDisabled(text, "com.example.paperclip-selfcheck"), true);
  assert.equal(parseLaunchctlDisabled(text, "com.example.paperclip-notifier"), false);
});

function applianceFixture({
  config = {}, heartbeatAgeMs = 30_000, missingLabel = "", apiOk = true,
  warningFile = "", disabledText = "",
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appliance-"));
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    paperclipBase: "http://127.0.0.1:3100",
    selfcheck: { enabled: true, notifierWedgedMinutes: 5, healthPath: "/api/health" },
    hermes: { enabled: false },
    ...config,
  }));
  fs.writeFileSync(path.join(root, "state", "notifier-heartbeat.json"), JSON.stringify({
    at: NOW.getTime() - heartbeatAgeMs,
    lastTickStatus: "ok",
    lastPushStatus: "ok",
    consecutivePushFailures: 0,
    progress: { completed: 2, total: 2 },
  }));
  if (warningFile) fs.writeFileSync(path.join(root, "logs", warningFile), "ok\n[service] failed to poll\n");
  const exec = async (bin, args) => {
    if (bin === "git") return { code: 0, stdout: "abc123\n", stderr: "" };
    if (args[0] === "print-disabled") return { code: 0, stdout: disabledText, stderr: "" };
    const label = args[1].split("/").at(-1);
    if (label === missingLabel) return { code: 113, stdout: "", stderr: "not found" };
    if (label === "com.example.paperclip-selfcheck") {
      return { code: 0, stdout: "state = not running\nlast exit code = 0\n", stderr: "" };
    }
    return { code: 0, stdout: "state = running\npid = 321\n", stderr: "" };
  };
  const fetchImpl = async () => ({
    ok: apiOk,
    status: apiOk ? 200 : 503,
    json: async () => apiOk ? ({ status: "ok" }) : ({}),
  });
  return gatherApplianceSnapshot({ root, now: NOW.getTime(), exec, fetchImpl });
}

test("full appliance snapshot is healthy with running keepalive jobs and a loaded selfcheck one-shot", async () => {
  const snapshot = await applianceFixture();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.services.find((service) => service.key === "selfcheck").launchd.running, false);
  assert.match(renderApplianceReport(snapshot), /Hermes bot: enabled, healthy; v2 disabled/);
  assert.match(renderApplianceReport(snapshot), /Notifier heartbeat: 30s old; tick ok; push ok; progress 2\/2/);
});

test("explicitly disabled optional selfcheck is disabled rather than broken", async () => {
  const snapshot = await applianceFixture({
    config: { selfcheck: { enabled: false, notifierWedgedMinutes: 5 } },
    missingLabel: "com.example.paperclip-selfcheck",
  });
  const selfcheck = snapshot.services.find((service) => service.key === "selfcheck");
  assert.equal(selfcheck.enabled, false);
  assert.equal(selfcheck.ok, true);
  assert.match(renderApplianceReport(snapshot), /Paperclip selfcheck: disabled \(config\); launchd not loaded/);
});

test("enabled missing service is broken", async () => {
  const snapshot = await applianceFixture({ missingLabel: "com.example.paperclip-notifier" });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.next, /Paperclip notifier: launchd service is missing or unloaded/);
});

test("stale notifier heartbeat is broken", async () => {
  const snapshot = await applianceFixture({ heartbeatAgeMs: 6 * 60_000 });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.next, /heartbeat is stale/);
});

test("configured Paperclip API down is broken", async () => {
  const snapshot = await applianceFixture({ apiOk: false });
  assert.equal(snapshot.ok, false);
  assert.match(snapshot.problems.at(-1), /Paperclip API: HTTP 503/);
});

test("recent per-service warning log is surfaced", async () => {
  const snapshot = await applianceFixture({ warningFile: "selfcheck.err.log" });
  const selfcheck = snapshot.services.find((service) => service.key === "selfcheck");
  assert.equal(selfcheck.logs.warningCount, 1);
  assert.match(snapshot.problems.join("\n"), /Paperclip selfcheck: 1 recent warning line/);
  assert.match(renderApplianceReport(snapshot), /Recent Paperclip selfcheck warning:.*failed to poll/);
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

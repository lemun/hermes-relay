import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT_TOKEN = "__HERMES_ROOT__";

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function validateLiveRoot(input, { allowWorktree = false } = {}) {
  if (!input || !path.isAbsolute(input)) throw new Error("--root must be an absolute path");
  const root = fs.realpathSync(input);
  for (const required of ["package.json", "launchd/run-node.sh", "mcp-config.template.json"]) {
    if (!fs.existsSync(path.join(root, required))) throw new Error(`not a Hermes checkout: missing ${required}`);
  }
  const gitEntry = path.join(root, ".git");
  if (!allowWorktree && fs.existsSync(gitEntry) && fs.lstatSync(gitEntry).isFile()) {
    throw new Error("refusing linked worktree root; use --allow-worktree to override explicitly");
  }
  return root;
}

export function renderInstallArtifacts({ templateRoot, liveRoot }) {
  const launchdDir = path.join(templateRoot, "launchd");
  const plists = fs.readdirSync(launchdDir)
    .filter((file) => file.endsWith(".plist"))
    .sort()
    .map((file) => ({
      name: file,
      content: fs.readFileSync(path.join(launchdDir, file), "utf8").replaceAll(ROOT_TOKEN, escapeXml(liveRoot)),
    }));
  const mcpTemplate = fs.readFileSync(path.join(templateRoot, "mcp-config.template.json"), "utf8");
  const mcp = mcpTemplate.replaceAll(ROOT_TOKEN, liveRoot);
  JSON.parse(mcp);
  return {
    plists,
    mcp,
  };
}

export function lintPlists(plists, { execFileSyncImpl = execFileSync, platform = process.platform } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-plist-lint-"));
  try {
    for (const plist of plists) {
      const file = path.join(dir, plist.name);
      fs.writeFileSync(file, plist.content);
      try {
        execFileSyncImpl("plutil", ["-lint", file], { stdio: "pipe" });
      } catch (err) {
        if (err?.code === "ENOENT" && platform !== "darwin") return false;
        throw err;
      }
    }
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function installPaths({ liveRoot, home = process.env.HOME || os.homedir() }) {
  return {
    launchAgents: path.join(home, "Library", "LaunchAgents"),
    mcp: path.join(liveRoot, "mcp-config.json"),
  };
}

function copyWithBackup(target, content, { now = new Date() } = {}) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let backup = "";
  if (fs.existsSync(target)) {
    backup = `${target}.bak-${now.toISOString().replaceAll(":", "-")}`;
    fs.copyFileSync(target, backup);
  }
  fs.writeFileSync(target, content);
  return backup;
}

export function applyInstall({ artifacts, paths, now = new Date() }) {
  const backups = [];
  for (const plist of artifacts.plists) {
    const backup = copyWithBackup(path.join(paths.launchAgents, plist.name), plist.content, { now });
    if (backup) backups.push(backup);
  }
  const mcpBackup = copyWithBackup(paths.mcp, artifacts.mcp, { now });
  if (mcpBackup) backups.push(mcpBackup);
  return backups;
}

export function planRetention({ root, retentionDays = 14, now = new Date() }) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("--retention-days must be a positive whole number");
  }
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const logsDir = path.join(root, "logs");
  const serviceLogs = fs.existsSync(logsDir) ? fs.readdirSync(logsDir)
    .map((name) => path.join(logsDir, name))
    .filter((file) => file.endsWith(".log") && fs.statSync(file).isFile() && fs.statSync(file).mtimeMs < cutoff) : [];

  const stateFile = path.join(root, "state", "hermes-sessions.json");
  let sessions;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!Array.isArray(data.sessions)) throw new Error("sessions is not an array");
    sessions = data.sessions;
  } catch {
    return { cutoff, serviceLogs, completedSessions: [], protectedSessions: [], skippedSessionPrune: true };
  }

  const sessionsDir = path.join(logsDir, "sessions");
  const completedSessions = [];
  const protectedSessions = [];
  for (const session of sessions) {
    if (!session.id || path.basename(session.id) !== session.id || session.id === "." || session.id === "..") continue;
    const sessionDir = path.join(sessionsDir, session.id);
    if (!fs.existsSync(sessionDir)) continue;
    if (session.status !== "done" && session.status !== "failed") {
      protectedSessions.push(session.id);
      continue;
    }
    const endedAt = Date.parse(session.endedAt || "");
    if (!Number.isNaN(endedAt) && endedAt < cutoff && fs.statSync(sessionDir).isDirectory()) {
      completedSessions.push({ id: session.id, path: sessionDir });
    }
  }
  return { cutoff, serviceLogs, completedSessions, protectedSessions, skippedSessionPrune: false };
}

export function applyRetention(plan) {
  for (const file of plan.serviceLogs) fs.rmSync(file, { force: true });
  for (const session of plan.completedSessions) fs.rmSync(session.path, { recursive: true, force: true });
}

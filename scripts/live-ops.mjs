#!/usr/bin/env node

// Local launchd wrapper for the live Hermes checkout.
//
// This is intentionally boring: one command checks the real live checkout, and
// one command restarts the launchd service then checks again.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLogWarnings, parseLaunchctlPrint } from "../lib/ops.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DIR = process.env.HERMES_LIVE_DIR || "/path/to/hermes-relay";
const LABEL = process.env.HERMES_LAUNCHD_LABEL || "com.example.hermes-bot";
const PLIST = path.join(process.env.HOME || "/path/to", "Library", "LaunchAgents", `${LABEL}.plist`);

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || "", stderr: stderr || "", err });
    });
  });
}

async function gitSha(dir) {
  const res = await run("git", ["-C", dir, "rev-parse", "--short", "HEAD"]);
  return res.code === 0 ? res.stdout.trim() : "";
}

function tailWarnings(file) {
  try {
    const text = fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-80).join("\n");
    return classifyLogWarnings(text);
  } catch {
    return { checkedLines: 0, warningCount: 0, lastWarning: "" };
  }
}

async function checkLive() {
  const cwdSha = await gitSha(ROOT);
  const liveSha = await gitSha(LIVE_DIR);
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  const launch = await run("launchctl", ["print", `gui/${uid}/${LABEL}`]);
  const launchd = parseLaunchctlPrint(launch.stdout);
  const configPath = path.join(LIVE_DIR, "config.json");
  const logPath = path.join(LIVE_DIR, "logs", "hermes.err.log");
  const logs = tailWarnings(logPath);
  const check = await run("npm", ["run", "check", "--silent"], { cwd: LIVE_DIR, timeout: 120000 });

  const problems = [];
  if (!fs.existsSync(LIVE_DIR)) problems.push(`live checkout missing: ${LIVE_DIR}`);
  if (!fs.existsSync(configPath)) problems.push(`config missing: ${configPath}`);
  if (!launchd.running) problems.push(`${LABEL} is not running under launchd`);
  if (check.code !== 0) problems.push(`npm run check failed: ${(check.stderr || check.stdout).trim().split("\n").at(-1) || check.code}`);

  console.log("Hermes live check");
  console.log(`Current checkout: ${ROOT}${cwdSha ? ` @ ${cwdSha}` : ""}`);
  console.log(`Live checkout:    ${LIVE_DIR}${liveSha ? ` @ ${liveSha}` : ""}`);
  console.log(`Config:           ${fs.existsSync(configPath) ? "present" : "missing"}`);
  console.log(`launchd:          ${launchd.running ? `running${launchd.pid ? ` pid ${launchd.pid}` : ""}` : "not running"}`);
  console.log(`npm run check:    ${check.code === 0 ? "OK" : "FAILED"}`);
  console.log(`Logs:             ${logs.warningCount ? `${logs.warningCount} warning line(s)` : "no recent warnings"}`);
  if (logs.warningCount) console.log(`Last log warning: ${logs.lastWarning.slice(0, 160)}`);
  if (problems.length) {
    console.log("");
    console.log("Next:");
    for (const p of problems) console.log(`- ${p}`);
    return false;
  }
  console.log("");
  console.log("Next: no live ops action needed.");
  return true;
}

async function restartLive() {
  console.log(`Restarting ${LABEL} from ${LIVE_DIR}`);
  if (!fs.existsSync(PLIST)) {
    console.log(`LaunchAgent plist not installed: ${PLIST}`);
    process.exitCode = 1;
    return;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  const kick = await run("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]);
  if (kick.code !== 0) {
    console.log(`launchctl kickstart failed: ${(kick.stderr || kick.stdout).trim() || kick.code}`);
    process.exitCode = 1;
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const ok = await checkLive();
  if (!ok) process.exitCode = 1;
}

const action = process.argv[2] || "check";
if (action === "check") {
  const ok = await checkLive();
  if (!ok) process.exitCode = 1;
} else if (action === "restart") {
  await restartLive();
} else {
  console.log("Usage: node scripts/live-ops.mjs check|restart");
  process.exitCode = 2;
}

#!/usr/bin/env node

// Local launchd wrapper for the live Hermes checkout.
//
// This is intentionally boring: one command checks the real live checkout, and
// one command restarts the launchd service then checks again.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gatherApplianceSnapshot, renderApplianceReport } from "../lib/ops.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DIR = process.env.HERMES_LIVE_DIR || ROOT;
const LABEL = process.env.HERMES_LAUNCHD_LABEL || "com.example.hermes-bot";
const PLIST = path.join(process.env.HOME || os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

function run(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || "", stderr: stderr || "", err });
    });
  });
}

async function checkLive() {
  const current = await run("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
  const snapshot = await gatherApplianceSnapshot({ root: LIVE_DIR, exec: run });
  console.log("Hermes live check (read-only)");
  console.log(`Current checkout: ${ROOT}${current.code === 0 ? ` @ ${current.stdout.trim()}` : ""}`);
  console.log(`Live checkout:    ${LIVE_DIR}${snapshot.sha ? ` @ ${snapshot.sha}` : ""}`);
  console.log(renderApplianceReport(snapshot));
  return snapshot.ok;
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

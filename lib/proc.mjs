// One child-process helper shared by the concierge (voice transcode) and the coder (git/shell),
// replacing the two near-identical wrappers that used to live in each module.

import { execFile } from "node:child_process";
import path from "node:path";

// Resolve-don't-throw: always resolves to { code, stdout, stderr, err }. Defaults suit git/shell
// calls (60s, 16MB). The coder uses this so a non-zero git exit is data, not an exception.
export function exec(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || "", stderr: stderr || "", err });
    });
  });
}

// Reject-on-error, resolves to stdout. Defaults suit media tools (120s, 32MB) whose output is
// larger. The concierge uses this for ffmpeg/whisper, where a failure should propagate.
export function execText(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} failed: ${err.message} ${(stderr || "").slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

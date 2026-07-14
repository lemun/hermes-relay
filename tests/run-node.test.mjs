import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("launch wrapper creates owner-only files under a permissive parent umask", {
  skip: process.platform === "win32",
}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-run-node-"));
  try {
    const script = path.join(dir, "write-state.mjs");
    const output = path.join(dir, "state.json");
    fs.writeFileSync(script, [
      'import fs from "node:fs";',
      'fs.writeFileSync(process.argv[2], "private state\\n", { mode: 0o666 });',
      "",
    ].join("\n"));

    const result = spawnSync("/bin/sh", [
      "-c",
      'umask 000; exec /bin/sh "$1" "$2" "$3"',
      "run-node-test",
      path.join(ROOT, "launchd", "run-node.sh"),
      script,
      output,
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NVM_DIR: path.join(dir, "missing-nvm") },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

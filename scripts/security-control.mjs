#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createActionAuthorization } from "../lib/action-authorization.mjs";
import { enforcePrivateUmask } from "../lib/runtime-security.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  enforcePrivateUmask();
  const operation = argv.length === 1 ? argv[0] : null;
  if (!["status", "lock", "unlock"].includes(operation)) {
    stderr.write("Usage: npm run security:control -- status|lock|unlock\n");
    return 2;
  }
  try {
    const authorization = createActionAuthorization({
      configuredChatId: "1",
      configuredUserId: "1",
      stateFile: path.join(ROOT, "state", "hermes-security.json"),
    });
    if (operation === "status") {
      stdout.write(`${authorization.isLocked() ? "locked" : "normal"}\n`);
      return 0;
    }
    const result = operation === "lock" ? authorization.lockRemote() : authorization.unlockLocal();
    stdout.write(`${result.mode}\n`);
    return result.ok ? 0 : 1;
  } catch {
    stderr.write("Security state operation failed.\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}

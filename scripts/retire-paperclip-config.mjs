#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPrivateFile, writePrivateFileAtomic, writePrivateJsonAtomic } from "../lib/private-storage.mjs";
import { stripRetiredConfig, stripRetiredDotenv } from "../lib/retire-paperclip.mjs";

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function retirePaperclipConfig({ root = SCRIPT_ROOT, fsImpl = fs } = {}) {
  const envFile = path.join(root, ".env");
  const configFile = path.join(root, "config.json");
  const envResult = stripRetiredDotenv(readPrivateFile(envFile, { fsImpl }));
  const rawConfig = readPrivateFile(configFile, { fsImpl });
  let parsed;
  try { parsed = JSON.parse(rawConfig); }
  catch { throw new Error("config.json contains malformed JSON"); }
  const configResult = stripRetiredConfig(parsed);

  if (envResult.removed.length) writePrivateFileAtomic(envFile, envResult.content, { fsImpl });
  if (configResult.removed.length) writePrivateJsonAtomic(configFile, configResult.config, { fsImpl });
  return { envKeys: envResult.removed, configKeys: configResult.removed };
}

function parseArgs(argv) {
  if (!argv.length) return { root: SCRIPT_ROOT };
  if (argv.length === 2 && argv[0] === "--root" && path.isAbsolute(argv[1])) return { root: argv[1] };
  throw new Error("invalid arguments");
}

export function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const result = retirePaperclipConfig(parseArgs(argv));
    stdout.write(`Removed retired .env keys: ${result.envKeys.join(", ") || "none"}\n`);
    stdout.write(`Removed retired config keys: ${result.configKeys.join(", ") || "none"}\n`);
    return 0;
  } catch {
    stderr.write("Usage: npm run security:retire-paperclip -- [--root /absolute/path]\nMigration refused; verify private regular .env/config.json files and valid JSON.\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();

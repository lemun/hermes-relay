// Shared Hermes runtime configuration and private preference storage.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isModelAlias } from "./models.mjs";
import { isSupportedEngine } from "./engines.mjs";
import { ensurePrivateDirectory, writePrivateJsonAtomic } from "./private-storage.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
const PREFS = path.join(ROOT, "state", "hermes-prefs.json");

export function loadPrefs({ file = PREFS } = {}) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return {}; }
}

export function writeJsonAtomic(file, value, options) {
  ensurePrivateDirectory(path.dirname(file), options);
  writePrivateJsonAtomic(file, value, options);
}

export function savePrefs(value, { file = PREFS, fsImpl } = {}) {
  const options = fsImpl ? { fsImpl } : undefined;
  writeJsonAtomic(file, value, options);
}

function loadDotenv(file = path.join(ROOT, ".env")) {
  if (!file || !existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/^\s*export\s+/, "");
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !line.trim().startsWith("#") && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

export class ConfigError extends Error {
  constructor(kind, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ConfigError";
    this.kind = kind;
  }
}

export function isConfigError(error) {
  return error instanceof ConfigError;
}

export function formatConfigError(error) {
  const detail = error.kind === "missing"
    ? "config.json is missing."
    : error.kind === "malformed"
      ? `config.json contains malformed JSON: ${error.message}`
      : `config.json is invalid: ${error.message}`;
  return [
    `[config] ${detail}`,
    "Create the non-secret config: cp config.example.json config.json",
    "Create the secrets file: cp .env.example .env",
    "Then fill in .env before starting a service.",
  ].join("\n");
}

export function loadConfig({
  configPath = path.join(ROOT, "config.json"),
  dotenvPath = path.join(ROOT, ".env"),
} = {}) {
  loadDotenv(dotenvPath);
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new ConfigError("missing", "config.json was not found", { cause: error });
    throw error;
  }

  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (error) { throw new ConfigError("malformed", error.message, { cause: error }); }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new ConfigError("invalid", "the top level must be a JSON object");
  }

  cfg.telegram = cfg.telegram || {};
  cfg.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || cfg.telegram.botToken || "";
  cfg.telegram.allowedChatId = process.env.TELEGRAM_CHAT_ID || cfg.telegram.allowedChatId || 0;
  cfg.telegram.allowedUserId = process.env.TELEGRAM_USER_ID || cfg.telegram.allowedUserId || 0;
  cfg.telegram.totpSecret = process.env.HERMES_TOTP_SECRET || cfg.telegram.totpSecret || "";

  cfg.coding = cfg.coding || {};
  cfg.coding.enabled = cfg.coding.enabled === true;
  cfg.coding.repos = cfg.coding.repos || {};
  cfg.coding.worktreeBase = cfg.coding.worktreeBase || ROOT;
  cfg.coding.defaultModel = cfg.coding.defaultModel || "sonnet";
  cfg.coding.defaultEffort = cfg.coding.defaultEffort || "high";
  cfg.coding.jobTimeoutMs = cfg.coding.jobTimeoutMs || 30 * 60 * 1000;
  cfg.coding.worktreeRetentionDays = cfg.coding.worktreeRetentionDays || 7;

  cfg.hermes = cfg.hermes || {};
  cfg.hermes.enabled = cfg.hermes.enabled === true;
  cfg.hermes.repos = cfg.hermes.repos || {};
  cfg.hermes.defaultEngine = isSupportedEngine(cfg.hermes.defaultEngine) ? cfg.hermes.defaultEngine : "codex";
  cfg.hermes.allowClaudeWriteSessions = cfg.hermes.allowClaudeWriteSessions === true;
  cfg.hermes.codexBin = cfg.hermes.codexBin ?? "/Applications/Codex.app/Contents/Resources/codex";
  cfg.hermes.pollActiveSeconds = cfg.hermes.pollActiveSeconds ?? 30;
  cfg.hermes.pollIdleSeconds = cfg.hermes.pollIdleSeconds ?? 180;
  cfg.hermes.askTimeoutHours = cfg.hermes.askTimeoutHours ?? 8;
  cfg.hermes.sessionCap = cfg.hermes.sessionCap ?? 6;
  cfg.hermes.grillerCap = cfg.hermes.grillerCap ?? 2;
  cfg.hermes.autopilot = cfg.hermes.autopilot || {};
  cfg.hermes.autopilot.dailyBudget = cfg.hermes.autopilot.dailyBudget ?? 10;
  cfg.hermes.autopilot.maxLoadPerCore = cfg.hermes.autopilot.maxLoadPerCore ?? 0.8;
  cfg.hermes.autopilot.minFreeMemMB = cfg.hermes.autopilot.minFreeMemMB ?? 1024;
  cfg.hermes.autopilot.hidIdleMinutes = cfg.hermes.autopilot.hidIdleMinutes ?? 10;
  const defaultTiers = { digest: "haiku", prose: "sonnet", grilling: "opus", audit: "opus" };
  cfg.hermes.tiers = Object.fromEntries(Object.entries(defaultTiers).map(([job, fallback]) => {
    const model = cfg.hermes.tiers?.[job];
    return [job, isModelAlias(model) ? model : fallback];
  }));
  cfg.hermes.morningDigestHour = cfg.hermes.morningDigestHour ?? 8;
  return cfg;
}

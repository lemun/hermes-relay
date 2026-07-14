export const RETIRED_ENV_KEYS = Object.freeze([
  "PAPERCLIP_BOARD_API_KEY",
  "NTFY_TOPIC",
  "NTFY_SERVER",
  "NTFY_ROTATION_CONFIRMED",
  "NTFY_TOPIC_ROTATED_AT",
]);

export const RETIRED_CONFIG_KEYS = Object.freeze([
  "paperclipBase",
  "companyId",
  "issuePrefix",
  "uiBaseUrl",
  "ntfy",
  "pollSeconds",
  "health",
  "selfcheck",
  "push",
  "boardApiKey",
  "claudeModel",
]);

export function stripRetiredDotenv(text) {
  const retired = new Set(RETIRED_ENV_KEYS);
  const removed = [];
  const lines = String(text).split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=/);
    if (!match || !retired.has(match[1])) return true;
    removed.push(match[1]);
    return false;
  });
  return { content: lines.join("\n"), removed: [...new Set(removed)] };
}

export function stripRetiredConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("config.json must contain a top-level object");
  }
  const config = { ...value };
  const removed = [];
  for (const key of RETIRED_CONFIG_KEYS) {
    if (!Object.hasOwn(config, key)) continue;
    delete config[key];
    removed.push(key);
  }
  return { config, removed };
}

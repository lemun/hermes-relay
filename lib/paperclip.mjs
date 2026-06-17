// Shared read-only client for the Paperclip loopback API.
// All calls are GET against http://127.0.0.1:3100 — no auth needed in local_trusted
// loopback mode. NOTHING here mutates the live board.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

// Minimal .env loader (no dependency). Lines like KEY=value; quotes stripped.
// Existing process.env wins, so real env vars / launchd overrides take precedence.
function loadDotenv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

export function loadConfig() {
  loadDotenv();
  const cfg = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
  cfg.paperclipBase = (cfg.paperclipBase || "http://127.0.0.1:3100").replace(/\/$/, "");
  cfg.issuePrefix = cfg.issuePrefix || "HOM";

  // Secrets / overrides come from env (.env or real env vars), falling back to config.json.
  cfg.ntfy = cfg.ntfy || {};
  cfg.ntfy.server = process.env.NTFY_SERVER || cfg.ntfy.server || "https://ntfy.example.com";
  cfg.ntfy.topic = process.env.NTFY_TOPIC || cfg.ntfy.topic;
  cfg.telegram = cfg.telegram || {};
  cfg.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || cfg.telegram.botToken || "";
  cfg.telegram.allowedChatId = process.env.TELEGRAM_CHAT_ID || cfg.telegram.allowedChatId || 0;
  return cfg;
}

async function pcGet(cfg, p) {
  const r = await fetch(`${cfg.paperclipBase}${p}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
}

export const getAgents = (cfg) => pcGet(cfg, `/api/companies/${cfg.companyId}/agents`);
export const getIssues = (cfg) => pcGet(cfg, `/api/companies/${cfg.companyId}/issues`);
export const getIssue = (cfg, id) => pcGet(cfg, `/api/issues/${id}`);
export const getComments = (cfg, id) => pcGet(cfg, `/api/issues/${id}/comments`);
export const getInteractions = (cfg, id) => pcGet(cfg, `/api/issues/${id}/interactions`);
export const getActivity = (cfg) => pcGet(cfg, `/api/companies/${cfg.companyId}/activity`);

export function issueUrl(cfg, identifier) {
  if (!cfg.uiBaseUrl || !identifier) return undefined;
  return `${cfg.uiBaseUrl.replace(/\/$/, "")}/${cfg.issuePrefix}/issues/${identifier}`;
}

// Resolve a UUID or a human identifier like "HOM-27" to a full issue object.
export async function resolveIssue(cfg, idOrIdentifier) {
  const q = String(idOrIdentifier).trim();
  if (/^[0-9a-f-]{36}$/i.test(q)) return getIssue(cfg, q);
  const issues = await getIssues(cfg);
  const num = q.replace(/^.*-/, "");
  return issues.find(
    (i) => i.identifier === q || String(i.issueNumber) === num,
  );
}

// The core "does the board need me?" scan: pending interaction cards + agents in error.
export async function gatherBoardSignals(cfg) {
  const issues = await getIssues(cfg);
  const open = issues.filter((i) => i.status === "in_review");
  const pending = [];
  for (const i of open) {
    let ints = [];
    try { ints = await getInteractions(cfg, i.id); } catch { /* tolerate per-issue hiccup */ }
    for (const x of ints) {
      if (x.status !== "pending") continue;
      pending.push({
        interactionId: x.id,
        kind: x.kind,
        title: x.title || x.summary || x.kind,
        issueIdentifier: i.identifier || `#${i.issueNumber}`,
        issueTitle: i.title,
        createdAt: x.createdAt,
      });
    }
  }
  const agents = await getAgents(cfg);
  const errors = agents
    .filter((a) => a.status === "error")
    .map((a) => ({ agentId: a.id, name: a.name, at: a.lastHeartbeatAt }));
  return { pending, errors, issues, agents };
}

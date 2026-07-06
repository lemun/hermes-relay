// Shared read-only client for the Paperclip loopback API.
// All calls are GET against http://127.0.0.1:3100 — no auth needed in local_trusted
// loopback mode. NOTHING here mutates the live board.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { API_TIMEOUT_MS } from "./const.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

// Shared bot preferences (model, voice lang, last prompt, session ids, coding state).
// One JSON blob; tolerant of corruption (returns {}). Written atomically.
const PREFS = path.join(ROOT, "state", "hermes-prefs.json");
export function loadPrefs() { try { return JSON.parse(readFileSync(PREFS, "utf8")); } catch { return {}; } }
export function savePrefs(p) {
  try { mkdirSync(path.dirname(PREFS), { recursive: true }); writeJsonAtomic(PREFS, p); }
  catch { /* ignore — prefs are best-effort */ }
}

// Minimal .env loader (no dependency). Lines like KEY=value (or `export KEY=value`);
// quotes stripped. Existing process.env wins, so real env vars / launchd overrides
// take precedence.
function loadDotenv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split("\n")) {
    const line = raw.replace(/^\s*export\s+/, ""); // tolerate `export KEY=value`
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// Atomic JSON write: write a sibling temp file then rename (atomic on POSIX), so a
// crash mid-write can never leave a truncated/corrupt state file. Caller ensures the
// directory exists.
export function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file);
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

  // Board API key for confirm-gated writes (accept/reject). Secret → .env only. Empty by
  // default, which keeps lib/paperclip-write.mjs fail-closed (it refuses to write without it).
  cfg.boardApiKey = process.env.PAPERCLIP_BOARD_API_KEY || cfg.boardApiKey || "";

  // Opt-in "coding mode": run a real write-enabled Claude Code session in an allowlisted
  // repo. Defaults keep it OFF and harmless. Repo paths are validated at startup (git) by
  // assertCodingConfig in lib/coder.mjs — kept out of here so loadConfig stays sync/pure.
  cfg.coding = cfg.coding || {};
  cfg.coding.enabled = !!cfg.coding.enabled;
  cfg.coding.repos = cfg.coding.repos || {};
  cfg.coding.worktreeBase = cfg.coding.worktreeBase || ROOT;
  cfg.coding.defaultModel = cfg.coding.defaultModel || "sonnet";
  cfg.coding.defaultEffort = cfg.coding.defaultEffort || "high";
  cfg.coding.jobTimeoutMs = cfg.coding.jobTimeoutMs || 30 * 60 * 1000;
  cfg.coding.worktreeRetentionDays = cfg.coding.worktreeRetentionDays || 7; // sweep phone/* worktrees older than this

  // Health watchdog (notifier): deterministic agent/run liveness detection + escalation.
  // enabled defaults ON; thresholds bias toward UNDER-alerting (the safer failure mode,
  // given org-wide heartbeats are disabled and idle agents are legitimately days-stale).
  cfg.health = cfg.health || {};
  cfg.health.enabled = cfg.health.enabled !== false;
  cfg.health.stuckRunningMinutes = cfg.health.stuckRunningMinutes || 25;
  cfg.health.errorEscalateFirstHours = cfg.health.errorEscalateFirstHours || 1;
  cfg.health.errorEscalateThenHours = cfg.health.errorEscalateThenHours || 24;

  // Interactive pending-card push (hermes-bot, lib/push.mjs): Hermes proactively texts the
  // authorized chat with [Approve]/[Reject]/[Tell me more] buttons when a NEW pending card
  // appears. enabled defaults ON; it's read-side (the buttons route into the existing confirm+
  // TOCTOU+fail-closed write gate). Runs in-process alongside (not instead of) the ntfy notifier.
  cfg.push = cfg.push || {};
  cfg.push.enabled = cfg.push.enabled !== false;
  cfg.push.pollSeconds = cfg.push.pollSeconds || 60;

  // Self-health probe (selfcheck.mjs): an INDEPENDENT launchd one-shot that watches the
  // watcher — pages directly via ntfy if the Paperclip API is down or the notifier's
  // heartbeat has gone stale (= notifier dead/wedged). wedged threshold is deliberately
  // generous: a slow Paperclip can push a single notifier tick well past pollSeconds
  // (gatherBoardSignals does sequential per-issue getInteractions at 8s each), so this must
  // sit far above worst-case tick time to avoid self-paging on transient slowness.
  cfg.selfcheck = cfg.selfcheck || {};
  cfg.selfcheck.enabled = cfg.selfcheck.enabled !== false;
  cfg.selfcheck.notifierWedgedMinutes = cfg.selfcheck.notifierWedgedMinutes || 5;
  cfg.selfcheck.healthPath = cfg.selfcheck.healthPath || "/api/health";

  // Hermes v2 — ratification relay + GitHub-issue pipeline (docs/architecture.md).
  // OPT-IN: enabled defaults false, and every knob has a conservative default so a
  // half-filled config block can't produce a hyperactive autopilot.
  cfg.hermes = cfg.hermes || {};
  cfg.hermes.enabled = !!cfg.hermes.enabled;
  cfg.hermes.repos = cfg.hermes.repos || {};
  cfg.hermes.defaultEngine = cfg.hermes.defaultEngine || "codex";
  cfg.hermes.codexBin = cfg.hermes.codexBin || "/Applications/Codex.app/Contents/Resources/codex";
  cfg.hermes.pollActiveSeconds = cfg.hermes.pollActiveSeconds || 30;
  cfg.hermes.pollIdleSeconds = cfg.hermes.pollIdleSeconds || 180;
  cfg.hermes.askTimeoutHours = cfg.hermes.askTimeoutHours || 8;
  cfg.hermes.sessionCap = cfg.hermes.sessionCap || 6;
  cfg.hermes.autopilot = cfg.hermes.autopilot || {};
  cfg.hermes.autopilot.dailyBudget = cfg.hermes.autopilot.dailyBudget || 10;
  cfg.hermes.autopilot.maxLoadPerCore = cfg.hermes.autopilot.maxLoadPerCore || 0.8;
  cfg.hermes.autopilot.minFreeMemMB = cfg.hermes.autopilot.minFreeMemMB || 1024;
  cfg.hermes.autopilot.hidIdleMinutes = cfg.hermes.autopilot.hidIdleMinutes || 10;
  cfg.hermes.tiers = {
    digest: "haiku", prose: "sonnet", grilling: "opus", audit: "opus",
    implementation: "codex", ...(cfg.hermes.tiers || {}),
  };
  cfg.hermes.morningDigestHour = cfg.hermes.morningDigestHour ?? 8;
  return cfg;
}

// Push a phone alert via ntfy's JSON format (POST to server root) so emoji/Hebrew in the
// title+message stay UTF-8 clean — HTTP headers can't carry non-ASCII. Shared by the
// notifier (board alerts) and the coder (job-done alerts).
export async function ntfy(cfg, title, message, { priority = 4, tags = ["bell"], click } = {}) {
  if (!cfg.ntfy?.topic) throw new Error("ntfy topic not configured");
  const payload = { topic: cfg.ntfy.topic, title, message, priority, tags };
  if (click) payload.click = click;
  const r = await fetch((cfg.ntfy.server || "https://ntfy.example.com").replace(/\/$/, ""), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`ntfy POST -> ${r.status} ${await r.text().catch(() => "")}`);
}

async function pcGet(cfg, p) {
  const r = await fetch(`${cfg.paperclipBase}${p}`, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`GET ${p} -> ${r.status}`);
  return r.json();
}

export const getAgents = (cfg) => pcGet(cfg, `/api/companies/${cfg.companyId}/agents`);
export const getIssues = (cfg) => pcGet(cfg, `/api/companies/${cfg.companyId}/issues`);
export const getIssue = (cfg, id) => pcGet(cfg, `/api/issues/${id}`);
export const getComments = (cfg, id) => pcGet(cfg, `/api/issues/${id}/comments`);
export const getInteractions = (cfg, id) => pcGet(cfg, `/api/issues/${id}/interactions`);
export const getActivity = (cfg) => pcGet(cfg, `/api/companies/${cfg.companyId}/activity`);

// Fail-closed authorization: with no configured chat id (unset → "0"), authorize NOBODY.
export function isAuthorized(allowedChatId, id) {
  const allowed = String(allowedChatId ?? "");
  if (!allowed || allowed === "0") return false;
  return String(id) === allowed;
}

// Tap-through url to an issue in the Paperclip web UI. Uses the app's CANONICAL company-
// prefixed route (`/<prefix>/issues/<identifier>`) — verified by headless-rendering the live
// SPA: `/` redirects to `/<prefix>/dashboard`, and this path paints the issue. (A bare
// `/issues/<id>` also works but only via a client-side redirect to this form, so we emit the
// resolved URL directly.) NOTE: the page only renders in a browser that's logged into
// Paperclip — Telegram's in-app browser has no session, which white-screens; open in the
// system browser (or sign in once inside the in-app browser).
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

// Deterministic health findings for the watchdog. PURE (no I/O) so it's unit-tested on the
// fetch-mock harness. Two signals only — both schema-grounded against the live org:
//
//   A "error":  any agent whose status === "error". Keyed by agent id (NOT heartbeat ts), so
//               a wedged agent re-pages on an escalation curve instead of going silent once
//               the original heartbeat timestamp stops changing (the 24h-silent-agent bug).
//   B "stuck":  any issue carrying a live run (activeRun.status === "running") whose
//               startedAt is older than stuckRunningMinutes. Keyed off the RUN, never the
//               agent heartbeat — heartbeats are disabled org-wide and idle agents are
//               legitimately days-stale, so a heartbeat-based rule is a false-positive machine.
//
// `now` is injectable for tests. Returns [] when health.enabled is false.
export function deriveHealth(agents, issues, now = Date.now(), health = {}) {
  if (health.enabled === false) return [];
  const stuckMs = (health.stuckRunningMinutes || 25) * 60 * 1000;
  const nameById = Object.fromEntries((agents || []).map((a) => [a.id, a.name]));
  const findings = [];

  for (const a of agents || []) {
    if (a.status !== "error") continue;
    findings.push({
      kind: "error",
      conditionKey: `error:${a.id}`,
      agentId: a.id,
      name: a.name,
      since: a.lastHeartbeatAt,
      title: `${a.name} is in error`,
      body: `Last heartbeat ${a.lastHeartbeatAt || "—"}.\nStill in error — re-pinging until it clears.`,
    });
  }

  for (const i of issues || []) {
    const run = i.activeRun;
    if (!run || run.status !== "running" || !run.startedAt) continue;
    const startedMs = Date.parse(run.startedAt);
    const unparseable = Number.isNaN(startedMs); // a malformed ts must NOT silently suppress the alert
    const ageMs = now - startedMs;
    if (!unparseable && !(ageMs > stuckMs)) continue;
    const who = nameById[i.assigneeAgentId] || nameById[run.agentId] || run.agentId || "an agent";
    const ident = i.identifier || `#${i.issueNumber}`;
    findings.push({
      kind: "stuck",
      conditionKey: `stuck:${i.id}:${run.id}`,
      agentId: i.assigneeAgentId || run.agentId,
      name: who,
      issueIdentifier: ident,
      since: run.startedAt,
      title: `${who} may be stuck on ${ident}`,
      body: unparseable
        ? `Run on ${ident}${i.title ? ` (${i.title})` : ""} is "running" but its start time ("${run.startedAt}") is unparseable — can't age it, flagging to be safe.`
        : `Run has been "running" ${Math.round(ageMs / 60000)}m on ${ident}${i.title ? ` (${i.title})` : ""} with no error and no finish — possibly wedged.`,
    });
  }

  return findings;
}

// Pure evaluator for the bridge's OWN health (selfcheck.mjs). No I/O — the runner does the
// fetch + heartbeat-file read and passes the results in, so the decision logic is unit-tested.
// Returns findings with stable conditionKeys ("api" / "notifier") for the escalation ledger.
export function evaluateBridgeHealth(now, { apiOk, apiDetail, heartbeat, wedgedMs } = {}) {
  const findings = [];
  if (!apiOk) {
    findings.push({
      conditionKey: "api",
      title: "Paperclip API is unreachable",
      body: `The loopback API isn't responding${apiDetail ? ` (${apiDetail})` : ""}. The whole bridge is blind until it's back.`,
    });
  }
  if (!heartbeat || typeof heartbeat.at !== "number") {
    findings.push({
      conditionKey: "notifier",
      title: "Notifier heartbeat is missing",
      body: "No notifier heartbeat file. The notifier may never have started, or its state dir is gone — proactive alerts are off.",
    });
  } else if (now - heartbeat.at > wedgedMs) {
    const ageMin = Math.round((now - heartbeat.at) / 60000);
    findings.push({
      conditionKey: "notifier",
      title: "Notifier is wedged or down",
      body: `Last notifier heartbeat ${ageMin}m ago (threshold ${Math.round(wedgedMs / 60000)}m). Proactive alerts have stopped — restart com.example.paperclip-notifier.`,
    });
  }
  return findings;
}

// When is a still-active condition due to re-page? notifyCount 1 → first re-ping after
// errorEscalateFirstHours; thereafter every errorEscalateThenHours (a slow "still broken"
// drumbeat). Pure so the escalation curve is unit-tested without real time or pushes.
export function nextHealthDueMs(rec, health = {}) {
  const firstMs = (health.errorEscalateFirstHours || 1) * 3600 * 1000;
  const thenMs = (health.errorEscalateThenHours || 24) * 3600 * 1000;
  if (!rec || !rec.notifyCount) return 0;
  if (rec.notifyCount <= 1) return rec.firstSeenAt + firstMs;
  return rec.lastNotifiedAt + thenMs;
}

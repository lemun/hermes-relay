// ntfy push notifier — polls the Paperclip loopback API and pushes a phone alert
// when the BOARD (you) is needed: a new pending request_confirmation card, or an
// agent entering an `error` state. Outbound-only (works over cellular, no inbound
// port, no Tailscale required). Read-only: never mutates the board.
//
//   node notifier.mjs             # long-running loop (launchd uses this)
//   node notifier.mjs --once      # single tick then exit (for testing/cron)
//   node notifier.mjs --once --dry-run   # read live + print what it WOULD push; no push, no state write

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  ROOT, gatherBoardSignals, deriveHealth, nextHealthDueMs,
  issueUrl, ntfy, writeJsonAtomic, buildNotifierHeartbeat,
} from "./lib/paperclip.mjs";
import { loadConfigForCli } from "./lib/config-cli.mjs";

const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry-run"); // read + report only; never pushes, never writes state
const cfg = loadConfigForCli({ diagnostic: DRY });
const STATE_DIR = path.join(ROOT, "state");
const STATE = path.join(STATE_DIR, "notifier-seen.json");
const HEARTBEAT = path.join(STATE_DIR, "notifier-heartbeat.json"); // liveness proof for selfcheck.mjs
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

function readHeartbeat() { try { return JSON.parse(readFileSync(HEARTBEAT, "utf8")); } catch { return null; } }

// Refresh the heartbeat at tick start, after every sequential interaction scan, and at tick
// completion. Selfcheck therefore distinguishes a moving slow scan from a stopped notifier.
function beat(previous, status) {
  const heartbeat = buildNotifierHeartbeat(previous, status);
  if (DRY) return heartbeat;
  try { writeJsonAtomic(HEARTBEAT, heartbeat); }
  catch { /* best-effort: a heartbeat write failure must never crash the loop */ }
  return heartbeat;
}

// seen.health maps a stable conditionKey (error:<agentId> / stuck:<issueId>:<runId>) to
// { firstSeenAt, lastNotifiedAt, notifyCount } — the escalation ledger. Tolerant of the
// pre-health state shape (old `errors` array is simply dropped).
function loadSeen() {
  let s;
  try { s = JSON.parse(readFileSync(STATE, "utf8")); }
  catch { s = {}; }
  s.firstRunDone = !!s.firstRunDone;
  s.interactions = Array.isArray(s.interactions) ? s.interactions : [];
  s.health = (s.health && typeof s.health === "object") ? s.health : {};
  return s;
}
function saveSeen(s) {
  if (DRY) return; // dry-run mutates nothing
  s.interactions = s.interactions.slice(-300);
  writeJsonAtomic(STATE, s); // temp + rename: a crash mid-write can't corrupt the state file
}

// Single push path so --dry-run can intercept every alert (and a dead-simple test seam).
async function push(title, message, opts, status) {
  if (DRY) { console.log(`[notifier:dry] PUSH «${title}» ${String(message).replace(/\n/g, " · ")}`); return; }
  try {
    await ntfy(cfg, title, message, opts);
    status.lastPushStatus = "ok";
    status.lastErrorSummary = null;
    status.pushAttempted = true;
  } catch (err) {
    status.lastPushStatus = "error";
    status.lastErrorSummary = String(err.message || err).replace(/\s+/g, " ").slice(0, 240);
    status.pushAttempted = true;
    throw err;
  }
}

// ntfy() is shared with the coder (lib/paperclip.mjs); call it with cfg as the first arg.

async function tick(status, onProgress) {
  const seen = loadSeen();
  const seenI = new Set(seen.interactions);
  let changed = false;
  const now = Date.now();

  const { pending, issues, agents } = await gatherBoardSignals(cfg, { onProgress });
  const findings = deriveHealth(agents, issues, now, cfg.health);

  // First run: send ONE digest instead of a burst of individual pings, then seed.
  if (!seen.firstRunDone) {
    const lines = [
      ...pending.map((p) => `• ${p.issueIdentifier}: ${p.title}`),
      ...findings.map((f) => `⚠ ${f.title}`),
    ];
    const body = lines.length
      ? `${lines.length} item(s) need attention:\n${lines.join("\n")}`
      : "Nothing needs you right now. You'll get a ping when something does.";
    await push("Paperclip notifier is live", body, { priority: 3, tags: ["satellite"] }, status);
    pending.forEach((p) => seen.interactions.push(p.interactionId));
    findings.forEach((f) => { seen.health[f.conditionKey] = { firstSeenAt: now, lastNotifiedAt: now, notifyCount: 1 }; });
    seen.firstRunDone = true;
    saveSeen(seen);
    console.log(`[notifier] first run: seeded ${pending.length} pending + ${findings.length} health, sent digest.`);
    return;
  }

  // Pending board cards — one ping each, deduped forever (a human card resolves once).
  for (const p of pending) {
    if (seenI.has(p.interactionId)) continue;
    await push(`Needs you · ${p.issueIdentifier}`, `${p.title}\n${p.issueTitle}`, {
      priority: 4, tags: ["bell"], click: issueUrl(cfg, p.issueIdentifier),
    }, status);
    seen.interactions.push(p.interactionId); seenI.add(p.interactionId); changed = true;
    console.log(`[notifier] pushed pending card ${p.issueIdentifier} (${p.interactionId})`);
  }

  // Health findings — escalation ledger: new condition pings now; a STILL-active condition
  // re-pings on a 1h→daily curve (this is the fix for the silent-agent bug, where the old
  // heartbeat-keyed dedup pinged once then went quiet forever). A condition that clears
  // (agent left error / run finished) is dropped, with one optional "recovered" note.
  const active = new Set();
  for (const f of findings) {
    active.add(f.conditionKey);
    const rec = seen.health[f.conditionKey];
    if (!rec) {
      await push(f.title, f.body, { priority: 4, tags: [f.kind === "error" ? "warning" : "hourglass"] }, status);
      seen.health[f.conditionKey] = { firstSeenAt: now, lastNotifiedAt: now, notifyCount: 1 };
      changed = true;
      console.log(`[notifier] pushed ${f.kind} ${f.conditionKey}`);
    } else if (now >= nextHealthDueMs(rec, cfg.health)) {
      const mins = Math.round((now - rec.firstSeenAt) / 60000);
      const dur = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins}m`;
      await push(`Still: ${f.title}`, `Unresolved for ${dur} (alert #${rec.notifyCount + 1}).\n${f.body}`, {
        priority: 5, tags: ["rotating_light"],
      }, status);
      rec.lastNotifiedAt = now; rec.notifyCount += 1;
      changed = true;
      console.log(`[notifier] re-paged ${f.conditionKey} (#${rec.notifyCount})`);
    }
  }
  for (const key of Object.keys(seen.health)) {
    if (active.has(key)) continue;
    delete seen.health[key]; changed = true;
    console.log(`[notifier] cleared health condition ${key}`);
  }

  if (changed) saveSeen(seen);
}

const intervalMs = (cfg.pollSeconds || 45) * 1000;
console.log(`[notifier] start — poll ${cfg.paperclipBase} every ${cfg.pollSeconds || 45}s → ${cfg.ntfy.server}/${cfg.ntfy.topic}`);

async function safeTick() {
  const t0 = Date.now();
  let heartbeat = readHeartbeat();
  const status = {
    lastTickStatus: "running",
    lastPushStatus: heartbeat?.lastPushStatus || "not_attempted",
    lastErrorSummary: heartbeat?.lastErrorSummary || null,
    pushAttempted: false,
  };
  heartbeat = beat(heartbeat, status);
  try {
    await tick(status, (progress) => {
      status.progress = progress;
      heartbeat = beat(heartbeat, status);
    });
    status.lastTickStatus = "ok";
  } catch (err) {
    status.lastTickStatus = "error";
    status.lastErrorSummary ||= String(err.message || err).replace(/\s+/g, " ").slice(0, 240);
    console.error(`[notifier] tick error: ${err.message}`);
  } finally {
    status.tookMs = Date.now() - t0;
    delete status.progress;
    beat(heartbeat, status);
  }
}

// Self-reschedule AFTER each tick completes (not setInterval) so a slow tick can never
// overlap the next one and race on notifier-seen.json.
await safeTick();
if (!ONCE) {
  const schedule = () => setTimeout(async () => { await safeTick(); schedule(); }, intervalMs);
  schedule();
}

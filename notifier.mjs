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
  loadConfig, ROOT, gatherBoardSignals, deriveHealth, nextHealthDueMs,
  issueUrl, ntfy, writeJsonAtomic,
} from "./lib/paperclip.mjs";

const ONCE = process.argv.includes("--once");
const DRY = process.argv.includes("--dry-run"); // read + report only; never pushes, never writes state
const cfg = loadConfig();
const STATE_DIR = path.join(ROOT, "state");
const STATE = path.join(STATE_DIR, "notifier-seen.json");
const HEARTBEAT = path.join(STATE_DIR, "notifier-heartbeat.json"); // liveness proof for selfcheck.mjs
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// Write a liveness heartbeat after every tick attempt (success OR caught error — both mean the
// loop is alive). The independent selfcheck probe pages if this file goes stale. Skipped in
// --dry-run (which mutates nothing). Best-effort: a heartbeat write failure must never crash the loop.
function beat(extra) {
  if (DRY) return;
  try { writeJsonAtomic(HEARTBEAT, { at: Date.now(), iso: new Date().toISOString(), pid: process.pid, ...extra }); }
  catch { /* best-effort */ }
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
async function push(title, message, opts) {
  if (DRY) { console.log(`[notifier:dry] PUSH «${title}» ${String(message).replace(/\n/g, " · ")}`); return; }
  await ntfy(cfg, title, message, opts);
}

// ntfy() is shared with the coder (lib/paperclip.mjs); call it with cfg as the first arg.

async function tick() {
  const seen = loadSeen();
  const seenI = new Set(seen.interactions);
  let changed = false;
  const now = Date.now();

  const { pending, issues, agents } = await gatherBoardSignals(cfg);
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
    await push("Paperclip notifier is live", body, { priority: 3, tags: ["satellite"] });
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
    });
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
      await push(f.title, f.body, { priority: 4, tags: [f.kind === "error" ? "warning" : "hourglass"] });
      seen.health[f.conditionKey] = { firstSeenAt: now, lastNotifiedAt: now, notifyCount: 1 };
      changed = true;
      console.log(`[notifier] pushed ${f.kind} ${f.conditionKey}`);
    } else if (now >= nextHealthDueMs(rec, cfg.health)) {
      const mins = Math.round((now - rec.firstSeenAt) / 60000);
      const dur = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins}m`;
      await push(`Still: ${f.title}`, `Unresolved for ${dur} (alert #${rec.notifyCount + 1}).\n${f.body}`, {
        priority: 5, tags: ["rotating_light"],
      });
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
  try { await tick(); }
  catch (err) { console.error(`[notifier] tick error: ${err.message}`); }
  finally { beat({ tookMs: Date.now() - t0 }); } // prove the loop is alive even if the tick threw
}

// Self-reschedule AFTER each tick completes (not setInterval) so a slow tick can never
// overlap the next one and race on notifier-seen.json.
await safeTick();
if (!ONCE) {
  const schedule = () => setTimeout(async () => { await safeTick(); schedule(); }, intervalMs);
  schedule();
}

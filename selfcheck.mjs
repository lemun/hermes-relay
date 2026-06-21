// Bridge self-health probe — the watcher that watches the watcher.
//
// An INDEPENDENT launchd one-shot (StartInterval, NOT KeepAlive). Each run it GETs the
// Paperclip health endpoint and reads the notifier's heartbeat file, then pages your phone
// via ntfy DIRECTLY — so a dead or wedged notifier can't suppress its own alarm (the exact
// silent-failure class this whole project exists to prevent, moved up one level). Read-only;
// it never touches the Paperclip board.
//
//   node selfcheck.mjs            # one pass then exit (launchd StartInterval re-runs it)
//   node selfcheck.mjs --dry-run  # print what it WOULD page; no push, no state write

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import {
  loadConfig, ROOT, evaluateBridgeHealth, nextHealthDueMs, ntfy, writeJsonAtomic,
} from "./lib/paperclip.mjs";
import { API_TIMEOUT_MS } from "./lib/const.mjs";

const DRY = process.argv.includes("--dry-run");
const cfg = loadConfig();
const STATE_DIR = path.join(ROOT, "state");
const STATE = path.join(STATE_DIR, "selfcheck-seen.json");
const HEARTBEAT = path.join(STATE_DIR, "notifier-heartbeat.json");
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// Escalation ledger (same shape + curve as the notifier's health ledger): conditionKey ->
// { firstSeenAt, lastNotifiedAt, notifyCount }.
function loadSeen() {
  try { const s = JSON.parse(readFileSync(STATE, "utf8")); s.conditions = s.conditions || {}; return s; }
  catch { return { conditions: {} }; }
}
function saveSeen(s) { if (!DRY) writeJsonAtomic(STATE, s); }
function readHeartbeat() { try { return JSON.parse(readFileSync(HEARTBEAT, "utf8")); } catch { return null; } }

async function push(title, message, opts) {
  if (DRY) { console.log(`[selfcheck:dry] PAGE «${title}» ${String(message).replace(/\n/g, " · ")}`); return; }
  await ntfy(cfg, title, message, opts);
}

// Is the Paperclip API up? Prefer the body's {status:"ok"} over a bare 200.
async function probeApi() {
  const url = `${cfg.paperclipBase}${cfg.selfcheck.healthPath}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS) });
    if (!r.ok) return { apiOk: false, apiDetail: `HTTP ${r.status}` };
    const body = await r.json().catch(() => ({}));
    if (body.status && body.status !== "ok") return { apiOk: false, apiDetail: `status=${body.status}` };
    return { apiOk: true, apiDetail: "" };
  } catch (e) { return { apiOk: false, apiDetail: e.message }; }
}

async function run() {
  if (cfg.selfcheck.enabled === false) { console.log("[selfcheck] disabled (selfcheck.enabled=false)"); return; }
  const now = Date.now();
  const { apiOk, apiDetail } = await probeApi();
  const heartbeat = readHeartbeat();
  const wedgedMs = (cfg.selfcheck.notifierWedgedMinutes || 5) * 60 * 1000;
  const findings = evaluateBridgeHealth(now, { apiOk, apiDetail, heartbeat, wedgedMs });

  const seen = loadSeen();
  const active = new Set();
  let changed = false;

  for (const f of findings) {
    active.add(f.conditionKey);
    const rec = seen.conditions[f.conditionKey];
    if (!rec) {
      await push(f.title, f.body, { priority: 5, tags: ["rotating_light"] });
      seen.conditions[f.conditionKey] = { firstSeenAt: now, lastNotifiedAt: now, notifyCount: 1 };
      changed = true;
    } else if (now >= nextHealthDueMs(rec, cfg.health)) {
      const mins = Math.round((now - rec.firstSeenAt) / 60000);
      const dur = mins >= 120 ? `${Math.round(mins / 60)}h` : `${mins}m`;
      await push(`Still: ${f.title}`, `Down for ${dur} (alert #${rec.notifyCount + 1}).\n${f.body}`, { priority: 5, tags: ["rotating_light"] });
      rec.lastNotifiedAt = now; rec.notifyCount += 1; changed = true;
    }
  }

  // A condition that cleared since last run → drop it, and send one "recovered" note if we
  // had actually paged about it.
  for (const key of Object.keys(seen.conditions)) {
    if (active.has(key)) continue;
    const rec = seen.conditions[key];
    delete seen.conditions[key]; changed = true;
    if (rec?.notifyCount) await push("Bridge recovered", `"${key}" is healthy again.`, { priority: 3, tags: ["white_check_mark"] });
  }

  if (changed) saveSeen(seen);
  console.log(`[selfcheck] api=${apiOk ? "ok" : `DOWN(${apiDetail})`} heartbeat=${heartbeat ? `${Math.round((now - heartbeat.at) / 1000)}s old` : "MISSING"} findings=${findings.length}`);
}

run().catch((e) => { console.error(`[selfcheck] error: ${e.message}`); process.exit(1); });

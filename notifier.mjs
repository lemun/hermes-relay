// ntfy push notifier — polls the Paperclip loopback API and pushes a phone alert
// when the BOARD (you) is needed: a new pending request_confirmation card, or an
// agent entering an `error` state. Outbound-only (works over cellular, no inbound
// port, no Tailscale required). Read-only: never mutates the board.
//
//   node notifier.mjs          # long-running loop (launchd uses this)
//   node notifier.mjs --once   # single tick then exit (for testing/cron)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { loadConfig, ROOT, gatherBoardSignals, issueUrl } from "./lib/paperclip.mjs";

const ONCE = process.argv.includes("--once");
const cfg = loadConfig();
const STATE_DIR = path.join(ROOT, "state");
const STATE = path.join(STATE_DIR, "notifier-seen.json");
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

function loadSeen() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); }
  catch { return { firstRunDone: false, interactions: [], errors: [] }; }
}
function saveSeen(s) {
  s.interactions = s.interactions.slice(-300);
  s.errors = s.errors.slice(-300);
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

// Publish via ntfy's JSON format (POST to server root) so emoji/Hebrew in the
// title+message are UTF-8 clean — HTTP headers can't carry non-ASCII.
async function ntfy(title, message, { priority = 4, tags = ["bell"], click } = {}) {
  const payload = { topic: cfg.ntfy.topic, title, message, priority, tags };
  if (click) payload.click = click;
  const r = await fetch(cfg.ntfy.server.replace(/\/$/, ""), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`ntfy POST -> ${r.status} ${await r.text().catch(() => "")}`);
}

async function tick() {
  const seen = loadSeen();
  const seenI = new Set(seen.interactions);
  const seenE = new Set(seen.errors);
  let changed = false;

  const { pending, errors } = await gatherBoardSignals(cfg);

  // First run: send ONE digest instead of a burst of individual pings, then seed.
  if (!seen.firstRunDone) {
    const lines = pending.map((p) => `• ${p.issueIdentifier}: ${p.title}`);
    const body = lines.length
      ? `${lines.length} item(s) waiting on you:\n${lines.join("\n")}`
      : "Nothing needs you right now. You'll get a ping when something does.";
    await ntfy("Paperclip notifier is live", body, { priority: 3, tags: ["satellite"] });
    pending.forEach((p) => seen.interactions.push(p.interactionId));
    errors.forEach((e) => seen.errors.push(`${e.agentId}:${e.at}`));
    seen.firstRunDone = true;
    saveSeen(seen);
    console.log(`[notifier] first run: seeded ${pending.length} pending + ${errors.length} errors, sent digest.`);
    return;
  }

  for (const p of pending) {
    if (seenI.has(p.interactionId)) continue;
    await ntfy(`Needs you · ${p.issueIdentifier}`, `${p.title}\n${p.issueTitle}`, {
      priority: 4, tags: ["bell"], click: issueUrl(cfg, p.issueIdentifier),
    });
    seen.interactions.push(p.interactionId); seenI.add(p.interactionId); changed = true;
    console.log(`[notifier] pushed pending card ${p.issueIdentifier} (${p.interactionId})`);
  }
  for (const e of errors) {
    const key = `${e.agentId}:${e.at}`;
    if (seenE.has(key)) continue;
    await ntfy(`${e.name} entered error`, `Last heartbeat ${e.at}.\nUsually self-heals on next wake; flag if it sticks.`, {
      priority: 4, tags: ["warning"],
    });
    seen.errors.push(key); seenE.add(key); changed = true;
    console.log(`[notifier] pushed agent error ${e.name}`);
  }
  if (changed) saveSeen(seen);
}

const intervalMs = (cfg.pollSeconds || 45) * 1000;
console.log(`[notifier] start — poll ${cfg.paperclipBase} every ${cfg.pollSeconds || 45}s → ${cfg.ntfy.server}/${cfg.ntfy.topic}`);

async function safeTick() {
  try { await tick(); }
  catch (err) { console.error(`[notifier] tick error: ${err.message}`); }
}

await safeTick();
if (!ONCE) setInterval(safeTick, intervalMs);

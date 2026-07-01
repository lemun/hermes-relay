// Interactive pending-card push — the read-side proactive alert (PR-2).
//
// When a NEW pending request_confirmation card appears on the board, Hermes (inside its own
// process) texts the authorized chat an alert with [✅ Approve] [✖️ Reject] [ℹ️ Tell me more]
// buttons. This module is the pure, testable core; hermes-bot.mjs keeps only thin wiring
// (the loop, gatherBoardSignals, and the Telegram send). It is READ-side: the buttons route
// back into the EXISTING confirm-gated act flow (handleAct → YES/Cancel → TOCTOU recheck →
// fail-closed lib/paperclip-write.mjs), so this file adds ZERO new write paths.

import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "./paperclip.mjs";

// Cap the same as the notifier's seen list — a resolved human card never comes back, so 300
// interaction ids is far more than enough dedup memory.
const MAX_INTERACTIONS = 300;
const TITLE_MAX = 200; // defensive truncation so a runaway card title can't blow the alert up

const clip = (s, n = TITLE_MAX) => {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + "…" : str;
};

// Digits from a human identifier: "HOM-27" → "27", "#12" → "12". Returns "" when there are
// none (the caller then omits buttons rather than emit a broken one).
function issueNum(identifier) {
  const m = String(identifier ?? "").match(/(\d+)/);
  return m ? m[1] : "";
}

// Load the push-seen state. Tolerant of a missing or corrupt file (like notifier's loadSeen):
// always returns the clean { firstRunDone, interactions } shape.
export function loadPushSeen({ file }) {
  let s;
  try { s = JSON.parse(readFileSync(file, "utf8")); }
  catch { s = {}; }
  s.firstRunDone = !!s.firstRunDone;
  s.interactions = Array.isArray(s.interactions) ? s.interactions : [];
  return s;
}

// Persist the state atomically (temp + rename via writeJsonAtomic), capping interactions to
// the last MAX_INTERACTIONS. Caller ensures the directory exists.
export function savePushSeen(seen, { file }) {
  const out = {
    firstRunDone: !!seen.firstRunDone,
    interactions: (seen.interactions || []).slice(-MAX_INTERACTIONS),
  };
  writeJsonAtomic(file, out);
}

// Plain-text alert body for a pending card (the gatherBoardSignals pending shape). PLAIN TEXT
// to match the concierge's phone style; title/issueTitle are defensively truncated.
export function cardAlertText(p) {
  return `🔔 Needs you · ${clip(p.issueIdentifier, 40)}\n${clip(p.title)}\non: ${clip(p.issueTitle)}`;
}

// Inline-keyboard rows (the [text, callback_data] pair shape sendKbd expects) for a pending
// card. Callback data is "pcard:<verb>:<num>" — well under Telegram's 64-byte limit. Returns
// null when no digits can be extracted from the identifier, so the caller sends the alert text
// WITHOUT buttons instead of emitting a button that can't be routed.
export function cardAlertKbd(p) {
  const num = issueNum(p.issueIdentifier);
  if (!num) return null;
  return [
    [["✅ Approve", `pcard:accept:${num}`], ["✖️ Reject", `pcard:reject:${num}`]],
    [["ℹ️ Tell me more", `pcard:info:${num}`]],
  ];
}

// Parse a pcard:* callback. "pcard:accept:27" → { verb, num }; "pcard:info:27" → { info, num }.
// Anything malformed (wrong namespace, bad verb, missing/non-digit number) → null, so a stale
// or hand-crafted callback can never smuggle a bad value into the act flow.
export function parsePushCallback(data) {
  const parts = String(data ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== "pcard") return null;
  const [, verb, num] = parts;
  if (!/^\d+$/.test(num)) return null;
  if (verb === "accept" || verb === "reject") return { verb, num };
  if (verb === "info") return { info: true, num };
  return null;
}

// Orchestrate one push tick. Pure-ish: all I/O is injected (gather + send), so it's unit-
// tested with fakes (no fetch, no Telegram). A gather() throw PROPAGATES — the caller logs it
// and leaves the persisted state untouched, so a board hiccup can never advance seen state.
//
// First run (!firstRunDone): seed ALL current pending interactionIds SILENTLY — the ntfy
// notifier already alerted for cards that predate this feature; replaying them as fresh
// interactive alerts on first deploy would double-page. Otherwise: alert once per pending card
// not yet in seen.interactions (deduping repeats within the same gather too).
export async function runPushTick({ seen, gather, send }) {
  const { pending = [] } = await gather();

  if (!seen.firstRunDone) {
    for (const p of pending) {
      if (!seen.interactions.includes(p.interactionId)) seen.interactions.push(p.interactionId);
    }
    seen.firstRunDone = true;
    return { seen, sent: 0 };
  }

  const known = new Set(seen.interactions);
  let sent = 0;
  let failed = 0;
  for (const p of pending) {
    if (known.has(p.interactionId)) continue;
    known.add(p.interactionId); // also dedupes a repeated id within THIS gather result
    // A single send failure must not roll back cards already alerted (losing them from seen
    // would duplicate their alerts next tick) nor block the rest of this batch. Mark seen ONLY
    // on success; a failed card stays un-seen and simply retries next tick (at-least-once,
    // deduped on success).
    try { await send(p); } catch { failed += 1; continue; }
    seen.interactions.push(p.interactionId);
    sent += 1;
  }
  // Bound the seen list here too (not only in savePushSeen) so an in-memory tick that grows it
  // stays capped even before the next save.
  if (seen.interactions.length > MAX_INTERACTIONS) {
    seen.interactions = seen.interactions.slice(-MAX_INTERACTIONS);
  }
  return { seen, sent, failed };
}

// Board WRITE client — the ONLY module that mutates the live Paperclip board.
//
// Deliberately minimal and fail-closed. It exposes exactly two board actions —
// accept and reject of a pending interaction ("request_confirmation" card) — and
// NOTHING else. There is intentionally NO generic forwarder and NO PATCH /api/issues
// passthrough: that endpoint exposes ~23 fields (interrupt/resume/executionPolicy/hiddenAt…)
// and one stray field could wreck a running agent mid-launch. Each action here is a named
// function with a hard-coded route and a key-allowlisted body.
//
// AUTH: a board API key in the Authorization bearer header (the spec's BoardApiKeyAuth scheme,
// verified against the live /api/openapi.json). The key is read from cfg.boardApiKey, which
// loadConfig populates from PAPERCLIP_BOARD_API_KEY (.env). With NO key every call THROWS —
// so a misconfigured deploy can never silently write. (On a local_trusted loopback the board
// is auto-authenticated and a key is technically optional, but we require it on purpose:
// explicit, named, revocable, and independent of ambient loopback trust.)

import { API_TIMEOUT_MS } from "./const.mjs";

const BOARD_KEY_ENV = "PAPERCLIP_BOARD_API_KEY";

function boardKey(cfg) {
  return (cfg && cfg.boardApiKey) || process.env[BOARD_KEY_ENV] || "";
}

// True when the bridge is allowed to write. Callers use this to decide between the real
// confirm-gated action and the read-only deep-link fallback.
export function boardWriteEnabled(cfg) {
  return !!boardKey(cfg);
}

// Internal, NOT exported. Mirrors the read client's fetch shape (8s timeout) but adds the
// method, the JSON body, and the board bearer. Only the two named actions below call it, each
// with a fixed path and an allowlisted body — it is never a public arbitrary-write surface.
async function pcWrite(cfg, method, p, body) {
  const key = boardKey(cfg);
  if (!key) throw new Error(`board writes are disabled — set ${BOARD_KEY_ENV} in .env to enable`);
  const r = await fetch(`${cfg.paperclipBase}${p}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const txt = await r.text();
  let json;
  try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${(json.error || txt || "").slice(0, 160)}`);
  return json;
}

// Accept a pending interaction. Body keys are allowlisted to the two the accept route accepts
// (both optional for a plain request_confirmation); anything else the caller passes is dropped.
export async function acceptCard(cfg, issueId, interactionId, opts = {}) {
  const body = {};
  if (Array.isArray(opts.selectedClientKeys)) body.selectedClientKeys = opts.selectedClientKeys;
  if (Array.isArray(opts.selectedOptionIds)) body.selectedOptionIds = opts.selectedOptionIds;
  return pcWrite(cfg, "POST", `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/accept`, body);
}

// Reject a pending interaction. The ONLY allowed body key is a free-text reason (bounded).
export async function rejectCard(cfg, issueId, interactionId, opts = {}) {
  const body = {};
  if (typeof opts.reason === "string" && opts.reason.trim()) body.reason = opts.reason.trim().slice(0, 1000);
  return pcWrite(cfg, "POST", `/api/issues/${encodeURIComponent(issueId)}/interactions/${encodeURIComponent(interactionId)}/reject`, body);
}

// Parse an explicit accept/reject command from text (typed or transcribed). Returns
// { verb: 'accept'|'reject', num, reason } or null when there is no UNAMBIGUOUS verb+number —
// in which case the caller leaves it to the read-only concierge (which replies with a tap
// link). Requiring an explicit number is the guard against a garbled voice note triggering a
// write: "accept the changes" (no number) → null; "accept 27" → act, but the confirm step
// still echoes the card title for the human to verify before anything mutates.
export function parseActIntent(text) {
  if (!text) return null;
  const m = String(text).trim().match(/^\/?\s*(accept|approve|reject|deny|decline)\b\s*(.*)$/is);
  if (!m) return null;
  const verb = /^(accept|approve)$/i.test(m[1]) ? "accept" : "reject";
  const rest = m[2] || "";
  const idm = rest.match(/\b(?:[a-z]{2,6}[\s-]*)?(\d{1,5})\b/i); // optional spoken/typed prefix, then the number
  if (!idm) return null;
  const num = idm[1];
  const reason = verb === "reject" ? rest.replace(idm[0], " ").replace(/^[\s,:_-]+/, "").trim() : "";
  return { verb, num, reason };
}

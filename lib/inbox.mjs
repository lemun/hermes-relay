// Inbox — the one pinned, edited-in-place Telegram message ("N waiting"),
// plus the per-question cards with one-tap reply buttons.
//
// Design contract: notify only on 0→1 (all other sends are silent), pin once
// and edit forever (a bot may edit its own messages indefinitely; the 48h
// limit applies to deletion, not edits — verified 2026-07-06), never
// unpin/repin (adds an unsuppressible service line). callback_data must stay
// ≤64 bytes, so buttons carry short question ids, never question text.

const REC_BUTTON_MAX = 24; // keep the ✅ button label tappable on one line

function age(iso, now = new Date()) {
  const mins = Math.max(0, Math.round((now - new Date(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`;
  return `${Math.round(mins / (60 * 24))}d`;
}

function firstLine(s, max) {
  const line = String(s || "").split("\n")[0].trim();
  return line.length <= max ? line : line.slice(0, max - 1) + "…";
}

/** The pinned inbox message body. Plain text — phone screens, no markdown. */
export function renderInbox(pending, now = new Date()) {
  if (!pending.length) return "✅ Inbox zero — no questions waiting.";
  const head = `🔔 ${pending.length} waiting`;
  const lines = pending.map(
    (q) => `• ${q.repoKey}#${q.issue} (${age(q.askedAt, now)}): ${firstLine(q.question, 60)}`,
  );
  return [head, ...lines].join("\n");
}

/** One question card. Every question ships with a recommended answer. */
export function questionCardText(q) {
  return [
    `❓ ${q.repoKey}#${q.issue}`,
    "",
    q.question.trim(),
    "",
    `💡 Recommended: ${q.recommended.trim()}`,
  ].join("\n");
}

/** Rows for lib/telegram.mjs kbd(): ✅ recommended / ❌ other / 🔍 explain. */
export function questionCardKbd(q) {
  return [
    [[`✅ ${firstLine(q.recommended, REC_BUTTON_MAX)}`, `ask:yes:${q.id}`]],
    [["❌ Other", `ask:other:${q.id}`], ["🔍 Explain", `ask:explain:${q.id}`]],
  ];
}

/** Strict callback parser — null on anything malformed (fail closed). */
export function parseAskCallback(data) {
  const m = /^ask:(yes|other|explain):(q-[0-9a-f]{8})$/.exec(String(data || ""));
  return m ? { verb: m[1], id: m[2] } : null;
}

/** Morning digest — one silent summary at the configured hour. */
export function morningDigestText({ pending, running }, now = new Date()) {
  const lines = [`☀️ Morning digest`];
  if (pending.length) {
    lines.push(`${pending.length} question${pending.length > 1 ? "s" : ""} waiting on you:`);
    for (const q of pending) {
      lines.push(`• ${q.repoKey}#${q.issue} (${age(q.askedAt, now)}): ${firstLine(q.question, 60)}`);
    }
  } else {
    lines.push("No questions waiting.");
  }
  if (running.length) {
    lines.push(`${running.length} session${running.length > 1 ? "s" : ""} in flight:`);
    for (const s of running) lines.push(`• ${s.repoKey}#${s.issue ?? "—"} ${s.role} (${s.engine})`);
  }
  return lines.join("\n");
}

/** Digest is due when the local hour has been reached and none was sent today. */
export function digestDue({ lastDigestDate, hour, now = new Date() }) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return now.getHours() >= hour && lastDigestDate !== today;
}

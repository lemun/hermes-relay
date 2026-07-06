// The ledger comment — THE durable record of a session (CONTEXT.md, docs/architecture.md).
//
// One structured GitHub issue comment per session, edited in place. The GitHub issue is the
// system of record; sessions are disposable — everything a fresh session needs to continue
// (decisions, assumptions, open questions, the handoff note, the outcome) must survive here,
// not in any session's own memory. render/parse must round-trip losslessly: the bot reads its
// own comment back (to diff before re-editing, to recover after a crash) as often as it writes
// one, so any information the renderer can't recover from its own markdown is data quietly lost.
//
// Pure + immutable: renderLedger/parseLedger have no I/O, and the mutators return NEW ledger
// objects rather than mutating in place, so callers can render + diff before deciding to push an
// edit (coalesced ≥5s per ADR-0002) and tests stay deterministic.

const HEADER_RE = /^<!--\s*hermes-ledger\s+v1\s+session=(\S+?)\s*-->/;

const STATUSES = ["running", "waiting-input", "done", "failed", "blocked"];

// --- quoted-text escaping -----------------------------------------------------------------
//
// Question/answer text is rendered inside a double-quoted `"…"` span on a single bullet line.
// Escaping every embedded `"` (e.g. as `\"`) would round-trip fine but is easy to get subtly
// wrong across engines/editors re-touching the comment by hand. Since ledger text is prose (not
// code), we take the simpler, more robust-to-hand-editing route: replace inner double quotes
// with a single quote at render time. This is a deliberate, documented lossy transform for a
// rare character (double quotes inside a question), not a bug — it guarantees the surrounding
// `"…"` span can never be broken by embedded quotes, which keeps parsing trivial and reliable.
function foldQuotes(s) {
  return String(s ?? "").replace(/"/g, "'");
}

// --- defaults / constructors ---------------------------------------------------------------

// Fresh ledger for a brand-new session. Sane defaults: running status, empty collections, null
// scalars (rendered as `—` placeholders — see renderLedger).
export function emptyLedger({ sessionId, role, engine }) {
  return {
    sessionId,
    role,
    engine,
    status: "running",
    worktree: null,
    engineSessionId: null,
    branch: null,
    decisions: [],
    assumptions: [],
    questions: [],
    handoffNote: "",
    outcome: "",
  };
}

// --- rendering ---------------------------------------------------------------------------

function renderBulletList(lines) {
  if (!lines || lines.length === 0) return "_none yet_";
  return lines.map((l) => `- ${l}`).join("\n");
}

function renderQuestions(questions) {
  if (!questions || questions.length === 0) return "_none yet_";
  return questions
    .map((q) => {
      let line = `- [${q.id}] asked ${q.askedAt} — "${foldQuotes(q.question)}"`;
      if (q.answer != null && q.answeredAt != null) {
        line += ` → answered ${q.answeredAt}: "${foldQuotes(q.answer)}"`;
      }
      return line;
    })
    .join("\n");
}

function renderFreeText(text) {
  const t = String(text ?? "").trim();
  return t ? t : "_none yet_";
}

// Render a ledger object to the exact markdown format in docs/architecture.md. Fields that are
// null are rendered as `—` so the worktree/engine-session/branch line keeps a stable shape a
// human (or a re-parse) can always find, whether or not the session has claimed a worktree yet.
export function renderLedger(ledger) {
  const l = ledger;
  const dash = (v) => (v == null || v === "" ? "—" : v);
  return [
    `<!-- hermes-ledger v1 session=${l.sessionId} -->`,
    `### Hermes session \`${l.sessionId}\` — ${l.role} · ${l.engine}`,
    `**Status:** ${l.status}`,
    `**Worktree:** \`${dash(l.worktree)}\` · **Engine session:** \`${dash(l.engineSessionId)}\` · **Branch:** \`${dash(l.branch)}\``,
    ``,
    `#### Decisions`,
    renderBulletList(l.decisions),
    ``,
    `#### Assumptions`,
    renderBulletList(l.assumptions),
    ``,
    `#### Questions`,
    renderQuestions(l.questions),
    ``,
    `#### Handoff note`,
    renderFreeText(l.handoffNote),
    ``,
    `#### Outcome`,
    renderFreeText(l.outcome),
    ``,
  ].join("\n");
}

// --- parsing -----------------------------------------------------------------------------

// `—` (or empty) parses back to null — the inverse of renderLedger's `dash()`.
function undash(v) {
  const t = (v ?? "").trim();
  return t === "" || t === "—" ? null : t;
}

const QUESTION_LINE_RE =
  /^-\s*\[([^\]]+)\]\s*asked\s+(\S+)\s*—\s*"([\s\S]*?)"(?:\s*→\s*answered\s+(\S+)\s*:\s*"([\s\S]*?)")?\s*$/;

function parseQuestionLine(line) {
  const m = line.match(QUESTION_LINE_RE);
  if (!m) return null;
  const [, id, askedAt, question, answeredAt, answer] = m;
  return {
    id,
    askedAt,
    question,
    answer: answer ?? null,
    answeredAt: answeredAt ?? null,
  };
}

function parseBulletList(body) {
  const t = body.trim();
  if (!t || t === "_none yet_") return [];
  return t
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"))
    .map((line) => line.replace(/^-\s?/, ""));
}

function parseQuestions(body) {
  const t = body.trim();
  if (!t || t === "_none yet_") return [];
  return t
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseQuestionLine)
    .filter(Boolean);
}

function parseFreeText(body) {
  const t = body.trim();
  return t === "_none yet_" ? "" : t;
}

// Split the markdown (after the title/meta lines) into `#### <Section>` blocks, keyed by
// lowercased heading text. Unknown headings are kept in the map but simply never consulted —
// this is how "unknown extra sections are ignored" without needing a special case.
function splitSections(body) {
  const lines = body.split("\n");
  const blocks = [];
  for (const line of lines) {
    const m = line.match(/^####\s+(.+?)\s*$/);
    if (m) {
      blocks.push({ heading: m[1].trim().toLowerCase(), lines: [] });
    } else if (blocks.length) {
      blocks[blocks.length - 1].lines.push(line);
    }
  }
  const out = {};
  for (const b of blocks) {
    const text = b.lines.join("\n").trim();
    // First occurrence wins if a heading somehow repeats; keeps behavior predictable.
    if (!(b.heading in out)) out[b.heading] = text;
  }
  return out;
}

// Parse a rendered ledger comment back into a ledger object. Returns null when the header
// marker is absent or malformed — callers use this to distinguish "our comment" from any other
// comment on the issue (see isLedgerComment/ledgerSessionId below). Tolerant of \r\n line
// endings, extra whitespace, sections in any order, and unknown extra sections (ignored).
export function parseLedger(markdown) {
  if (typeof markdown !== "string") return null;
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headerMatch = lines[0] && lines[0].match(HEADER_RE);
  if (!headerMatch) return null;
  const sessionId = headerMatch[1];

  const titleLine = lines[1] ?? "";
  const titleMatch = titleLine.match(/^###\s+Hermes session\s+`([^`]*)`\s+—\s+(\S+)\s+·\s+(\S+)\s*$/);
  if (!titleMatch) return null;
  const role = titleMatch[2];
  const engine = titleMatch[3];

  const rest = lines.slice(2).join("\n");

  const statusMatch = rest.match(/\*\*Status:\*\*\s*(\S+)/);
  const status = statusMatch ? statusMatch[1].trim() : null;
  if (!status || !STATUSES.includes(status)) return null;

  const metaMatch = rest.match(
    /\*\*Worktree:\*\*\s*`([^`]*)`\s*·\s*\*\*Engine session:\*\*\s*`([^`]*)`\s*·\s*\*\*Branch:\*\*\s*`([^`]*)`/
  );
  const worktree = metaMatch ? undash(metaMatch[1]) : null;
  const engineSessionId = metaMatch ? undash(metaMatch[2]) : null;
  const branch = metaMatch ? undash(metaMatch[3]) : null;

  const sections = splitSections(rest);

  const decisions = "decisions" in sections ? parseBulletList(sections["decisions"]) : [];
  const assumptions = "assumptions" in sections ? parseBulletList(sections["assumptions"]) : [];
  const questions = "questions" in sections ? parseQuestions(sections["questions"]) : [];
  const handoffNote = "handoff note" in sections ? parseFreeText(sections["handoff note"]) : "";
  const outcome = "outcome" in sections ? parseFreeText(sections["outcome"]) : "";

  return {
    sessionId,
    role,
    engine,
    status,
    worktree,
    engineSessionId,
    branch,
    decisions,
    assumptions,
    questions,
    handoffNote,
    outcome,
  };
}

// --- comment identification ----------------------------------------------------------------

// True when `body` carries the hermes-ledger header marker — how the bot recognizes its own
// comment among any others a human or another bot left on the issue.
export function isLedgerComment(body) {
  if (typeof body !== "string") return false;
  const firstLine = body.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
  return HEADER_RE.test(firstLine);
}

// Extract the session id from a ledger comment's header marker, or null when `body` isn't one
// (absent/malformed marker) — same hostile-input tolerance as parseLedger's header check.
export function ledgerSessionId(body) {
  if (typeof body !== "string") return null;
  const firstLine = body.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
  const m = firstLine.match(HEADER_RE);
  return m ? m[1] : null;
}

// --- pure mutators ---------------------------------------------------------------------------
//
// Each returns a NEW ledger object (input untouched) so callers can render the result, diff it
// against the last-pushed comment body, and only push an edit when something actually changed.

export function addDecision(ledger, line) {
  return { ...ledger, decisions: [...ledger.decisions, line] };
}

export function addAssumption(ledger, line) {
  return { ...ledger, assumptions: [...ledger.assumptions, line] };
}

export function appendQuestion(ledger, q) {
  const question = {
    id: q.id,
    askedAt: q.askedAt,
    question: q.question,
    answer: q.answer ?? null,
    answeredAt: q.answeredAt ?? null,
  };
  return { ...ledger, questions: [...ledger.questions, question] };
}

export function answerQuestion(ledger, qId, answer, answeredAt) {
  return {
    ...ledger,
    questions: ledger.questions.map((q) => (q.id === qId ? { ...q, answer, answeredAt } : q)),
  };
}

export function setHandoffNote(ledger, text) {
  return { ...ledger, handoffNote: text };
}

export function setOutcome(ledger, text) {
  return { ...ledger, outcome: text };
}

export function setStatus(ledger, status) {
  return { ...ledger, status };
}

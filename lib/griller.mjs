// Grilling sessions (CONTEXT.md "Grilling"; docs/architecture.md label vocabulary) — the
// Claude-run interrogation of an issue's design before it is marked `ready`. Self-grilling
// answers its own questions from repo evidence and escalates ONLY owner-class decisions
// (product/UX/scope/irreversible/no-precedent) via mcp__hermes__ask_owner — unlimited count,
// always with a recommended answer (ADR-0001: ask_owner is a plain tool call, never elicitation).
// A grilling session ends by asking engine+effort for implementation, then goes STRAIGHT to
// `ready` — there is no separate skim gate. Everything here is pure (no I/O, no spawning): the
// caller (the bot) feeds the built prompt into a real engine session per lib/engines.mjs and
// hands the raw final message back to parseGrillerResult.

const ENGINES = ["codex", "claude"];
const EFFORTS = ["low", "medium", "high"];
const DEFAULT_ENGINE = "codex"; // ADR-0005: codex is the default engine; claude is the override
const DEFAULT_EFFORT = "high";

// Last fenced ```json ... ``` block in `text`, tolerant of leading/trailing prose around it
// (engines routinely wrap their final answer in a sentence or two). Returns the raw fenced
// body string, or null if no fenced json block is present at all.
function lastFencedJsonBlock(text) {
  if (typeof text !== "string" || !text) return null;
  const re = /```json\s*([\s\S]*?)```/g;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) last = match[1];
  return last;
}

// ── prompt building ──────────────────────────────────────────────────────────────────────

// Build the full prompt for a grilling session. Pure string assembly — order matters (tested):
// role+issue body, then interrogation instructions, then the ask_owner escalation contract,
// then the mandatory final engine+effort question, then (if any) prior handoff notes, then the
// fenced-json result contract.
export function buildGrillerPrompt({ issue, repoSlug, handoffNotes }) {
  const { number, title, body, labels } = issue;
  const notes = Array.isArray(handoffNotes) ? handoffNotes : [];

  const lines = [];

  lines.push(
    `You are a grilling session for issue #${number} ("${title}") in ${repoSlug}.`,
    `Labels on the issue: ${Array.isArray(labels) ? labels.join(", ") || "(none)" : "(none)"}.`,
    "",
    "The full issue body follows:",
    "```",
    body || "",
    "```",
    ""
  );

  lines.push(
    "Interrogate this design against the ACTUAL repo, not against assumptions. Read the relevant",
    "code FIRST and cite the specific files/lines that ground each answer. Self-answer every",
    "question you can resolve from that evidence — do not escalate anything you can settle by",
    "reading the repo.",
    ""
  );

  lines.push(
    "Escalate ONLY owner-class decisions — product/UX choices, scope calls, irreversible actions,",
    "or anything with no precedent in this repo — via the mcp__hermes__ask_owner tool. Call it once",
    "per decision, and ALWAYS include a recommended answer (ask_owner never ships without one).",
    "There is no cap on how many owner-class questions you may ask.",
    ""
  );

  lines.push(
    "Your LAST ask_owner call, after every design question is settled, must ask which engine",
    '(codex — the default — or claude) and which effort (low/medium/high) to implement this with,',
    "with a recommendation for both.",
    ""
  );

  if (notes.length) {
    lines.push("Previous session handoff:");
    for (const note of notes) lines.push(`- ${note}`);
    lines.push("");
  }

  lines.push(
    "END your final message with a fenced ```json block, and nothing after it, of this exact shape:",
    "```json",
    JSON.stringify(
      {
        ready: true,
        decisions: ["…"],
        assumptions: ["assumed: X because Y"],
        handoffNote: "…",
        engine: "codex",
        effort: "high",
        blockedReason: null,
      },
      null,
      2
    ),
    "```",
    "`ready` is false only when you are genuinely blocked (say why in blockedReason); otherwise",
    "true. `handoffNote` must let an implementer start WITHOUT re-exploring the repo: name the",
    "files to touch, the approach, and any constraints you uncovered."
  );

  return lines.join("\n");
}

// ── result parsing ───────────────────────────────────────────────────────────────────────

// Parse a griller session's final message into the result object, or null if no fenced json
// block is parseable at all. Defaults are applied leniently (engine/effort/arrays) so a
// slightly-malformed-but-present block still yields a usable result — only a genuinely absent
// or unparseable block returns null.
export function parseGrillerResult(lastText) {
  const block = lastFencedJsonBlock(lastText);
  if (block === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const engine = ENGINES.includes(parsed.engine) ? parsed.engine : DEFAULT_ENGINE;
  const effort = EFFORTS.includes(parsed.effort) ? parsed.effort : DEFAULT_EFFORT;

  return {
    ready: !!parsed.ready,
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    handoffNote: typeof parsed.handoffNote === "string" ? parsed.handoffNote : "",
    engine,
    effort,
    blockedReason: parsed.blockedReason == null ? null : String(parsed.blockedReason),
  };
}

// ── label transitions (docs/architecture.md label vocabulary) ──────────────────────────────

// Label add/remove sets for a griller result. `ready` always drops needs-grilling/grilling.
// engine:claude is added ONLY when the griller picked claude — codex is the default engine, so
// no label is needed to represent it (absence of engine:claude/engine:codex means codex).
export function grillerLabelTransitions(result) {
  const remove = ["needs-grilling", "grilling"];
  if (result?.ready) {
    const add = ["ready"];
    if (result.engine === "claude") add.push("engine:claude");
    return { add, remove };
  }
  return { add: ["blocked"], remove };
}

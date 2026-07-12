// /file capture + read-only issue chat. `/file <text>` shapes a phone-dictated report (possibly
// Hebrew, possibly garbled voice transcription) into a GitHub issue that lands with
// `needs-grill` — the first stop in the pipeline (docs/architecture.md label vocabulary).
// Issue chat is a SEPARATE, read-only, scope-disciplined surface: it answers questions about
// these repos/issues/PRs from live `gh` reads, and refuses to be a general assistant. Both halves
// are pure prompt/parsing builders — no I/O, no spawning; the caller feeds these into a real
// engine session per lib/engines.mjs.

import { LABELS } from "./labels.mjs";
import { GITHUB_READ_ALLOWED_TOOLS } from "./engines.mjs";

// ── /file capture ────────────────────────────────────────────────────────────────────────

// Build the prompt that shapes a phone-dictated report into a GitHub issue. `repos` is
// `{ key: { slug, label } }` — every configured repo is listed with its label so the model can
// pick the right repoKey (or null when genuinely ambiguous, never a guess).
export function buildFilingPrompt({ text, repos }) {
  const repoEntries = Object.entries(repos || {});

  const lines = [];

  lines.push(
    "Shape this phone-dictated report into a GitHub issue. The text may be in Hebrew, and it may",
    "be a garbled voice transcription — read past transcription noise to the intended meaning.",
    ""
  );

  lines.push("Report:", "```", text || "", "```", "");

  lines.push(
    "Write a crisp, imperative title in English, at most 70 characters.",
    "Write a body with three sections — Problem / Expected / Context — in a QA-report style.",
    "Keep the owner's own language inside the body where it reads naturally (e.g. quote the",
    "original Hebrew phrase if translating it would lose meaning).",
    ""
  );

  lines.push("Pick the repo this belongs to from this list (repoKey — label):");
  if (repoEntries.length) {
    for (const [key, r] of repoEntries) lines.push(`- ${key} — ${r?.label ?? key}`);
  } else {
    lines.push("_no repos configured_");
  }
  lines.push(
    "If it is genuinely ambiguous which repo this belongs to, use null for repoKey rather than",
    "guessing.",
    ""
  );

  lines.push(
    "End your response with ONLY a fenced json block, nothing before or after it, of this exact",
    "shape:",
    "```json",
    JSON.stringify({ title: "…", body: "…", repoKey: "rn" }, null, 2),
    "```",
    "(repoKey is one of the listed keys, or null.)"
  );

  return lines.join("\n");
}

// Last fenced ```json ... ``` block in `text`, tolerant of leading/trailing prose.
function lastFencedJsonBlock(text) {
  if (typeof text !== "string" || !text) return null;
  const re = /```json\s*([\s\S]*?)```/g;
  let match;
  let last = null;
  while ((match = re.exec(text)) !== null) last = match[1];
  return last;
}

// Parse a filing session's final message into { title, body, repoKey }, or null when there is no
// parseable json block OR the title is missing/empty — a filed issue with no title is not a
// usable result, so that hostile case collapses to null rather than shipping a blank issue.
export function parseFiledIssue(lastText) {
  const block = lastFencedJsonBlock(lastText);
  if (block === null) return null;

  let parsed;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (!title) return null;

  return {
    title,
    body: typeof parsed.body === "string" ? parsed.body : "",
    repoKey: typeof parsed.repoKey === "string" ? parsed.repoKey : null,
  };
}

// Labels a freshly filed issue lands with — first stop in the pipeline, awaiting a grilling
// session (docs/architecture.md label vocabulary).
export const FILED_ISSUE_LABELS = [LABELS.NEEDS_GRILL];

// ── read-only issue chat ─────────────────────────────────────────────────────────────────

// System prompt for the read-only issue chat. Mirrors the phone-texting tone rules from
// hermes-bot.mjs's SYSTEM (plain text, no markdown, concise, raw urls) but narrows scope to
// these GitHub repos/issues/PRs only — this is NOT a general assistant, and it must never
// mutate anything (structured repo-allowlisted reads only; see ISSUE_CHAT_ALLOWED_TOOLS below).
export function buildIssueChatSystem({ repos }) {
  const repoEntries = Object.entries(repos || {});
  const repoList = repoEntries.length
    ? repoEntries.map(([key, r]) => `${key} (${r?.slug ?? "?"} — ${r?.label ?? key})`).join(", ")
    : "(no repos configured)";

  return [
    "You are the Hermes issue chat: a read-only assistant over a fixed set of GitHub repos.",
    "You reply by phone text: concise, plain sentences. PLAIN TEXT ONLY — no markdown at all",
    "(no **bold**, no #, no tables, no backticks). A few short lines max.",
    "Print every link as the RAW url on its own line (http://… or https://…), never as",
    "[text](url) — phone apps only auto-link raw urls.",
    `Your scope is ONLY these repos and their issues/PRs: ${repoList}. Answer questions about`,
    "issues, PRs, labels, statuses, diffs, and history in these repos — nothing else.",
    "If asked about anything outside this scope (general coding help, unrelated repos, anything",
    "not about these issues/PRs), refuse briefly and redirect to what you can answer.",
    "Answer from the structured GitHub read tools — never invent issue numbers, statuses, or content.",
    "You are READ-ONLY: you never mutate anything. You have no tool that can write, comment,",
    "label, close, merge, or push — only view/list/diff/search commands. Never claim to have",
    "changed anything.",
  ].join(" ");
}

// The issue chat gets only the structured GitHub-read MCP tools. The MCP validates every repo
// slug against Hermes's configured allowlist before it can invoke `gh`; no raw Bash reaches the
// model, and no free-form command/argv/API-path parameter exists.
export const ISSUE_CHAT_ALLOWED_TOOLS = Object.freeze([...GITHUB_READ_ALLOWED_TOOLS]);

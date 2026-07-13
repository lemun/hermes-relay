// Dispatch (CONTEXT.md "Dispatch") — spawning an implementation session for a `ready` issue.
// Default engine is codex, overridable per-issue via the `engine:claude` label. Per ADR-0003
// the sandboxed session itself never touches the network: it works, commits locally, and stops;
// the BOT does `git push` + `gh pr create` afterward, from its own (unsandboxed) process. Per
// ADR-0005 there is only one global codex slot — parallelism comes from claude sessions instead
// (that gate lives in lib/gates.mjs, not here). Everything below is pure/injectable: no module
// here spawns the actual engine process — lib/engines.mjs's buildClaudeArgs/buildCodexArgs do
// that argv work; this module only decides which engine, which worktree, what prompt, and how
// to land the result (push + PR) once a session is done.

import { randomBytes } from "node:crypto";
import { exec as defaultExec } from "./proc.mjs";
import { lastFencedJson } from "./fenced-json.mjs";
import { LABELS } from "./labels.mjs";

const ENGINE_LABEL_RE = /^engine:(claude|codex)$/;

// ── engine selection ─────────────────────────────────────────────────────────────────────

// The `engine:claude` / `engine:codex` label on the issue overrides defaultEngine (which is
// itself runtime-switchable via /tiers → hermes.defaultEngine, docs/architecture.md Config).
// An issue carrying neither label falls through to defaultEngine.
export function engineForIssue(issue, defaultEngine = "codex") {
  const labels = Array.isArray(issue?.labels) ? issue.labels : [];
  for (const label of labels) {
    const m = String(label).match(ENGINE_LABEL_RE);
    if (m) return m[1];
  }
  return defaultEngine;
}

// ── naming ────────────────────────────────────────────────────────────────────────────────

// Mirrors lib/coder.mjs's slugify (same bounded, url-safe branch-fragment shape) — kept as an
// independent copy rather than an import so dispatch's naming rules can't be perturbed by a
// change intended for the (unrelated) phone-coding slugify.
export function slugForIssue(issue) {
  const s = issue?.title || "issue";
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "issue"
  );
}

// `branch`/`dirName` for a fresh implementer worktree. `randomImpl` is injectable (defaults to
// crypto.randomBytes) so tests get deterministic hex without touching real randomness.
export function worktreeBranchFor({ repoKey, issue, randomImpl = randomBytes }) {
  const slug = slugForIssue(issue);
  const hex = randomImpl(2).toString("hex"); // 2 bytes -> 4 hex chars
  return {
    branch: `hermes/${issue.number}-${slug}`,
    dirName: `hermes-wt-hermes-${repoKey}-${issue.number}-${hex}`,
  };
}

// ── worktree creation ────────────────────────────────────────────────────────────────────

// Create the implementer's isolated worktree off the repo's default branch. `git fetch origin`
// is best-effort (tolerate failure — e.g. offline — rather than blocking dispatch on network);
// the default branch ref is then resolved via the remote HEAD symref, falling back to
// "origin/main" when that symref is itself unset (a repo that's never had `git remote set-head`
// run). Throws with the raw git stderr on failure so the caller can park the issue as blocked
// with a plain-language reason (ADR-0003's contract for how failures surface).
export async function createWorktree({ repoPath, worktreeBase, branch, dirName, execImpl = defaultExec }) {
  await execImpl("git", ["-C", repoPath, "fetch", "origin"]); // best-effort; ignore the result

  const symref = await execImpl("git", ["-C", repoPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const defaultRef = symref.code === 0 && symref.stdout.trim() ? symref.stdout.trim() : "origin/main";

  const worktree = `${worktreeBase}/${dirName}`;
  const add = await execImpl("git", ["-C", repoPath, "worktree", "add", worktree, "-b", branch, defaultRef]);
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr.trim() || add.code}`);
  }

  return { worktree, branch };
}

// Warm a fresh worktree with the main checkout's node_modules. The sandboxed session
// cannot `npm install` (network is OFF by design — ADR-0003), so without this the
// lint/typecheck/tests mandate in the implementer contract is unrunnable. `cp -c` is
// APFS clonefile: a copy-on-write clone that takes seconds and shares blocks, not a
// multi-GB physical copy. Non-fatal by contract — a cold worktree still dispatches
// (the finisher's CI leg remains the net); the caller relays `reason` to the owner.
export async function warmWorktree({ repoPath, worktree, execImpl = defaultExec }) {
  const src = `${repoPath}/node_modules`;
  const dst = `${worktree}/node_modules`;
  const probe = await execImpl("test", ["-d", src]);
  if (probe.code !== 0) return { warmed: false, reason: "no node_modules in the main checkout" };
  const cp = await execImpl("cp", ["-Rc", src, dst], { timeout: 5 * 60 * 1000 });
  if (cp.code !== 0) {
    return { warmed: false, reason: (cp.stderr.trim() || `cp exited ${cp.code}`).slice(0, 200) };
  }
  return { warmed: true };
}

// Commit whatever the session left in the worktree. Sessions cannot commit themselves:
// a git worktree's gitdir lives under the PARENT repo's .git/worktrees/<name>/ — outside
// the sandbox's writable root — so `git commit` dies on index.lock (live-verified on the
// rn#347 maiden voyage, 2026-07-06). Granting the sandbox .git access would hand a
// prompt-injected session the parent repo's hooks/refs, so the hub commits instead —
// the same post-session auto-commit lib/coder.mjs has always done.
async function recoverSessionCommit({ worktree, sessionId, execImpl }) {
  if (!sessionId) return null;
  const head = await execImpl("git", ["-C", worktree, "log", "-1", "--format=%H%n%B"]);
  if (head.code !== 0) return null;
  const [commitSha = "", ...messageLines] = head.stdout.split("\n");
  if (!commitSha.trim() || !messageLines.join("\n").includes(`Hermes session ${sessionId} (`)) return null;
  return { committed: true, recovered: true, commitSha: commitSha.trim() };
}

export async function commitWorktree({ worktree, message, sessionId, authorizeImpl, execImpl = defaultExec }) {
  const deferred = () => ({
    committed: false,
    reason: "runtime security policy denied commit finalization",
    deferred: true,
  });
  const authorized = () => !authorizeImpl || authorizeImpl() === true;

  if (!authorized()) return deferred();
  const status = await execImpl("git", ["-C", worktree, "status", "--porcelain"]);
  if (status.code !== 0) return { committed: false, reason: status.stderr.trim() || "git status failed" };
  if (!status.stdout.trim()) {
    return (await recoverSessionCommit({ worktree, sessionId, execImpl }))
      || { committed: false, reason: "clean" };
  }
  if (!authorized()) return deferred();
  await execImpl("git", ["-C", worktree, "add", "-A"]);
  if (!authorized()) return deferred();
  const commit = await execImpl("git", ["-C", worktree, "commit", "-m", message]);
  if (commit.code !== 0) return { committed: false, reason: commit.stderr.trim() || `commit exited ${commit.code}` };
  if (!sessionId) return { committed: true };
  const head = await execImpl("git", ["-C", worktree, "rev-parse", "HEAD"]);
  return { committed: true, commitSha: head.code === 0 ? head.stdout.trim() : null };
}

// ── implementer prompt ───────────────────────────────────────────────────────────────────

// Build the full prompt for an implementation session. Order matters (tested): role, then the
// ratified decisions/assumptions/handoff note (BINDING — the implementer must not re-litigate
// them), then the issue body, then the dispatch prompt contract (worktree-only, no push/PR,
// lint+typecheck+tests mandate, ask_owner for owner-class decisions mid-implementation), then
// the fenced-json result contract.
export function buildImplementerPrompt({ issue, repoSlug, decisions, assumptions, handoffNote }) {
  const { number, title, body } = issue;
  const decisionLines = Array.isArray(decisions) ? decisions : [];
  const assumptionLines = Array.isArray(assumptions) ? assumptions : [];

  const lines = [];

  lines.push(`You are an implementation session for issue #${number} ("${title}") in ${repoSlug}.`, "");

  lines.push(
    "The grilling session that preceded you already ratified the design. These decisions,",
    "assumptions, and handoff note are BINDING — do not re-litigate them; build against them.",
    ""
  );

  lines.push("Ratified decisions:");
  lines.push(decisionLines.length ? decisionLines.map((d) => `- ${d}`).join("\n") : "_none recorded_");
  lines.push("");

  lines.push("Assumptions:");
  lines.push(assumptionLines.length ? assumptionLines.map((a) => `- ${a}`).join("\n") : "_none recorded_");
  lines.push("");

  lines.push("Handoff note:");
  lines.push(handoffNote && String(handoffNote).trim() ? String(handoffNote) : "_none recorded_");
  lines.push("");

  lines.push("The full issue body follows:", "```", body || "", "```", "");

  lines.push(
    "Work only inside this worktree. You have NO network access.",
    "",
    "Do NOT git commit, git push, or open a PR — the hub commits and pushes your work after you",
    "finish. (This worktree's git metadata lives outside your sandbox, so git writes would fail",
    "anyway; network is off by design, so a prompt-injected session can't exfiltrate over the",
    "network; the hub owns commit+push+PR uniformly across engines.)",
    "",
    "BEFORE declaring done: run this repo's lint, typecheck, and tests locally and fix what they",
    "surface. Peer PRs keep failing CI on lint — this contract exists to fix exactly that.",
    "Dependencies are pre-installed (node_modules is cloned from the main checkout) — do NOT try",
    "to npm install (no network). If dependency state looks broken, say so in your summary.",
    "",
    "For owner-class decisions that come up mid-implementation, use mcp__hermes__ask_owner (always",
    "with a recommended answer); otherwise proceed on stated assumptions and record them.",
    "",
    "Follow-up issues or comments are proposals only. Put them in issueProposals or",
    "commentProposals. The hub will never file, create, post, or otherwise execute them; it only",
    "shows them to the owner as inert suggestions for separate review.",
    ""
  );

  lines.push(
    "Before finishing, author the pull request text: if this repo has a",
    ".github/PULL_REQUEST_TEMPLATE.md, read it and write prBody following it EXACTLY (fill its",
    "sections in the plain language it asks for; delete sections it marks deletable when they",
    `don't apply; the Issue section must say "Closes #${number}"). prTitle is one imperative`,
    "sentence in the style of the repo's merged PRs, no issue-number suffix. If there is no",
    "template, write a short plain-language description instead.",
    "",
    "END your final message with a fenced ```json block, and nothing after it, of this exact shape:",
    "```json",
    JSON.stringify(
      {
        done: true,
        summary: "…",
        prTitle: "…",
        prBody: "…",
        issueProposals: [],
        commentProposals: [],
        assumptions: [],
        blockedReason: null,
      },
      null,
      2
    ),
    "```"
  );

  return lines.join("\n");
}

// Last fenced ```json ... ``` block in `text`, tolerant of leading/trailing prose. Shared shape
// with lib/griller.mjs's parser (independent copy — see slugForIssue's comment on why these
// modules don't share helpers across a module boundary that should stay independently testable).
// Parse an implementer session's final message into inert result/proposal data, or null when no
// fenced json block is parseable at all. Extraction is brace-balancing
// (lib/fenced-json.mjs) — a prBody containing its own code fences must not truncate the block
// (live failure rn#280).
export function parseImplementerResult(lastText) {
  const parsed = lastFencedJson(lastText);
  if (!parsed || typeof parsed !== "object") return null;

  // Proposal data is deliberately carried as opaque, inert data. Legacy sessions may still
  // return the old write-shaped field names, so normalize those into the proposal contract
  // instead of preserving an executable-looking key that a downstream caller could misuse.
  const issueProposals = [
    ...(Array.isArray(parsed.issueProposals) ? parsed.issueProposals : []),
    ...(Array.isArray(parsed.issuesToCreate) ? parsed.issuesToCreate : []),
  ];
  const commentProposals = [
    ...(Array.isArray(parsed.commentProposals) ? parsed.commentProposals : []),
    ...(Array.isArray(parsed.comments) ? parsed.comments : []),
  ];

  return {
    done: !!parsed.done,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    prTitle: typeof parsed.prTitle === "string" ? parsed.prTitle : "",
    prBody: typeof parsed.prBody === "string" ? parsed.prBody : "",
    issueProposals,
    commentProposals,
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    blockedReason: parsed.blockedReason == null ? null : String(parsed.blockedReason),
  };
}

// ── bot-side push + PR (ADR-0003) ────────────────────────────────────────────────────────

// Last /<digits> segment in `text` — how a PR number is recovered from whatever URL `gh pr
// create` printed to stdout (the URL is the last thing on the line either way).
function lastPrNumber(text) {
  const matches = [...String(text ?? "").matchAll(/\/(\d+)(?:\D*)?$/gm)];
  if (!matches.length) return null;
  return Number(matches[matches.length - 1][1]);
}

// Push the implementer's branch and open the PR. Bot-side only (ADR-0003) — never called from
// inside a sandboxed session. Never throws: on failure it returns { error } so the caller can
// park the issue as blocked with a plain-language reason instead of crashing the dispatch loop.
export async function pushAndOpenPr({
  worktree, branch, repoSlug, issue, summary, prTitle, prBody,
  authorizeImpl, execImpl = defaultExec,
}) {
  if (authorizeImpl && authorizeImpl() !== true) {
    return { error: "runtime security policy denied PR finalization", deferred: true };
  }
  const push = await execImpl("git", ["-C", worktree, "push", "-u", "origin", branch]);
  if (push.code !== 0) {
    return { error: (push.stderr || "git push failed").trim().slice(0, 300) };
  }
  if (authorizeImpl && authorizeImpl() !== true) {
    return { error: "runtime security policy denied PR finalization", deferred: true };
  }

  const findExistingPr = async () => {
    const found = await execImpl("gh", [
      "pr", "list", "--repo", repoSlug, "--head", branch, "--state", "open",
      "--limit", "1", "--json", "number,url",
    ]);
    if (found.code !== 0) {
      return { error: (found.stderr || "cannot verify whether the branch already has a PR").trim().slice(0, 300) };
    }
    try {
      const [pr] = JSON.parse(found.stdout || "[]");
      if (Number.isInteger(pr?.number) && typeof pr?.url === "string" && pr.url) {
        return { prNumber: pr.number, url: pr.url, recovered: true };
      }
      return null;
    } catch {
      return { error: "cannot verify whether the branch already has a PR: malformed gh response" };
    }
  };

  const existing = await findExistingPr();
  if (existing) return existing;
  if (authorizeImpl && authorizeImpl() !== true) {
    return { error: "runtime security policy denied PR finalization", deferred: true };
  }

  // The session authors the PR per the repo's own PULL_REQUEST_TEMPLATE.md
  // (prTitle/prBody from its result json); the fallback is the bare summary.
  // Closes #N is appended if the authored body forgot it — auto-close must
  // never depend on the model remembering the footer.
  const title = (prTitle || "").trim() || `${issue.title} (#${issue.number})`;
  let body = (prBody || "").trim() || `${summary || ""}\n\nCloses #${issue.number}`;
  if (!new RegExp(`closes #${issue.number}\\b`, "i").test(body)) {
    body += `\n\nCloses #${issue.number}`;
  }
  const pr = await execImpl("gh", [
    "pr",
    "create",
    "--repo",
    repoSlug,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
  ]);
  if (pr.code !== 0) {
    const recovered = await findExistingPr();
    if (recovered && !recovered.error) return recovered;
    return { error: (pr.stderr || recovered?.error || "gh pr create failed").trim().slice(0, 300) };
  }

  const url = (pr.stdout.match(/https?:\/\/\S+/) || [])[0] || pr.stdout.trim();
  const prNumber = lastPrNumber(pr.stdout);
  return { prNumber, url };
}

// ── label transitions (docs/architecture.md label vocabulary) ──────────────────────────────

export function dispatchLabelTransitions() {
  return { add: [LABELS.IMPLEMENTING], remove: [LABELS.READY] };
}

export function prOpenedLabelTransitions() {
  // Defensive reconciliation: a cancelled overlapping dispatch may have
  // restored ready before this serialized finalizer owns the next transition.
  return { add: [LABELS.PR_OPEN], remove: [LABELS.IMPLEMENTING, LABELS.READY] };
}

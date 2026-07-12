// The hub — Hermes v2 orchestration (bot as hub, GitHub as ledger).
//
// One long-lived object inside the bot process that owns every Hermes v2 flow:
// the ratification relay (ask-server → question cards → answers back), session
// launch/finalize for every role, the REST+ETag poll watcher, autopilot, the
// finisher pipeline, /file and the read-only issue chat. Durable state lives on
// the GitHub issue (ledger comments + labels); everything here is rebuildable.
//
// Dependency-injected (deps param) the same way lib/coding/wizard.mjs is, so
// tests drive it without Telegram, GitHub, or real processes.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { ROOT, writeJsonAtomic } from "./paperclip.mjs";
import { MODELS, isModelAlias } from "./models.mjs";
import * as gh from "./gh.mjs";
import * as ledger from "./ledger.mjs";
import * as questions from "./questions.mjs";
import * as sessions from "./sessions.mjs";
import * as engines from "./engines.mjs";
import * as gates from "./gates.mjs";
import * as inbox from "./inbox.mjs";
import * as griller from "./griller.mjs";
import * as dispatch from "./dispatch.mjs";
import * as finisher from "./finisher.mjs";
import * as autopilot from "./autopilot.mjs";
import * as filing from "./filing.mjs";
import * as ops from "./ops.mjs";
import * as callbackTokens from "./callback-tokens.mjs";
import { LABELS } from "./labels.mjs";
import { createAskServer } from "./ask-server.mjs";
import { chunk } from "./telegram.mjs";
import { exec as procExec } from "./proc.mjs";

export const INBOX_FILE = path.join(ROOT, "state", "hermes-inbox.json");
export const ETAGS_FILE = path.join(ROOT, "state", "hermes-etags.json");
export const FINISHER_FILE = path.join(ROOT, "state", "hermes-finisher.json");
export const PLANS_FILE = path.join(ROOT, "state", "hermes-plans.json");
export const ASK_SOCK = path.join(ROOT, "state", "hermes-ask.sock");
export const MCP_SCRIPT = path.join(ROOT, "hermes-ask-mcp.mjs");
export const GITHUB_READ_MCP_SCRIPT = path.join(ROOT, "hermes-github-read-mcp.mjs");
export const FINISHER_WORKTREE_PREFIX = "hermes-wt-hermes-fin-";
export const SIM_ARTIFACTS_DIR = "sim-artifacts";

const issueKey = (repoKey, issue) => `${repoKey}#${issue}`;
const MS_PER_DAY = 86_400_000;
export const ISSUE_CACHE_MAX_AGE_MS = 15 * 60_000;
export const FINISHER_CALLBACK_TTL_MS = 24 * 60 * 60_000;
export const FILE_DRAFT_TTL_MS = 30 * 60_000;

const DISPATCH_CONFLICT_LABELS = new Set([
  LABELS.NEEDS_GRILL, LABELS.GRILLING, LABELS.WAITING_INPUT, LABELS.IMPLEMENTING,
  LABELS.PR_OPEN, LABELS.FINISHING, LABELS.BLOCKED, LABELS.SUPERSEDED,
]);

function loadJson(file, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (v && typeof v === "object") return v;
  } catch { /* fresh */ }
  return fallback;
}

function retentionCutoffMs(cfg, now) {
  const days = cfg.coding?.worktreeRetentionDays || 7;
  return now().getTime() - days * MS_PER_DAY;
}

function protectedFinisherRefs({ fins, sessData }) {
  const worktrees = new Set();
  const branches = new Set();
  let hasUnmappedActiveState = false;
  const protect = (rec) => {
    if (rec?.worktree) worktrees.add(path.resolve(rec.worktree));
    if (rec?.branch) branches.add(rec.branch);
  };

  for (const state of Object.values(fins || {})) {
    if (!state || ["done", "parked"].includes(state.stage)) continue;
    protect(state);
    if (!state.worktree && !state.branch) hasUnmappedActiveState = true;
  }
  for (const rec of sessData?.sessions || []) {
    if (!["auditor", "fixer", "resolver"].includes(rec.role)) continue;
    if (["done", "failed"].includes(rec.status)) continue;
    protect(rec);
  }
  return { worktrees, branches, hasUnmappedActiveState };
}

function parseWorktreeBlocks(text) {
  return String(text || "").split("\n\n").map((block) => {
    const wt = block.match(/^worktree (.+)$/m)?.[1];
    const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] || null;
    return wt ? { worktree: wt, branch } : null;
  }).filter(Boolean);
}

export async function reapHubDiskRetention({
  cfg, stateDir = path.join(ROOT, "state"), now = () => new Date(), exec = procExec,
} = {}) {
  const cutoff = retentionCutoffMs(cfg || {}, now);
  const result = { worktrees: 0, simArtifacts: 0 };

  const base = cfg?.coding?.worktreeBase;
  const repos = cfg?.hermes?.repos || {};
  if (base) {
    let baseReal;
    try { baseReal = fs.realpathSync(base); } catch { baseReal = base; }
    const fins = loadJson(path.join(stateDir, "hermes-finisher.json"), {});
    const sessData = sessions.loadSessions({ file: path.join(stateDir, "hermes-sessions.json") });
    const protectedRefs = protectedFinisherRefs({ fins, sessData });

    for (const repo of Object.values(repos)) {
      if (!repo?.path) continue;
      await exec("git", ["-C", repo.path, "worktree", "prune"]).catch(() => null);
      const listed = await exec("git", ["-C", repo.path, "worktree", "list", "--porcelain"]).catch(() => null);
      if (listed?.code !== 0) continue;
      for (const item of parseWorktreeBlocks(listed.stdout)) {
        const name = path.basename(item.worktree);
        if (!name.startsWith(FINISHER_WORKTREE_PREFIX)) continue;
        if (protectedRefs.hasUnmappedActiveState) continue;
        if (protectedRefs.worktrees.has(path.resolve(item.worktree))) continue;
        if (item.branch && protectedRefs.branches.has(item.branch)) continue;
        let parentReal;
        try { parentReal = fs.realpathSync(path.dirname(item.worktree)); } catch { continue; }
        if (parentReal !== baseReal) continue;
        let mtimeMs;
        try { mtimeMs = fs.statSync(item.worktree).mtimeMs; } catch { continue; }
        if (mtimeMs > cutoff) continue;
        const removed = await exec("git", ["-C", repo.path, "worktree", "remove", item.worktree]).catch(() => null);
        if (removed?.code === 0) result.worktrees += 1;
      }
    }
  }

  const simDir = path.join(stateDir, SIM_ARTIFACTS_DIR);
  try {
    for (const entry of fs.readdirSync(simDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(simDir, entry.name);
      let mtimeMs;
      try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { continue; }
      if (mtimeMs > cutoff) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      result.simArtifacts += 1;
    }
  } catch { /* no simulator artifacts yet */ }

  return result;
}

export function createHermesHub({ cfg, telegram, chatId, log = console.error, deps = {}, stateDir, sockPath } = {}) {
  const H = cfg.hermes;
  const TIER_JOBS = Object.freeze(["digest", "prose", "grilling", "audit"]);
  const { tg, kbd, sendKbd, editMsg, answerCallback } = telegram;

  // Every state file is scoped to stateDir so tests never touch live state/.
  const SD = stateDir || path.join(ROOT, "state");
  const SF = {
    questions: path.join(SD, "hermes-questions.json"),
    sessions: path.join(SD, "hermes-sessions.json"),
    autopilot: path.join(SD, "hermes-autopilot.json"),
    inbox: path.join(SD, "hermes-inbox.json"),
    etags: path.join(SD, "hermes-etags.json"),
    finisher: path.join(SD, "hermes-finisher.json"),
    plans: path.join(SD, "hermes-plans.json"),
    crashes: path.join(SD, "hermes-crashes.json"),
    prefs: path.join(SD, "hermes-hub-prefs.json"),
  };
  const hubSock = sockPath || path.join(SD, "hermes-ask.sock");
  const loadQ = () => questions.loadQuestions({ file: SF.questions });
  const saveQ = (data) => questions.saveQuestions(data, { file: SF.questions });
  const loadS = () => sessions.loadSessions({ file: SF.sessions });
  const saveS = (data) => sessions.saveSessions(data, { file: SF.sessions });
  const d = {
    gh, sessions, gates, callbackTokens, execFile, exec: procExec, reapHubDiskRetention,
    createDispatchWorktree: dispatch.createWorktree,
    warmDispatchWorktree: dispatch.warmWorktree,
    commitDispatchWorktree: dispatch.commitWorktree,
    pushDispatchPr: dispatch.pushAndOpenPr,
    launchSession: sessions.launchSession,
    gatherGateInputs: gates.gatherGateInputs,
    now: () => new Date(),
    ...deps,
  };

  // Coalesced ledger editor (ADR-0002): all routine ledger writes flow through
  // this; only the record-before-relay write on a new question is immediate.
  const ledgerEditor = gh.createCoalescedEditor({
    minIntervalMs: 7000,
    // schedule() fires this without awaiting — an uncaught network rejection here
    // is an unhandledRejection that kills the whole bot (observed live: HTTP/2
    // GOAWAY → process death). Ledger edits are retried on the next state change
    // anyway, so log-and-drop is correct.
    editImpl: ({ slug, commentId, body }) =>
      d.gh.editComment({ slug, commentId, body }).catch((e) => log(`[hub] ledger edit failed (will retry on next change): ${e.message}`)),
  });

  // In-memory mirrors of the per-session ledger objects, keyed by session id.
  // Rebuildable from GitHub (parseLedger) — this is just the write-side cache.
  const ledgers = new Map();
  // Dispatch reservations are process-visible and cover preparation through
  // session persistence. Finalizers synchronously cancel a reservation before
  // waiting on the shared per-issue finisher queue.
  const dispatchReservations = new Map();
  const finalizationPending = new Map();
  let askServer = null;
  let pollTimer = null;
  let stopped = false;

  const repoOf = (repoKey) => H.repos[repoKey];
  const slugOf = (repoKey) => repoOf(repoKey)?.slug;

  // Hub prefs (tiers overrides, default engine, awaiting-answer state) live in
  // their OWN file — never in the concierge's hermes-prefs.json, so hub writes
  // can't race the wizard/act state machines that share that file.
  function prefsHermes() { return loadJson(SF.prefs, {}); }
  function patchPrefsHermes(patch) {
    writeJsonAtomic(SF.prefs, { ...prefsHermes(), ...patch });
  }
  const isSupportedModel = isModelAlias;
  const isSupportedEngine = engines.isSupportedEngine;
  const tierModel = (job) => {
    const preferred = prefsHermes().tiers?.[job];
    if (isSupportedModel(preferred)) return preferred;
    return isSupportedModel(H.tiers[job]) ? H.tiers[job] : "sonnet";
  };
  const defaultEngine = () => {
    const preferred = prefsHermes().defaultEngine;
    if (isSupportedEngine(preferred)) return preferred;
    return isSupportedEngine(H.defaultEngine) ? H.defaultEngine : "codex";
  };
  const planEngine = (plan) => {
    if (plan?.engine == null) return defaultEngine();
    if (!isSupportedEngine(plan.engine)) throw new Error(`Unsupported stored plan engine: ${plan.engine}`);
    return plan.engine;
  };
  const isWriteRole = (role) => ["implementer", "fixer", "resolver"].includes(role);
  const assertLaunchAllowed = (role, engine) => {
    if (!isSupportedEngine(engine)) throw new Error(`Unsupported engine: ${engine}`);
    if (isWriteRole(role) && engine === "claude" && !H.allowClaudeWriteSessions) {
      throw new Error("Claude write sessions are disabled; set hermes.allowClaudeWriteSessions=true only on a trusted host.");
    }
  };

  async function send(text, { silent = true, rows = null } = {}) {
    const body = { chat_id: chatId, text, disable_notification: silent };
    if (rows) body.reply_markup = kbd(rows);
    const r = await tg("sendMessage", body);
    return r?.ok ? r.result.message_id : null;
  }

  async function sendIssueStatus(key, text, { silent = true } = {}) {
    const state = loadJson(SF.inbox, {});
    const statusMessages = { ...(state.statusMessages || {}) };
    const existing = statusMessages[key];
    if (existing) {
      const edited = await editMsg(chatId, existing, text).catch(() => null);
      if (edited !== null) return existing;
    }
    const msgId = await send(text, { silent });
    if (msgId) {
      writeJsonAtomic(SF.inbox, {
        ...state,
        statusMessages: { ...statusMessages, [key]: msgId },
      });
    }
    return msgId;
  }

  const sendCommandStatus = (key, text, opts = {}) => sendIssueStatus(`command:${key}`, text, opts);
  const sendHealthStatus = (key, text, opts = {}) => sendIssueStatus(`health:${key}`, text, opts);

  // ── ledger plumbing ────────────────────────────────────────────────────────

  async function createLedgerFor(record) {
    const led = ledger.emptyLedger({ sessionId: record.id, role: record.role, engine: record.engine });
    const withMeta = { ...led, worktree: record.worktree, branch: record.branch, engineSessionId: record.engineSessionId };
    ledgers.set(record.id, withMeta);
    const slug = slugOf(record.repoKey);
    if (!slug || !record.issue) return null;
    const res = await d.gh.createComment({ slug, issue: record.issue, body: ledger.renderLedger(withMeta) });
    return res?.id ?? null;
  }

  function ledgerOf(record) {
    if (!ledgers.has(record.id)) {
      ledgers.set(record.id, {
        ...ledger.emptyLedger({ sessionId: record.id, role: record.role, engine: record.engine }),
        worktree: record.worktree, branch: record.branch, engineSessionId: record.engineSessionId,
      });
    }
    return ledgers.get(record.id);
  }

  async function writeLedger(record, mutate, { immediate = false } = {}) {
    const next = mutate(ledgerOf(record));
    ledgers.set(record.id, next);
    const slug = slugOf(record.repoKey);
    if (!slug || !record.ledgerCommentId) return;
    const body = ledger.renderLedger(next);
    if (immediate) await d.gh.editComment({ slug, commentId: record.ledgerCommentId, body });
    else ledgerEditor.schedule({ slug, commentId: record.ledgerCommentId, body });
  }

  // ── inbox + question cards ─────────────────────────────────────────────────

  async function refreshInbox() {
    const qs = questions.pendingQuestions(loadQ());
    const state = loadJson(SF.inbox, {});
    const decisions = inbox.finisherInboxItems(loadJson(SF.finisher, {}));
    const text = inbox.renderInbox(qs, d.now(), decisions);
    if (state.pinnedMessageId) {
      await editMsg(chatId, state.pinnedMessageId, text).catch(() => {});
      return;
    }
    const msgId = await send(text);
    if (msgId) {
      // Pin exactly once; edits keep it fresh forever. disable_notification on
      // the pin itself (private-chat pins are silent anyway, belt & braces).
      await tg("pinChatMessage", { chat_id: chatId, message_id: msgId, disable_notification: true }).catch(() => {});
      writeJsonAtomic(SF.inbox, { ...state, pinnedMessageId: msgId });
    }
  }

  // The relay, phone-bound half: persist → ledger (immediate) → card → inbox.
  // The persist-before-relay order is ADR-0001's crash-recovery contract.
  async function onAsk({ sessionKey, question, recommended, context }) {
    let sessData = loadS();
    const record = sessions.getSession(sessData, sessionKey);
    if (!record) throw new Error(`unknown session ${sessionKey}`);

    // Harvest the codex thread_id if we don't have it yet — it MUST be in the
    // ledger before the question reaches the phone, or a bot crash strands the
    // session with no resume handle.
    if (!record.engineSessionId) {
      const meta = sessions.sessionOutputMeta(record);
      if (meta.engineSessionId) {
        sessData = sessions.patchSession(sessData, record.id, { engineSessionId: meta.engineSessionId });
        saveS(sessData);
        record.engineSessionId = meta.engineSessionId;
      }
    }

    const before = questions.pendingQuestions(loadQ()).length;
    const q = questions.newQuestion({
      sessionId: record.id, repoKey: record.repoKey, issue: record.issue,
      question, recommended, context, now: d.now(),
    });
    let qData = questions.addQuestion(loadQ(), q);
    saveQ(qData);

    await writeLedger(record, (led) => ledger.setStatus(
      ledger.appendQuestion({ ...led, engineSessionId: record.engineSessionId, worktree: record.worktree },
        { id: q.id, askedAt: q.askedAt, question: q.question }),
      "waiting-input",
    ), { immediate: true });

    const slug = slugOf(record.repoKey);
    if (slug && record.issue) await d.gh.addLabels({ slug, issue: record.issue, labels: [LABELS.WAITING_INPUT] });

    // Notify only on 0→1; every later question arrives silently (inbox design).
    const msgId = await send(inbox.questionCardText(q), { silent: before > 0, rows: inbox.questionCardKbd(q) });
    if (msgId) {
      qData = questions.setTgMessageId(loadQ(), q.id, msgId);
      saveQ(qData);
    }
    await refreshInbox();
    return { id: q.id };
  }

  function getAnswer(id, principal) {
    const q = questions.getQuestion(loadQ(), id);
    if (!q) return null;
    if (principal && q.sessionId !== principal.sessionId) return null;
    return q.status === "answered" ? { status: "answered", answer: q.answer } : { status: "pending" };
  }

  function tokenMatches(left, right) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function authenticateAskRequest({ askToken, sessionKey } = {}) {
    const sessData = loadS();
    const record = sessData.sessions.find((candidate) => tokenMatches(candidate.askToken, askToken));
    if (!record || (sessionKey && record.id !== sessionKey)) return null;
    return { sessionId: record.id };
  }

  async function deliverAnswer(qId, answerText) {
    let qData = loadQ();
    const q = questions.getQuestion(qData, qId);
    if (!q || q.status !== "pending") return false;
    qData = questions.setAnswer(qData, qId, answerText, d.now());
    saveQ(qData);

    const sessData = loadS();
    const record = sessions.getSession(sessData, q.sessionId);
    if (record) {
      await writeLedger(record, (led) => {
        const answered = ledger.answerQuestion(led, qId, answerText, d.now().toISOString());
        return record.status === "running" ? ledger.setStatus(answered, "running") : answered;
      });
      // Orphaned session (died while blocked): resume it from the recorded
      // worktree with the answer — ADR-0001's fallback path.
      if (record.status === "orphaned") await resumeWithAnswer(record, answerText);
    }

    // waiting-input comes off only when nothing else pends on that issue.
    const stillPending = questions.pendingQuestions(loadQ())
      .some((p) => p.repoKey === q.repoKey && p.issue === q.issue);
    const slug = slugOf(q.repoKey);
    if (!stillPending && slug && q.issue) {
      await d.gh.removeLabel({ slug, issue: q.issue, label: LABELS.WAITING_INPUT });
    }

    if (q.tgMessageId) {
      await editMsg(chatId, q.tgMessageId, `${inbox.questionCardText(q)}\n\n✅ Answered: ${answerText}`).catch(() => {});
    }
    await refreshInbox();
    return true;
  }

  async function resumeWithAnswer(record, answerText) {
    const prompt = `Owner answered your ask_owner question: "${answerText}". Continue from your ledger handoff.`;
    await respawn(record, { resume: true, prompt });
  }

  // ── session spawning ───────────────────────────────────────────────────────

  function sessionEnv(record) {
    return engines.buildChildSessionEnv(process.env, { askToken: record?.askToken });
  }

  function ensurePersistedAskToken(record) {
    let data = loadS();
    let inserted = false;
    if (!sessions.getSession(data, record.id)) {
      data = sessions.upsertSession(data, record);
      inserted = true;
    }
    const ensured = sessions.ensureAskTokens(data);
    if (ensured.changed || inserted) saveS(ensured.data);
    return sessions.getSession(ensured.data, record.id);
  }

  function configuredRepoSlugs() {
    return [...new Set(Object.values(H.repos || {}).map((repo) => repo?.slug).filter(Boolean))];
  }

  function githubReadMcp() {
    return { mcpScriptPath: GITHUB_READ_MCP_SCRIPT, allowedRepos: configuredRepoSlugs() };
  }

  function sessionFiles(id) {
    const dir = path.join(sessions.SESSION_LOG_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    return {
      dir,
      outFile: path.join(dir, "out.jsonl"),
      errFile: path.join(dir, "err.log"),
      lastMessageFile: path.join(dir, "last-message.txt"),
    };
  }

  function buildArgsFor(record, { prompt, resume = false, model, effort, allowedTools, permissionMode, sandbox }) {
    assertLaunchAllowed(record.role, record.engine);
    const files = { outFile: record.outFile, lastMessageFile: record.lastMessageFile };
    const askTimeoutMs = H.askTimeoutHours * 3600 * 1000;
    if (record.engine === "codex") {
      return {
        bin: H.codexBin,
        args: engines.buildCodexArgs({
          prompt, worktree: record.worktree, lastMessageFile: files.lastMessageFile,
          sessionKey: record.id, sockPath: hubSock, askTimeoutMs, mcpScriptPath: MCP_SCRIPT,
          resume, threadId: record.engineSessionId,
          sandbox: sandbox || (record.role === "auditor" ? "read-only" : "workspace-write"),
        }),
      };
    }
    const repoScopedReadRole = record.role === "griller" || record.role === "auditor";
    const mcpConfigPath = engines.writeSessionMcpConfig({
      dir: path.dirname(record.outFile), sessionKey: record.id, sockPath: hubSock,
      askTimeoutMs, mcpScriptPath: MCP_SCRIPT,
      githubRead: repoScopedReadRole ? githubReadMcp() : undefined,
    });
    return {
      bin: cfg.claudeBin || "claude",
      args: engines.buildClaudeArgs({
        prompt, model, effort, sessionId: record.engineSessionId, resume,
        allowedTools, mcpConfigPath, permissionMode,
      }),
    };
  }

  async function launch({
    role, engine, repoKey, issue, worktree, branch, prompt, model, effort,
    allowedTools, permissionMode, meta = {}, beforeSessionPersist,
  }) {
    assertLaunchAllowed(role, engine);
    const record = {
      ...sessions.newSessionRecord({ role, engine, repoKey, issue, worktree, branch, now: d.now() }),
      ...meta,
    };
    Object.assign(record, sessionFiles(record.id));
    record.lastPrompt = prompt; // persisted so a silent-failure retry can re-issue it
    if (engine === "claude") record.engineSessionId = randomUUID(); // minted upfront → resumable from birth
    const commentId = await createLedgerFor(record);
    if (commentId) record.ledgerCommentId = commentId;
    const { bin, args } = buildArgsFor(record, { prompt, model, effort, allowedTools, permissionMode });
    if (beforeSessionPersist) beforeSessionPersist();
    const { record: live, child } = d.launchSession(
      { record, bin, args, cwd: worktree || repoOf(repoKey)?.path || ROOT, env: sessionEnv(record) },
      { file: SF.sessions },
    );
    record.pid = live?.pid;
    child.on("exit", (code) => { finalize(record.id, code).catch((e) => log(`[hub] finalize ${record.id}: ${e.message}`)); });
    return record;
  }

  async function respawn(record, { resume, prompt, wrapScript = false }) {
    record = ensurePersistedAskToken(record);
    // Records recovered from disk can predate their log files (or lose them to a
    // cleanup) — (re)assign session files so buildArgsFor always has real paths.
    if (!record.outFile) Object.assign(record, sessionFiles(record.id));
    const plan = loadJson(SF.plans, {})[issueKey(record.repoKey, record.issue)] || {};
    const built = buildArgsFor(record, {
      prompt, resume,
      model: record.engine === "claude" ? (plan.model || tierModel("grilling")) : undefined,
      effort: plan.effort || "high",
      allowedTools: record.role === "griller" ? engines.GRILLER_ALLOWED_TOOLS
        : record.role === "auditor" ? engines.AUDITOR_ALLOWED_TOOLS : undefined,
      permissionMode: ["implementer", "fixer", "resolver"].includes(record.role) && record.engine === "claude" ? "bypass" : undefined,
    });
    const args = wrapScript ? engines.wrapWithScript(built.args) : built.args;
    const bin = wrapScript ? "script" : built.bin;
    const { child } = d.launchSession(
      { record: { ...record, status: "running" }, bin, args: wrapScript ? args.slice(1) : args, cwd: record.worktree || repoOf(record.repoKey)?.path || ROOT, env: sessionEnv(record) },
      { file: SF.sessions },
    );
    child.on("exit", (code) => { finalize(record.id, code).catch((e) => log(`[hub] finalize ${record.id}: ${e.message}`)); });
  }

  // ── role launchers ─────────────────────────────────────────────────────────

  async function launchGriller(repoKey, issue) {
    const slug = slugOf(repoKey);
    const prompt = griller.buildGrillerPrompt({ issue, repoSlug: slug, handoffNotes: [] });
    await d.gh.addLabels({ slug, issue: issue.number, labels: [LABELS.GRILLING] });
    const rec = await launch({
      role: "griller", engine: "claude", repoKey, issue: issue.number,
      prompt, model: tierModel("grilling"), effort: "high",
      allowedTools: engines.GRILLER_ALLOWED_TOOLS,
    });
    await sendIssueStatus(issueKey(repoKey, issue.number), `🔍 Grilling started: ${repoKey}#${issue.number} — ${issue.title}`);
    return rec;
  }

  function dispatchStateConflict(repoKey, issue) {
    const key = issueKey(repoKey, issue);
    const activeFinisher = loadJson(SF.finisher, {})[key];
    if (activeFinisher && !["done", "parked"].includes(activeFinisher.stage)) {
      return `active local finisher exists for ${key} at stage ${activeFinisher.stage}`;
    }
    if (sessions.runningSessions(loadS()).some((s) => s.repoKey === repoKey && s.issue === issue)) {
      return `${key} already has a session in flight`;
    }
    return null;
  }

  function acquireDispatchReservation(key) {
    if (dispatchReservations.has(key)) throw new Error(`dispatch reservation already active for ${key}`);
    if ((finalizationPending.get(key) || 0) > 0) throw new Error(`finalization reservation already active for ${key}`);
    const reservation = { key, cancelled: false };
    dispatchReservations.set(key, reservation);
    return reservation;
  }

  function releaseDispatchReservation(reservation) {
    if (dispatchReservations.get(reservation.key) === reservation) dispatchReservations.delete(reservation.key);
  }

  function beginIssueFinalization(key) {
    finalizationPending.set(key, (finalizationPending.get(key) || 0) + 1);
    const reservation = dispatchReservations.get(key);
    if (reservation) reservation.cancelled = true;
  }

  function endIssueFinalization(key) {
    const remaining = (finalizationPending.get(key) || 1) - 1;
    if (remaining > 0) finalizationPending.set(key, remaining);
    else finalizationPending.delete(key);
  }

  async function withIssueFinalization(record, work) {
    const key = issueKey(record.repoKey, record.issue);
    beginIssueFinalization(key);
    try {
      return await withFinisherSerialization(key, work);
    } finally {
      endIssueFinalization(key);
    }
  }

  function assertDispatchReservation(reservation, repoKey, issue) {
    if (dispatchReservations.get(reservation.key) !== reservation || reservation.cancelled
      || (finalizationPending.get(reservation.key) || 0) > 0) {
      throw new Error(`dispatch reservation cancelled for ${reservation.key}`);
    }
    const conflict = dispatchStateConflict(repoKey, issue);
    if (conflict) throw new Error(conflict);
  }

  async function rollbackDispatchLabels({ slug, issue }) {
    const retry = async (description, operation) => {
      let lastError;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await operation();
          return;
        } catch (error) {
          lastError = error;
          log(`[hub] dispatch label rollback ${description} attempt ${attempt} failed on #${issue}: ${error.message}`);
        }
      }
      throw lastError;
    };
    const results = await Promise.allSettled([
      retry("restore ready", () => d.gh.addLabels({ slug, issue, labels: [LABELS.READY] })),
      retry("remove implementing", () => d.gh.removeLabel({ slug, issue, label: LABELS.IMPLEMENTING })),
    ]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
      throw new AggregateError(failures.map((result) => result.reason), `dispatch label rollback incomplete for #${issue}`);
    }
  }

  function failPartiallyPersistedDispatchSessions({ repoKey, issue, worktree, branch, existingIds }) {
    let data = loadS();
    let changed = false;
    data = {
      ...data,
      sessions: data.sessions.map((record) => {
        if (existingIds.has(record.id) || record.status !== "running"
          || record.repoKey !== repoKey || record.issue !== issue
          || record.worktree !== worktree || record.branch !== branch) return record;
        changed = true;
        return { ...record, status: "failed", endedAt: d.now().toISOString() };
      }),
    };
    if (changed) saveS(data);
  }

  async function cleanupUnusedDispatchWorktree({ repoPath, worktree, branch }) {
    if (typeof d.cleanupDispatchWorktree === "function") {
      return d.cleanupDispatchWorktree({ repoPath, worktree, branch });
    }
    let removed = await d.exec("git", ["-C", repoPath, "worktree", "remove", worktree]);
    if (removed.code !== 0) {
      log(`[hub] unused dispatch worktree cleanup retrying with --force for ${worktree}: ${removed.stderr || removed.code}`);
      removed = await d.exec("git", ["-C", repoPath, "worktree", "remove", "--force", worktree]);
    }
    if (removed.code !== 0) {
      log(`[hub] unused dispatch worktree cleanup failed for ${worktree}: ${removed.stderr || removed.code}`);
    }
    const deleted = await d.exec("git", ["-C", repoPath, "branch", "-D", branch]);
    if (deleted.code !== 0) log(`[hub] unused dispatch branch cleanup failed for ${branch}: ${deleted.stderr || deleted.code}`);
    return { removed: removed.code === 0, branchDeleted: deleted.code === 0 };
  }

  async function launchImplementer(repoKey, issue, plan) {
    const key = issueKey(repoKey, issue.number);
    const reservation = acquireDispatchReservation(key);
    const existingIds = new Set(loadS().sessions.map((record) => record.id));
    const repo = repoOf(repoKey);
    const { branch, dirName } = dispatch.worktreeBranchFor({ repoKey, issue });
    let worktree = null;
    let labelsMayHaveChanged = false;
    let launched = false;
    let engine;
    let rec;
    try {
      const initialConflict = dispatchStateConflict(repoKey, issue.number);
      if (initialConflict) throw new Error(initialConflict);
      engine = planEngine(plan);
      assertLaunchAllowed("implementer", engine);
      ({ worktree } = await d.createDispatchWorktree({
        repoPath: repo.path, worktreeBase: cfg.coding?.worktreeBase || ROOT, branch, dirName,
      }));
      const warm = await d.warmDispatchWorktree({ repoPath: repo.path, worktree });
      if (!warm.warmed) await sendIssueStatus(key, `⚠️ ${key}: worktree deps not warmed (${warm.reason}) — the session may be unable to run tests; CI remains the net.`);
      const prompt = dispatch.buildImplementerPrompt({
        issue, repoSlug: repo.slug,
        decisions: plan.decisions || [], assumptions: plan.assumptions || [], handoffNote: plan.handoffNote || "",
      });
      rec = await withFinisherSerialization(key, async () => {
        try {
          assertDispatchReservation(reservation, repoKey, issue.number);
          const t = dispatch.dispatchLabelTransitions();
          labelsMayHaveChanged = true;
          await d.gh.addLabels({ slug: repo.slug, issue: issue.number, labels: t.add });
          assertDispatchReservation(reservation, repoKey, issue.number);
          for (const label of t.remove) {
            await d.gh.removeLabel({ slug: repo.slug, issue: issue.number, label });
            assertDispatchReservation(reservation, repoKey, issue.number);
          }
          return await launch({
            role: "implementer", engine, repoKey, issue: issue.number,
            worktree, branch, prompt,
            model: engine === "claude" ? tierModel("grilling") : undefined,
            effort: plan.effort, permissionMode: engine === "claude" ? "bypass" : undefined,
            beforeSessionPersist: () => assertDispatchReservation(reservation, repoKey, issue.number),
          });
        } catch (error) {
          // Keep failure reconciliation inside the same issue boundary. A queued
          // finalizer must not observe a fake running record or race these labels.
          failPartiallyPersistedDispatchSessions({ repoKey, issue: issue.number, worktree, branch, existingIds });
          if (labelsMayHaveChanged) {
            try {
              await rollbackDispatchLabels({ slug: repo.slug, issue: issue.number });
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], `${error.message}; lifecycle-label rollback also failed`);
            }
          }
          throw error;
        }
      });
      launched = true;
    } catch (error) {
      if (!launched) {
        if (worktree) await cleanupUnusedDispatchWorktree({ repoPath: repo.path, worktree, branch });
      }
      throw error;
    } finally {
      releaseDispatchReservation(reservation);
    }
    await sendIssueStatus(key, `🛠 Dispatched ${key} → ${engine} (${plan.effort})`)
      .catch((error) => log(`[hub] dispatch status failed for ${key}: ${error.message}`));
    return rec;
  }

  // ── finalize by role ───────────────────────────────────────────────────────

  async function finalize(sessionId, exitCode) {
    let data = loadS();
    const record = sessions.getSession(data, sessionId);
    if (!record || record.status !== "running") return; // already reconciled

    // codex no-TTY bug #19945: empty-output-exit-0 is a failure; retry ONCE
    // through the BSD `script` pty wrapper before giving up.
    if (sessions.detectSilentCodexFailure(record, exitCode) && !record.scriptRetried) {
      log(`[hub] ${sessionId}: silent codex failure — retrying under script(1)`);
      data = sessions.patchSession(data, sessionId, { scriptRetried: true });
      saveS(data);
      await respawn({ ...record, scriptRetried: true }, { resume: false, prompt: record.lastPrompt || "", wrapScript: true });
      return;
    }

    const meta = sessions.sessionOutputMeta(record);
    const ok = exitCode === 0 && !meta.failed;
    const complete = async () => {
      const currentData = loadS();
      if (sessions.getSession(currentData, sessionId)?.status !== "running") return;
      data = sessions.patchSession(currentData, sessionId, {
        status: ok ? "done" : "failed",
        endedAt: d.now().toISOString(),
        engineSessionId: meta.engineSessionId || record.engineSessionId,
      });
      saveS(data);
      const done = { ...record, engineSessionId: meta.engineSessionId || record.engineSessionId };
      if (record.role === "griller") await finalizeGriller(done, meta, ok);
      else if (record.role === "implementer") await finalizeImplementerLocked(done, meta, ok);
      else if (record.role === "auditor") await finalizeAuditorLocked(done, meta);
      else if (record.role === "fixer" || record.role === "resolver") await finalizeFinisherWorkerLocked(done, meta, ok);
    };
    try {
      if (["implementer", "auditor", "fixer", "resolver"].includes(record.role)) {
        await withIssueFinalization(record, complete);
      } else {
        await complete();
      }
    } finally {
      await ledgerEditor.flush().catch(() => {});
    }
  }

  async function finalizeGriller(record, meta, ok) {
    const slug = slugOf(record.repoKey);
    const result = ok ? griller.parseGrillerResult(meta.lastText) : null;
    if (!result) {
      await writeLedger(record, (led) => ledger.setStatus(ledger.setOutcome(led, `Grilling session failed (exit without a parseable result).`), "failed"));
      await sendIssueStatus(issueKey(record.repoKey, record.issue), `⚠️ Grilling failed on ${record.repoKey}#${record.issue} — will need a re-run.`, { silent: false });
      return;
    }
    const plans = loadJson(SF.plans, {});
    plans[issueKey(record.repoKey, record.issue)] = {
      engine: result.engine, effort: result.effort,
      decisions: result.decisions, assumptions: result.assumptions, handoffNote: result.handoffNote,
    };
    writeJsonAtomic(SF.plans, plans);

    const t = griller.grillerLabelTransitions(result);
    await d.gh.addLabels({ slug, issue: record.issue, labels: t.add });
    for (const l of t.remove) await d.gh.removeLabel({ slug, issue: record.issue, label: l });

    await writeLedger(record, (led) => {
      let next = led;
      for (const dec of result.decisions) next = ledger.addDecision(next, dec);
      for (const a of result.assumptions) next = ledger.addAssumption(next, a);
      next = ledger.setHandoffNote(next, result.handoffNote || "");
      next = ledger.setOutcome(next, result.ready ? `Ready — engine ${result.engine}, effort ${result.effort}.` : `Blocked: ${result.blockedReason || "unspecified"}`);
      return ledger.setStatus(next, result.ready ? "done" : "blocked");
    });
    const key = issueKey(record.repoKey, record.issue);
    if (result.ready) {
      await sendIssueStatus(
        key,
        `✅ Grilled ${record.repoKey}#${record.issue} → ready (${result.engine}/${result.effort}).${autopilotEnabled() ? " Autopilot will pick it up." : ""}`,
        { silent: false },
      );
    } else {
      await sendIssueStatus(key, `⛔ Grilling parked ${record.repoKey}#${record.issue}: ${result.blockedReason || "see ledger"}`, { silent: false });
    }
  }

  function proposalNotice(record, result) {
    const issueProposals = Array.isArray(result.issueProposals) ? result.issueProposals : [];
    const commentProposals = Array.isArray(result.commentProposals) ? result.commentProposals : [];
    if (!issueProposals.length && !commentProposals.length) return "";

    // This text is informational only: it is written through the existing owner-status/ledger
    // path and is never interpreted as a GitHub mutation. Bound and flatten model text so a
    // malformed proposal cannot turn an owner summary into an unbounded or multi-line payload.
    const inertText = (value, fallback) => {
      if (typeof value !== "string" || !value.trim()) return fallback;
      return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
    };
    const lines = [];
    for (const item of issueProposals.slice(0, 10)) {
      const repoKey = inertText(item?.repoKey, record.repoKey);
      const title = inertText(item?.title, "(untitled issue proposal)");
      const body = inertText(item?.body, "");
      lines.push(`- Issue proposed for ${repoKey} (not filed): ${title}${body ? ` — ${body}` : ""}`);
    }
    for (const item of commentProposals.slice(0, 10)) {
      const repoKey = inertText(item?.repoKey, record.repoKey);
      const issue = Number.isInteger(Number(item?.issue)) && Number(item.issue) > 0 ? Number(item.issue) : record.issue;
      const body = inertText(item?.body, "(empty comment proposal)");
      lines.push(`- Comment proposed for ${repoKey}#${issue} (not posted): ${body}`);
    }
    const omitted = issueProposals.length + commentProposals.length - lines.length;
    if (omitted > 0) lines.push(`- ${omitted} additional proposal${omitted === 1 ? "" : "s"} remain in the session output (not filed or posted).`);
    return `Proposed follow-ups (not filed or posted):\n${lines.join("\n")}`;
  }

  async function finalizeImplementerLocked(record, meta, ok) {
    const slug = slugOf(record.repoKey);
    const result = ok ? dispatch.parseImplementerResult(meta.lastText) : null;
    if (!result || !result.done) {
      const reason = result?.blockedReason || `implementation session ${ok ? "did not report done" : "failed"}`;
      await d.gh.addLabels({ slug, issue: record.issue, labels: [LABELS.BLOCKED] });
      await d.gh.removeLabel({ slug, issue: record.issue, label: LABELS.IMPLEMENTING });
      await writeLedger(record, (led) => ledger.setStatus(ledger.setOutcome(led, `Parked: ${reason}`), "blocked"));
      await sendIssueStatus(issueKey(record.repoKey, record.issue), `⛔ ${record.repoKey}#${record.issue} parked: ${reason}`, { silent: false });
      return;
    }
    // The session cannot commit (worktree gitdir is outside its sandbox) — the hub
    // commits its work first, then pushes and opens the PR.
    const proposals = proposalNotice(record, result);
    const commit = await d.commitDispatchWorktree({
      worktree: record.worktree,
      message: `${(result.summary || `issue #${record.issue}`).split("\n")[0].slice(0, 72)} (#${record.issue})\n\nImplemented by Hermes session ${record.id} (${record.engine}); committed by the hub.`,
    });
    if (!commit.committed) {
      if (commit.reason === "clean") {
        await d.gh.removeLabel({ slug, issue: record.issue, label: LABELS.IMPLEMENTING });
        const outcome = `Completed without code changes.${proposals ? `\n\n${proposals}` : ""}`;
        await writeLedger(record, (led) => ledger.setStatus(ledger.setOutcome(led, outcome), "done"));
        await sendIssueStatus(issueKey(record.repoKey, record.issue), `✅ ${record.repoKey}#${record.issue}: completed without code changes.${proposals ? `\n\n${proposals}` : ""}`, { silent: false });
        return;
      }
      await writeLedger(record, (led) => ledger.setStatus(ledger.setOutcome(led, `Commit failed: ${commit.reason}`), "failed"));
      await sendIssueStatus(issueKey(record.repoKey, record.issue), `⚠️ ${record.repoKey}#${record.issue}: implementation done but commit failed: ${commit.reason}`, { silent: false });
      return;
    }
    const pr = await d.pushDispatchPr({
      worktree: record.worktree, branch: record.branch, repoSlug: slug,
      issue: { number: record.issue, title: result.summary?.slice(0, 60) || `#${record.issue}` },
      summary: result.summary || "",
      prTitle: result.prTitle, prBody: result.prBody, // authored per the repo's PR template
    });
    if (pr.error) {
      await writeLedger(record, (led) => ledger.setStatus(ledger.setOutcome(led, `Push/PR failed: ${pr.error}`), "failed"));
      await sendIssueStatus(issueKey(record.repoKey, record.issue), `⚠️ ${record.repoKey}#${record.issue}: implementation done but push/PR failed: ${pr.error}`, { silent: false });
      return;
    }
    const t = dispatch.prOpenedLabelTransitions();
    await d.gh.addLabels({ slug, issue: record.issue, labels: t.add });
    for (const l of t.remove) await d.gh.removeLabel({ slug, issue: record.issue, label: l });
    await writeLedger(record, (led) => ledger.setStatus(ledger.setOutcome(led, `PR ${pr.url}${proposals ? `\n\n${proposals}` : ""}`), "done"));

    const key = issueKey(record.repoKey, record.issue);
    const fins = loadJson(SF.finisher, {});
    if (fins[key] && !["done", "parked"].includes(fins[key].stage)) {
      log(`[hub] refusing to overwrite active finisher ${key} while finalizing PR #${pr.prNumber}`);
      return;
    }
    fins[key] = {
      ...finisher.newFinisherState({ issue: record.issue, repoKey: record.repoKey, prNumber: pr.prNumber, now: d.now().toISOString() }),
      branch: record.branch || null,
      preMergeAudit: true,
    };
    writeJsonAtomic(SF.finisher, fins);

    await sendIssueStatus(key, `🔀 ${record.repoKey}#${record.issue} → PR #${pr.prNumber}\n${pr.url}\n\nRunning cross-engine audit before the merge card.${proposals ? `\n\n${proposals}` : ""}`);
    await advanceFinisherLocked(key);
  }

  async function finalizeAuditorLocked(record, meta) {
    const verdict = finisher.parseAuditVerdict(meta.lastText) || { verdict: "block", notes: "audit session ended without a verdict" };
    const key = issueKey(record.repoKey, record.issue);
    const fins = loadJson(SF.finisher, {});
    if (!fins[key]) return;
    fins[key] = finisher.applyAuditVerdict(fins[key], { ...verdict, headSha: record.auditHeadSha }); // the whole {verdict, notes} object
    writeJsonAtomic(SF.finisher, fins);
    await advanceFinisherLocked(key);
  }

  async function finalizeFinisherWorkerLocked(record, meta, ok) {
    // The hub commits the fixer/resolver's work (sessions can't — gitdir is outside
    // their sandbox) and pushes (ADR-0003), then re-checks the PR.
    if (ok && record.worktree && record.branch) {
      await dispatch.commitWorktree({
        worktree: record.worktree,
        message: `${record.role} pass for #${record.issue} by Hermes session ${record.id}`,
      });
      await d.exec("git", ["-C", record.worktree, "push", "origin", record.branch]);
      if (record.finisherFixKind === "audit") {
        const key = issueKey(record.repoKey, record.issue);
        const fins = loadJson(SF.finisher, {});
        if (fins[key]) {
          fins[key] = finisher.resetAuditAfterFix(fins[key]);
          writeJsonAtomic(SF.finisher, fins);
        }
      }
    }
    await advanceFinisherLocked(issueKey(record.repoKey, record.issue));
  }

  // ── finisher driving ───────────────────────────────────────────────────────

  const autopilotEnabled = () => autopilot.loadAutopilot({ file: SF.autopilot }).enabled;

  async function refreshIssueCache() {
    const etags = loadJson(SF.etags, {});
    const warnings = [];
    for (const repoKey of Object.keys(H.repos)) {
      const slug = slugOf(repoKey);
      try {
        const res = await d.gh.pollRepoIssues({ slug, etag: etags[repoKey]?.etag });
        if (res?.retryAfterMs) throw new Error(`rate limited; retry after ${res.retryAfterMs}ms`);
        const fetchedAt = d.now().toISOString();
        if (res.changed) etags[repoKey] = { etag: res.etag, issues: res.issues, fetchedAt };
        else etags[repoKey] = {
          etag: res.etag ?? etags[repoKey]?.etag,
          issues: etags[repoKey]?.issues || [],
          fetchedAt,
        };
      } catch (e) {
        warnings.push(`${repoKey}: ${e.message}`);
        etags[repoKey] = {
          ...(etags[repoKey] || { issues: [] }),
          refreshFailedAt: d.now().toISOString(),
          refreshError: e.message,
        };
      }
    }
    writeJsonAtomic(SF.etags, etags);
    return { etags, warnings };
  }

  function issueCacheUsable(entry) {
    const fetchedAt = Date.parse(entry?.fetchedAt);
    const nowMs = d.now().getTime();
    return !!entry && !entry.refreshError && Number.isFinite(fetchedAt)
      && nowMs - fetchedAt <= ISSUE_CACHE_MAX_AGE_MS
      && nowMs >= fetchedAt;
  }

  function renderStatusText({ etags, warnings = [] }) {
    const qPending = questions.pendingQuestions(loadQ()).length;
    const running = sessions.runningSessions(loadS());
    const auto = autopilot.loadAutopilot({ file: SF.autopilot });
    const fins = loadJson(SF.finisher, {});
    const activeFinishers = Object.entries(fins)
      .filter(([, s]) => s && !["done", "parked"].includes(s.stage))
      .map(([key, s]) => `${key} ${s.stage}${s.prNumber ? ` (PR #${s.prNumber})` : ""}`);
    const ready = [];
    const blocked = [];
    const repoLines = [];

    for (const [repoKey, repo] of Object.entries(H.repos)) {
      const cache = etags[repoKey];
      const usable = issueCacheUsable(cache);
      const issues = usable ? cache.issues || [] : [];
      const byLabel = (label) => issues.filter((i) => gh.issueLabels(i).includes(label));
      const count = (label) => byLabel(label).length;
      ready.push(...byLabel(LABELS.READY).map((i) => `${repoKey}#${i.number}`));
      blocked.push(...byLabel(LABELS.BLOCKED).map((i) => `${repoKey}#${i.number}`));
      repoLines.push(usable
        ? `${repo.label || repoKey}: grill ${count(LABELS.NEEDS_GRILL)} · ready ${count(LABELS.READY)} · PR ${count(LABELS.PR_OPEN)} · finish ${count(LABELS.FINISHING)} · blocked ${count(LABELS.BLOCKED)}`
        : `${repo.label || repoKey}: data stale — run /status again`);
    }

    let next = "No tap needed. Hermes is watching; file work with /file or ask /gh.";
    if (qPending) next = `Answer ${qPending} owner question${qPending === 1 ? "" : "s"} in the pinned inbox.`;
    else if (activeFinishers.length) next = "Watch for the audit/merge card; Hermes is finishing PRs.";
    else if (ready.length && !auto.enabled) next = `Dispatch ${ready[0]} with /dispatch ${ready[0]} or turn on /auto.`;
    else if (ready.length && auto.enabled) next = `Autopilot is draining ${ready.length} ready issue${ready.length === 1 ? "" : "s"}.`;
    else if (warnings.length) next = "GitHub refresh failed. Cached work is hidden; run /status again.";
    else if (blocked.length) next = `Review the blocked ledger for ${blocked[0]}.`;

    const lines = [
      "Hermes status — GitHub pipeline",
      `Next: ${next}`,
      `Autopilot: ${auto.enabled ? "ON" : "OFF"} (${auto.dispatched?.date === todayStr() ? auto.dispatched.count : 0}/${H.autopilot.dailyBudget} today)`,
      `Questions: ${qPending}`,
      `Running: ${running.length ? running.map((s) => `${s.repoKey}#${s.issue} ${s.role}/${s.engine}`).join("; ") : "none"}`,
    ];

    lines.push(...repoLines);

    lines.push(`Finishers: ${activeFinishers.length ? activeFinishers.join("; ") : "none active"}`);
    if (ready.length) lines.push(`Ready: ${ready.slice(0, 3).join(", ")}${ready.length > 3 ? `, +${ready.length - 3} more` : ""}`);
    if (blocked.length) lines.push(`Blocked: ${blocked.slice(0, 3).join(", ")}${blocked.length > 3 ? `, +${blocked.length - 3} more` : ""}`);
    if (warnings.length) lines.push(`Refresh warnings: ${warnings.join("; ")}. Cached actions from those repos are hidden.`);
    lines.push("Legacy Paperclip v1 is separate: /paperclip or /needs");
    return lines.join("\n");
  }

  async function commandOk(bin, args, opts = {}) {
    const res = await d.exec(bin, args, opts).catch((e) => ({ code: 1, stderr: e.message }));
    return { ...res, ok: res.code === 0 };
  }

  async function gatherOpsSnapshot() {
    const qData = loadQ();
    const sData = loadS();
    const fins = loadJson(SF.finisher, {});
    const git = await commandOk("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]);
    const uid = typeof process.getuid === "function" ? process.getuid() : "";
    const launch = await commandOk("launchctl", ["print", `gui/${uid}/com.example.hermes-bot`]);
    const github = await commandOk("gh", ["auth", "status"]);
    const codex = H.codexBin
      ? await commandOk(H.codexBin, ["--version"], { timeout: 10000 })
      : { ok: false, stderr: "hermes.codexBin unset" };
    const webhook = await tg("getWebhookInfo", {}).catch((e) => ({ ok: false, description: e.message }));

    const pathExists = {};
    const notePath = (p) => { if (p) pathExists[p] = fs.existsSync(p); };
    for (const repo of Object.values(H.repos || {})) notePath(repo.path);
    for (const s of sData.sessions || []) notePath(s.worktree);
    for (const [, state] of ops.activeFinisherEntries(fins)) notePath(state.worktree);

    const repoProbes = {};
    for (const [repoKey, repo] of Object.entries(H.repos || {})) {
      repoProbes[repoKey] = { exists: repo.path ? fs.existsSync(repo.path) : false };
    }

    const branchExists = {};
    for (const [, state] of ops.activeFinisherEntries(fins)) {
      const repo = repoOf(state.repoKey);
      if (!repo?.path || !state.branch) continue;
      const local = await commandOk("git", ["-C", repo.path, "show-ref", "--verify", "--quiet", `refs/heads/${state.branch}`]);
      const remote = await commandOk("git", ["-C", repo.path, "show-ref", "--verify", "--quiet", `refs/remotes/origin/${state.branch}`]);
      branchExists[`${state.repoKey}:${state.branch}`] = local.ok || remote.ok;
    }

    const appliance = await ops.gatherApplianceSnapshot({
      root: ROOT,
      config: cfg,
      stateDir: SD,
      now: d.now().getTime(),
      exec: d.exec,
      fetchImpl: d.fetch || globalThis.fetch,
    });

    return {
      appliance,
      git: { sha: git.ok ? git.stdout.trim() : "" },
      configPresent: appliance.config.present,
      hermesEnabled: !!H.enabled,
      repos: H.repos || {},
      repoProbes,
      github: { ok: github.ok, reason: (github.stderr || github.stdout || "").trim().split("\n")[0] || "" },
      telegram: {
        ok: !!webhook?.ok,
        webhookUrl: webhook?.result?.url || "",
        reason: webhook?.description || "",
      },
      codex: {
        ok: codex.ok,
        version: codex.ok ? (codex.stdout || codex.stderr || "").trim().split("\n")[0] : "",
        reason: codex.ok ? "" : (codex.stderr || codex.stdout || "").trim().split("\n")[0],
      },
      launchd: ops.parseLaunchctlPrint(launch.stdout),
      sessions: sData,
      pendingQuestions: questions.pendingQuestions(qData),
      finishers: fins,
      pathExists,
      branchExists,
      logs: ops.readLogWarnings(path.join(ROOT, "logs", "hermes.err.log")),
      askTimeoutHours: H.askTimeoutHours,
    };
  }

  async function sendOpsReport({ refreshed = false } = {}) {
    if (refreshed) {
      await refreshIssueCache().catch(() => null);
      const rec = sessions.reconcileSessions(loadS(), { now: d.now() });
      saveS(rec.data);
      await refreshInbox().catch(() => null);
    }
    const snapshot = await gatherOpsSnapshot();
    await send(ops.renderOpsReport(snapshot, { now: d.now() }), { silent: false });
  }

  async function resumeOpsSession(sessionId) {
    const record = sessions.getSession(loadS(), sessionId);
    if (!record) { await send(`No session ${sessionId}. Run /ops to list recovery candidates.`); return; }
    if (record.status !== "orphaned") { await send(`${sessionId} is ${record.status}; only orphaned sessions can be resumed from /ops.`); return; }
    if (record.worktree && !fs.existsSync(record.worktree)) {
      await send(`Cannot resume ${sessionId}: worktree is missing.\n${record.worktree}\nManual repo repair is required.`);
      return;
    }
    if (!record.engineSessionId) {
      await send(`Cannot resume ${sessionId}: no engine resume id was recorded. Check its ledger and session logs.`);
      return;
    }
    const pend = questions.pendingQuestions(loadQ()).filter((q) => q.sessionId === sessionId);
    if (pend.length) {
      await send(`${sessionId} is waiting on ${pend.length} owner question${pend.length === 1 ? "" : "s"}. Answer the inbox card first; Hermes resumes after the answer.`);
      return;
    }
    await respawn(record, { resume: true, prompt: "Owner requested recovery from /ops. Re-read your ledger comment and continue (or report done)." });
    await send(`Resuming ${sessionId}. Check /ops again in a minute.`);
  }

  async function parkFinisherLocked(key, reason, { prefix = "Parked" } = {}) {
    let fins = loadJson(SF.finisher, {});
    const state = fins[key];
    if (!state || ["done", "parked"].includes(state.stage)) {
      await send(`No active finisher for ${key}.`);
      return { ok: false, reason: "no active finisher" };
    }
    const why = reason.trim() || "owner parked from /ops";
    const slug = slugOf(state.repoKey);
    const t = finisher.finisherLabelTransitions("parked");
    try {
      await d.gh.addLabels({ slug, issue: state.issue, labels: t.add });
      for (const l of t.remove) await d.gh.removeLabel({ slug, issue: state.issue, label: l });
    } catch (error) {
      await send(`Could not park ${key}: ${error.message}. Local finisher remains active; retry /ops park ${key}.`);
      return { ok: false, reason: error.message };
    }
    fins = loadJson(SF.finisher, {});
    const latest = fins[key];
    if (!latest || ["done", "parked"].includes(latest.stage)) return { ok: false, reason: "finisher changed" };
    fins[key] = finisher.parkState(latest, why);
    writeJsonAtomic(SF.finisher, fins);
    await sendIssueStatus(key, `${prefix} ${key}: ${why}`, { silent: false });
    await refreshInbox().catch(() => null);
    return { ok: true };
  }

  async function parkOpsFinisher(key, reason) {
    return withFinisherSerialization(key, () => parkFinisherLocked(key, reason));
  }

  async function handleOpsCommand(arg) {
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    const sub = (parts[0] || "").toLowerCase();
    if (!sub || sub === "check") { await sendOpsReport(); return; }
    if (sub === "refresh" || sub === "reconcile") { await sendOpsReport({ refreshed: true }); return; }
    if (sub === "resume") { await resumeOpsSession(parts[1] || ""); return; }
    if (sub === "retry") {
      const key = parts[1] || "";
      if (!key.includes("#")) { await send("Usage: /ops retry rn#42"); return; }
      await advanceFinisher(key);
      await send(`Retried ${key}. Run /ops for the updated state.`);
      return;
    }
    if (sub === "park") {
      const key = parts[1] || "";
      if (!key.includes("#")) { await send("Usage: /ops park rn#42 <reason>"); return; }
      await parkOpsFinisher(key, parts.slice(2).join(" "));
      return;
    }
    await send("Usage: /ops, /ops refresh, /ops resume <session-id>, /ops retry rn#42, /ops park rn#42 <reason>");
  }

  // Every finisher progression and callback for one issue queues behind the same
  // promise. This preserves arrival order without dropping a poll tick or owner tap.
  const finisherQueues = new Map();

  async function withFinisherSerialization(key, work) {
    const previous = finisherQueues.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate);
    finisherQueues.set(key, tail);
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (finisherQueues.get(key) === tail) finisherQueues.delete(key);
    }
  }

  function finisherCallbackContext(key, state, { headSha, actions } = {}) {
    return {
      issueKey: key,
      repoKey: state?.repoKey,
      issue: state?.issue,
      stage: state?.stage,
      prNumber: state?.prNumber,
      auditVerdict: state?.auditVerdict ?? null,
      auditHeadSha: state?.auditHeadSha ?? null,
      headSha: headSha ?? null,
      actions: [...(actions || [])].sort(),
    };
  }

  function prepareFinisherCard(key, state, { headSha, actions }) {
    const context = finisherCallbackContext(key, state, { headSha, actions });
    const token = d.callbackTokens.createCallbackToken({ context, now: d.now });
    const rowsFor = (buttons) => buttons.map(([text, verb]) => [
      text,
      d.callbackTokens.assertTelegramCallbackData(`fin:${verb}:${token.id}:${key}`),
    ]);
    const fins = loadJson(SF.finisher, {});
    if (!fins[key]) return null;
    fins[key] = { ...fins[key], callbackToken: token };
    writeJsonAtomic(SF.finisher, fins);
    return rowsFor;
  }

  async function advanceFinisher(key) {
    return withFinisherSerialization(key, () => advanceFinisherLocked(key));
  }

  async function advanceFinisherLocked(key) {
    const fins = loadJson(SF.finisher, {});
    const state = fins[key];
    if (!state || ["done", "parked"].includes(state.stage)) return;
    const slug = slugOf(state.repoKey);
    const repo = repoOf(state.repoKey);
    if (state.stage === "audit" && state.auditVerdict === "block" && state.auditDecisionCardSent) {
      await refreshInbox().catch(() => null);
      return;
    }
    if (state.preMergeAudit && !state.started && state.mergeCardSent) return;
    if (state.preMergeAudit && !state.started && state.auditVerdict && !state.mergeCardSent) {
      if (state.auditVerdict === "approve") {
        const prRes = await d.gh.getPr({ slug, number: state.prNumber });
        const currentFins = loadJson(SF.finisher, {});
        const persisted = currentFins[key];
        if (JSON.stringify(persisted) !== JSON.stringify(state)) return;
        const currentHead = prRes?.json?.head?.sha;
        if (!currentHead || state.auditHeadSha !== currentHead) {
          currentFins[key] = {
            ...finisher.resetAuditAfterFix(persisted),
            auditStaleHeadSha: currentHead || null,
          };
          writeJsonAtomic(SF.finisher, currentFins);
          await advanceFinisherLocked(key);
          return;
        }
      }
      await sendPreMergeAuditCard(key, state);
      return;
    }
    const prRes = await d.gh.getPr({ slug, number: state.prNumber });
    if (JSON.stringify(loadJson(SF.finisher, {})[key]) !== JSON.stringify(state)) return;
    const pr = { mergeable: prRes?.json?.mergeable ?? null, headSha: prRes?.json?.head?.sha, branch: prRes?.json?.head?.ref, base: prRes?.json?.base?.ref || "main" };
    const checks = pr.headSha
      ? await d.gh.getChecksForRef({ slug, ref: pr.headSha })
      : { available: false, reason: "PR head SHA unavailable" };
    const currentFins = loadJson(SF.finisher, {});
    const persisted = currentFins[key];
    if (JSON.stringify(persisted) !== JSON.stringify(state)) return;
    const step = finisher.nextFinisherStep(persisted, { pr, checks });
    currentFins[key] = { ...step.state, branch: pr.branch || step.state.branch || null };
    writeJsonAtomic(SF.finisher, currentFins);
    const stepStateOnDisk = currentFins[key];

    const plan = loadJson(SF.plans, {})[key] || {};
    switch (step.action) {
      case "wait": return;
      case "audit": {
        // Belt to the mutex's suspenders: never two live auditors on one issue.
        if (sessions.runningSessions(loadS()).some(
          (s) => s.role === "auditor" && s.repoKey === state.repoKey && s.issue === state.issue,
        )) return;
        const engine = finisher.oppositeEngine(planEngine(plan));
        // Claude auditors read the PR via gh (they have network); codex auditors run
        // network-off in a READ-ONLY sandbox and diff the PR branch locally in a
        // disposable worktree instead.
        let worktree = repo.path, branch = null;
        if (engine === "codex") {
          const wt = await prWorktree(repo, pr.branch);
          worktree = wt.worktree; branch = pr.branch;
          rememberFinisherWorktree(key, { worktree, branch });
        }
        const prompt = finisher.buildAuditPrompt({
          issue: state.issue, repoSlug: slug, prNumber: state.prNumber,
          decisions: plan.decisions || [], handoffNote: plan.handoffNote || "",
          offline: engine === "codex", baseBranch: pr.base,
        });
        await launch({
          role: "auditor", engine, repoKey: state.repoKey, issue: state.issue,
          worktree, branch, prompt,
          model: engine === "claude" ? tierModel("audit") : undefined, effort: "high",
          allowedTools: engine === "claude" ? engines.AUDITOR_ALLOWED_TOOLS : undefined,
          meta: { auditHeadSha: pr.headSha },
        });
        await sendIssueStatus(key, `🔎 Cross-engine audit (${engine}) started on ${key} PR #${state.prNumber}`);
        return;
      }
      case "resolve-conflicts": case "fixup": {
        const role = step.action === "fixup" ? "fixer" : "resolver";
        const engine = planEngine(plan);
        assertLaunchAllowed(role, engine);
        const wt = await prWorktree(repo, pr.branch);
        rememberFinisherWorktree(key, { worktree: wt.worktree, branch: pr.branch });
        const prompt = step.action === "fixup"
          ? finisher.buildFixupPrompt({ prNumber: state.prNumber, repoSlug: slug, failedCheckNames: checks.failedNames || [] })
          : finisher.buildConflictPrompt({ prNumber: state.prNumber, baseBranch: pr.base });
        await launch({
          role, engine, repoKey: state.repoKey, issue: state.issue,
          worktree: wt.worktree, branch: pr.branch, prompt,
          model: engine === "claude" ? tierModel("grilling") : undefined, effort: "high",
          permissionMode: engine === "claude" ? "bypass" : undefined,
        });
        await sendIssueStatus(key, `🧰 ${finisher.describeFinisherStep(step)} — ${key}`);
        return;
      }
      case "ask-owner": {
        const actions = ["fix", "force", "stop"];
        const rowsFor = prepareFinisherCard(key, step.state, { headSha: pr.headSha, actions });
        if (!rowsFor) return;
        await send(`🧯 Audit flagged ${key} PR #${state.prNumber}:\n${step.state.auditNotes || step.reason}\n\nWhat should Hermes do?`, {
          silent: false,
          rows: [rowsFor([["🛠 Fix it", "fix"], ["✅ Merge anyway", "force"], ["🅿️ Park it", "stop"]])],
        });
        const latest = loadJson(SF.finisher, {});
        if (latest[key]) {
          latest[key] = { ...latest[key], auditDecisionCardSent: true };
          writeJsonAtomic(SF.finisher, latest);
        }
        await refreshInbox().catch(() => null);
        return;
      }
      case "merge": {
        const res = await d.gh.mergePr({ slug, number: state.prNumber, expectedHeadSha: step.state.auditHeadSha || pr.headSha });
        const latestFins = loadJson(SF.finisher, {});
        if (JSON.stringify(latestFins[key]) !== JSON.stringify(stepStateOnDisk)) return;
        latestFins[key] = finisher.applyMergeResult(latestFins[key], res);
        writeJsonAtomic(SF.finisher, latestFins);
        if (res.merged) {
          const t = finisher.finisherLabelTransitions("done");
          for (const l of t.remove) await d.gh.removeLabel({ slug, issue: state.issue, label: l });
          await sendIssueStatus(key, `🎉 Merged: ${key} PR #${state.prNumber}`, { silent: false });
        } else {
          await advanceFinisherLocked(key); // stay inside this key's serialized turn
        }
        return;
      }
      case "park": {
        await parkFinisherLocked(key, step.reason, { prefix: "🅿️ Parked" });
        return;
      }
      default: return;
    }
  }

  async function sendPreMergeAuditCard(key, state) {
    const livePr = await d.gh.getPr({ slug: slugOf(state.repoKey), number: state.prNumber }).catch(() => null);
    const persisted = loadJson(SF.finisher, {})[key];
    if (JSON.stringify(persisted) !== JSON.stringify(state)) return;
    const headSha = livePr?.status === 200 ? livePr.json?.head?.sha : null;
    if (!headSha) {
      await sendIssueStatus(key, `Can't show a decision card for ${key}: live PR head unavailable. Try /ops retry ${key}.`, { silent: false });
      return;
    }
    state = persisted;
    const approved = state.auditVerdict === "approve";
    const text = approved
      ? `✅ Audit approved ${key} PR #${state.prNumber}\n${state.auditNotes || "No blocking findings."}\n\nTap ✅ Merge to run CI and merge.`
      : `🧯 Audit blocked ${key} PR #${state.prNumber}\n${state.auditNotes || "Audit blocked without notes."}\n\nWhat should Hermes do?`;
    const actions = approved ? ["go", "stop"] : ["fix", "force", "stop"];
    const rowsFor = prepareFinisherCard(key, state, { headSha, actions });
    if (!rowsFor) return;
    const rows = approved
      ? [rowsFor([["✅ Merge", "go"], ["🅿️ Park it", "stop"]])]
      : [rowsFor([["🛠 Fix it", "fix"], ["✅ Merge anyway", "force"], ["🅿️ Park it", "stop"]])];
    await send(text, { silent: false, rows });
    const fins = loadJson(SF.finisher, {});
    if (fins[key]) {
      fins[key] = { ...fins[key], mergeCardSent: true };
      writeJsonAtomic(SF.finisher, fins);
    }
    await refreshInbox().catch(() => null);
  }

  // Owner-initiated dispatch (the 🚀 button or /dispatch rn#42) — deliberately skips
  // the autopilot courtesy gates (load/HID-idle/budget are for UNATTENDED drains; a
  // human tap IS the intent) but never the safety bounds: session cap + codex slot.
  async function manualDispatch(key) {
    const [repoKey, numStr] = String(key).split("#");
    const issueNum = Number(numStr);
    if (!repoOf(repoKey) || !Number.isInteger(issueNum) || issueNum <= 0) {
      await sendCommandStatus("dispatch", `Can't parse "${key}" — use e.g. /dispatch rn#42`, { silent: false });
      return;
    }
    let liveRes;
    try {
      liveRes = await d.gh.getIssue({ slug: slugOf(repoKey), number: issueNum });
    } catch (e) {
      await sendCommandStatus("dispatch", `⚠️ Dispatch of ${key} refused: GitHub live state unavailable (${e.message}).`, { silent: false });
      return;
    }
    const issue = liveRes?.json;
    if (liveRes?.status !== 200) {
      await sendCommandStatus("dispatch", `⚠️ Dispatch of ${key} refused: GitHub did not return an open issue.`, { silent: false });
      return;
    }
    const labelsWellFormed = Array.isArray(issue?.labels) && issue.labels.every((label) =>
      typeof label === "string" || (label && typeof label.name === "string"));
    if (!issue || issue.number !== issueNum || issue.state !== "open"
      || typeof issue.title !== "string" || !labelsWellFormed
      || Object.hasOwn(issue, "pull_request")) {
      await sendCommandStatus("dispatch", `⚠️ Dispatch of ${key} refused: malformed, closed, or PR-shaped live response.`, { silent: false });
      return;
    }
    const liveLabels = gh.issueLabels(issue);
    if (!liveLabels.includes(LABELS.READY)) {
      await sendCommandStatus("dispatch", `⚠️ Dispatch of ${key} refused: live issue is not ready.`, { silent: false });
      return;
    }
    const conflict = liveLabels.find((label) => DISPATCH_CONFLICT_LABELS.has(label));
    if (conflict) {
      await sendCommandStatus("dispatch", `⚠️ Dispatch of ${key} refused: live issue also has ${conflict}.`, { silent: false });
      return;
    }
    const running = sessions.runningSessions(loadS());
    if (running.some((s) => s.repoKey === repoKey && s.issue === issueNum)) {
      await sendCommandStatus("dispatch", `${key} already has a session in flight.`, { silent: false });
      return;
    }
    if (running.length >= H.sessionCap) {
      await sendCommandStatus("dispatch", `Session cap reached (${running.length}/${H.sessionCap}) — wait for one to finish.`, { silent: false });
      return;
    }
    const plan = loadJson(SF.plans, {})[key]
      || { engine: defaultEngine(), effort: "high", decisions: [], assumptions: [], handoffNote: "" };
    let engine;
    try {
      engine = planEngine(plan);
    } catch (e) {
      await sendCommandStatus("dispatch", `⚠️ Dispatch of ${key} refused: ${e.message}`, { silent: false });
      return;
    }
    if (engine === "codex" && sessions.codexBusy(loadS())) {
      await sendCommandStatus("dispatch", "Codex slot is busy (one global slot, ADR-0005) — wait, or grill it toward claude.", { silent: false });
      return;
    }
    const activeFinisher = loadJson(SF.finisher, {})[key];
    if (activeFinisher && !["done", "parked"].includes(activeFinisher.stage)) {
      await sendCommandStatus("dispatch", `⚠️ Dispatch of ${key} refused: active local finisher is at ${activeFinisher.stage}.`, { silent: false });
      return;
    }
    await sendCommandStatus("dispatch", `🚀 Dispatching ${key}…`, { silent: false });
    await launchImplementer(repoKey, issue, plan)
      .then(() => sendCommandStatus("dispatch", `✅ Dispatch started for ${key}. Watch /status for progress.`, { silent: false }))
      .catch((e) => sendCommandStatus("dispatch", `⚠️ Dispatch of ${key} failed: ${e.message}`, { silent: false }));
  }

  async function prWorktree(repo, branch) {
    await d.exec("git", ["-C", repo.path, "fetch", "origin"]);
    const dir = path.join(cfg.coding?.worktreeBase || ROOT, `${FINISHER_WORKTREE_PREFIX}${branch.replace(/[^\w-]/g, "-")}`);
    if (!fs.existsSync(dir)) {
      const r = await d.exec("git", ["-C", repo.path, "worktree", "add", dir, branch]);
      if (r.code !== 0) throw new Error(`worktree add failed: ${r.stderr}`);
      await dispatch.warmWorktree({ repoPath: repo.path, worktree: dir }); // fixers run tests too
    }
    return { worktree: dir };
  }

  function rememberFinisherWorktree(key, { worktree, branch }) {
    const fins = loadJson(SF.finisher, {});
    if (!fins[key]) return;
    fins[key] = { ...fins[key], worktree: worktree || fins[key].worktree || null, branch: branch || fins[key].branch || null };
    writeJsonAtomic(SF.finisher, fins);
  }

  async function markFinisherStartedLocked(key, { skipAudit = false } = {}) {
    let fins = loadJson(SF.finisher, {});
    const state = fins[key];
    if (!state) { await send(`No finisher state for ${key}.`); return { ok: false, reason: "no finisher state" }; }
    const slug = slugOf(state.repoKey);
    const t = finisher.finisherLabelTransitions("start");
    try {
      await d.gh.addLabels({ slug, issue: state.issue, labels: t.add });
      for (const l of t.remove) await d.gh.removeLabel({ slug, issue: state.issue, label: l });
    } catch (error) {
      await send(`Could not start ${key}: ${error.message}. No finisher action was taken.`);
      return { ok: false, reason: error.message };
    }
    fins = loadJson(SF.finisher, {});
    const latest = fins[key];
    if (!latest || latest.stage !== state.stage || latest.prNumber !== state.prNumber) {
      return { ok: false, reason: "finisher changed while labels were updating" };
    }
    fins[key] = { ...latest, started: true, skipAudit: skipAudit || latest.skipAudit };
    writeJsonAtomic(SF.finisher, fins);
    return { ok: true, state: fins[key] };
  }

  async function startFinisherLocked(key, { skipAudit }) {
    const started = await markFinisherStartedLocked(key, { skipAudit });
    if (!started.ok) return started;
    await advanceFinisherLocked(key);
    return { ok: true };
  }

  async function startAuditFixLocked(key) {
    let fins = loadJson(SF.finisher, {});
    const state = fins[key];
    if (!state) { await send(`No finisher state for ${key}.`); return { ok: false, reason: "no finisher state" }; }
    if ((state.attempts?.auditFix || 0) >= 1) {
      await send(`Audit fixer already ran once for ${key}; park it or merge anyway.`);
      return { ok: false, reason: "audit fixer already ran" };
    }
    const repo = repoOf(state.repoKey);
    const slug = slugOf(state.repoKey);
    const prRes = await d.gh.getPr({ slug, number: state.prNumber });
    fins = loadJson(SF.finisher, {});
    const latestAfterPr = fins[key];
    if (!latestAfterPr || latestAfterPr.stage !== state.stage || latestAfterPr.prNumber !== state.prNumber) {
      return { ok: false, reason: "finisher changed while PR was loading" };
    }
    const branch = prRes?.json?.head?.ref || latestAfterPr.branch;
    if (!branch) { await send(`Can't find the PR branch for ${key}.`); return { ok: false, reason: "missing PR branch" }; }
    const plan = loadJson(SF.plans, {})[key] || {};
    const engine = planEngine(plan);
    if (engine === "claude" && !H.allowClaudeWriteSessions) {
      await send("Claude write sessions are disabled; set hermes.allowClaudeWriteSessions=true only on a trusted host.");
      return { ok: false, reason: "Claude write sessions are disabled" };
    }
    const wt = await prWorktree(repo, branch);
    fins = loadJson(SF.finisher, {});
    const latest = fins[key];
    if (!latest || latest.stage !== state.stage || latest.prNumber !== state.prNumber) {
      return { ok: false, reason: "finisher changed while worktree was preparing" };
    }
    fins[key] = { ...latest, worktree: wt.worktree, branch };
    writeJsonAtomic(SF.finisher, fins);
    await launch({
      role: "fixer", engine, repoKey: latest.repoKey, issue: latest.issue,
      worktree: wt.worktree, branch,
      prompt: finisher.buildAuditFixPrompt({ prNumber: latest.prNumber, repoSlug: slug, auditNotes: latest.auditNotes || "" }),
      model: engine === "claude" ? tierModel("grilling") : undefined, effort: "high",
      permissionMode: engine === "claude" ? "bypass" : undefined,
      meta: { finisherFixKind: "audit" },
    });
    fins = loadJson(SF.finisher, {});
    if (fins[key]) {
      fins[key] = {
        ...fins[key],
        attempts: { ...(fins[key].attempts || {}), auditFix: (fins[key].attempts?.auditFix || 0) + 1 },
        mergeCardSent: true,
      };
      writeJsonAtomic(SF.finisher, fins);
    }
    await sendIssueStatus(key, `🛠 Fixing audit findings on ${key} PR #${latest.prNumber}.`);
    await refreshInbox().catch(() => null);
    return { ok: true };
  }

  // ── poll watcher ───────────────────────────────────────────────────────────

  async function pollTick() {
    const etags = loadJson(SF.etags, {});
    for (const repoKey of Object.keys(H.repos)) {
      const slug = slugOf(repoKey);
      try {
        const res = await d.gh.pollRepoIssues({ slug, etag: etags[repoKey]?.etag });
        if (res?.retryAfterMs) throw new Error(`rate limited; retry after ${res.retryAfterMs}ms`);
        const fetchedAt = d.now().toISOString();
        if (res.changed) etags[repoKey] = { etag: res.etag, issues: res.issues, fetchedAt };
        else etags[repoKey] = {
          etag: res.etag ?? etags[repoKey]?.etag,
          issues: etags[repoKey]?.issues || [],
          fetchedAt,
        };
      } catch (e) {
        etags[repoKey] = {
          ...(etags[repoKey] || { issues: [] }),
          refreshFailedAt: d.now().toISOString(),
          refreshError: e.message,
        };
        log(`[hub] poll ${slug}: ${e.message}`);
      }
    }
    writeJsonAtomic(SF.etags, etags);

    // Liveness sweep: sessions that survived a bot restart have no exit handler in
    // THIS process — when their detached child dies, nothing fires. Probe running
    // records each tick and finalize the dead ones. The exit code is inferred from
    // output (finished → 0, else 1); the silent-codex script-retry needs a REAL
    // exit 0 and therefore only engages on the live (same-process) path.
    for (const rec of sessions.runningSessions(loadS())) {
      if (sessions.isPidAlive(rec.pid)) continue;
      const meta = sessions.sessionOutputMeta(rec);
      await finalize(rec.id, meta.finished && !meta.failed ? 0 : 1)
        .catch((e) => log(`[hub] sweep finalize ${rec.id}: ${e.message}`));
    }

    const sessData = loadS();
    const running = sessions.runningSessions(sessData);
    const hasSessionFor = (repoKey, n) => running.some((s) => s.repoKey === repoKey && s.issue === n);

    for (const repoKey of Object.keys(H.repos)) {
      if (!issueCacheUsable(etags[repoKey])) continue;
      const issues = etags[repoKey]?.issues || [];
      // 1. Grilling intake: needs-grill and nothing running on it yet. Intake is
      // automatic (not autopilot-gated), so it gets its own concurrency cap — a deep
      // backlog drains grillerCap-at-a-time instead of storming the session cap.
      for (const issue of gh.filterByLabel(issues, LABELS.NEEDS_GRILL)) {
        if (hasSessionFor(repoKey, issue.number)) continue;
        if (gh.issueLabels(issue).includes(LABELS.GRILLING)) continue; // stale etag view
        const live = sessions.runningSessions(loadS());
        if (live.length >= H.sessionCap) break;
        if (live.filter((s) => s.role === "griller").length >= H.grillerCap) break;
        await launchGriller(repoKey, issue).catch((e) => log(`[hub] griller ${repoKey}#${issue.number}: ${e.message}`));
      }
    }

    // 2. Autopilot: drain ready through the gates, one dispatch per tick.
    const auto = autopilot.loadAutopilot({ file: SF.autopilot });
    if (auto.enabled) {
      const readyIssues = Object.keys(H.repos).flatMap((repoKey) =>
        issueCacheUsable(loadJson(SF.etags, {})[repoKey])
          ? gh.filterByLabel(loadJson(SF.etags, {})[repoKey]?.issues || [], LABELS.READY)
            .map((i) => ({ ...i, repoKey }))
          : []);
      const inputs = await d.gatherGateInputs();
      const gatesResult = gates.evaluateGates({
        ...inputs, enabled: auto.enabled,
        runningCount: sessions.runningSessions(loadS()).length,
        sessionCap: H.sessionCap,
        // Slot arithmetic is per-issue inside pickNextDispatch; the global gate
        // must not veto claude dispatches just because the codex slot is busy.
        codexBusy: sessions.codexBusy(loadS()),
        wantsCodex: false,
        dispatchedToday: auto.dispatched?.date === todayStr() ? auto.dispatched.count : 0,
        dailyBudget: H.autopilot.dailyBudget,
        cfg: H.autopilot,
      });
      const pick = autopilot.pickNextDispatch({
        readyIssues, sessionsData: loadS(), gatesResult, defaultEngine: defaultEngine(),
      });
      if (pick.issue) {
        const plan = loadJson(SF.plans, {})[issueKey(pick.issue.repoKey, pick.issue.number)]
          || { engine: pick.engine, effort: "high", decisions: [], assumptions: [], handoffNote: "" };
        plan.engine = pick.engine;
        try {
          await launchImplementer(pick.issue.repoKey, pick.issue, plan);
          const current = autopilot.loadAutopilot({ file: SF.autopilot });
          const next = {
            ...current,
            dispatched: gates.budgetAfterDispatch(current.dispatched || { date: "", count: 0 }, d.now()),
          };
          autopilot.saveAutopilot(next, { file: SF.autopilot });
        } catch (e) {
          log(`[hub] dispatch ${pick.issue.repoKey}#${pick.issue.number}: ${e.message}`);
        }
      }
    }

    // 3. Finisher states waiting on external progress. Pre-merge audit states
    // may advance only through audit/card; CI+merge still require owner intent.
    const fins = loadJson(SF.finisher, {});
    for (const key of Object.keys(fins)) {
      if ((fins[key].started || fins[key].preMergeAudit) && !["done", "parked"].includes(fins[key].stage)) {
        await advanceFinisher(key).catch((e) => log(`[hub] finisher ${key}: ${e.message}`));
      }
    }

    // 4. Morning digest.
    const inboxState = loadJson(SF.inbox, {});
    if (inbox.digestDue({ lastDigestDate: inboxState.lastDigestDate, hour: H.morningDigestHour, now: d.now() })) {
      const pending = questions.pendingQuestions(loadQ());
      await send(inbox.morningDigestText({ pending, running: sessions.runningSessions(loadS()) }, d.now()), { silent: false });
      writeJsonAtomic(SF.inbox, { ...inboxState, lastDigestDate: todayStr() });
    }
  }

  const todayStr = () => {
    const n = d.now();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  };

  function startPollWatcher() {
    const tick = async () => {
      if (stopped) return;
      try { await pollTick(); } catch (e) { log(`[hub] poll tick: ${e.message}`); }
      const active = sessions.runningSessions(loadS()).length > 0
        || questions.pendingQuestions(loadQ()).length > 0;
      const delay = gh.adaptivePollDelayMs({
        active, cfgActiveSeconds: H.pollActiveSeconds, cfgIdleSeconds: H.pollIdleSeconds,
      });
      pollTimer = setTimeout(tick, delay);
    };
    tick();
  }

  // ── one-shot claude helpers (/file, explain, issue chat) ──────────────────

  function runOneShot({ prompt, system, model, allowedTools = [], disallowedTools = [], mcpConfigPath, timeoutMs = 120000 }) {
    return new Promise((resolve) => {
      const args = ["-p", prompt, "--output-format", "json", "--model", model];
      if (system) args.push("--append-system-prompt", system);
      if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
      if (allowedTools.length) args.push("--allowedTools", ...allowedTools);
      else args.push("--tools", "");
      if (disallowedTools.length) args.push("--disallowedTools", ...disallowedTools);
      d.execFile(cfg.claudeBin || "claude", args, {
        timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
        cwd: path.join(ROOT, "state", "concierge-sandbox"),
        env: sessionEnv(),
      }, (err, stdout) => {
        try {
          const out = JSON.parse(stdout);
          resolve({ ok: !err && !out.is_error, text: out.result || "" });
        } catch { resolve({ ok: false, text: err?.message || "no output" }); }
      });
    });
  }

  async function handleFile(text) {
    if (!text.trim()) { await sendCommandStatus("file", "Usage: /file <describe the bug or idea — voice works too>", { silent: false }); return; }
    const flow = d.callbackTokens.createCallbackToken({ context: { kind: "file-flow" }, now: d.now });
    patchPrefsHermes({ fileFlowGeneration: flow.id, fileDraft: null });
    await sendCommandStatus("file", "📝 Shaping that into an issue…", { silent: false });
    const res = await runOneShot({
      prompt: filing.buildFilingPrompt({ text, repos: H.repos }),
      model: MODELS[tierModel("prose")] || tierModel("prose"),
    });
    if (prefsHermes().fileFlowGeneration !== flow.id) return;
    const parsed = res.ok ? filing.parseFiledIssue(res.text) : null;
    if (!parsed) {
      await sendCommandStatus("file", `Couldn't shape that into an issue (${res.text.slice(0, 200)}). Try rephrasing.`, { silent: false });
      return;
    }
    if (!parsed.repoKey || !H.repos[parsed.repoKey]) {
      const token = d.callbackTokens.createCallbackToken({ context: { kind: "file-draft" }, now: d.now });
      patchPrefsHermes({ fileDraft: { ...parsed, ...token } });
      const rows = [Object.entries(H.repos).map(([k, r]) => [
        r.label || k,
        d.callbackTokens.assertTelegramCallbackData(`file:repo:${token.id}:${k}`),
      ])];
      await sendCommandStatus("file", `📝 Shaped "${parsed.title}". Waiting for repo choice.`, { silent: false });
      const current = prefsHermes();
      if (current.fileFlowGeneration !== flow.id || current.fileDraft?.id !== token.id) return;
      await send(`Which repo?\n\n"${parsed.title}"`, { rows });
      return;
    }
    await createFiledIssue(parsed, { generation: flow.id });
  }

  async function createFiledIssue(parsed, { generation } = {}) {
    await sendCommandStatus("file", `📌 Filing ${parsed.repoKey}: ${parsed.title}…`, { silent: false });
    if (generation && prefsHermes().fileFlowGeneration !== generation) return;
    const slug = slugOf(parsed.repoKey);
    const res = await d.gh.createIssue({
      slug, title: parsed.title, body: parsed.body, labels: filing.FILED_ISSUE_LABELS,
    });
    if (res?.number) await sendCommandStatus("file", `📌 Filed ${parsed.repoKey}#${res.number}: ${parsed.title}\n${res.html_url}\nIt lands needs-grill — grilling starts on the next poll.`, { silent: false });
    else await sendCommandStatus("file", "Filing failed — check gh auth / repo slug.", { silent: false });
  }

  async function handleIssueChat(text) {
    const mcpConfigPath = engines.writeGitHubReadMcpConfig({ dir: SD, ...githubReadMcp() });
    const res = await runOneShot({
      prompt: text,
      system: filing.buildIssueChatSystem({ repos: H.repos }),
      model: MODELS[tierModel("prose")] || tierModel("prose"),
      allowedTools: [...filing.ISSUE_CHAT_ALLOWED_TOOLS],
      disallowedTools: ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"],
      mcpConfigPath,
    });
    for (const part of chunk(res.text || "(no answer)")) await send(part);
  }

  async function handleExplain(q) {
    const record = sessions.getSession(loadS(), q.sessionId);
    const led = record ? ledgerOf(record) : null;
    const res = await runOneShot({
      prompt: [
        "A headless coding session asked the owner this question. Explain, for a phone screen in plain text, what is being decided, what the recommendation implies, and what saying no would mean. Be concrete and short.",
        `Question: ${q.question}`, `Recommended: ${q.recommended}`,
        q.context ? `Context: ${q.context}` : "",
        led ? `Session ledger:\n${ledger.renderLedger(led)}` : "",
      ].filter(Boolean).join("\n\n"),
      model: MODELS[tierModel("prose")] || tierModel("prose"),
    });
    for (const part of chunk(res.text || "(couldn't explain)")) await send(part);
  }

  // ── telegram surface ───────────────────────────────────────────────────────

  async function rearmFinisherCardLocked(key) {
    const fins = loadJson(SF.finisher, {});
    const state = fins[key];
    if (!state || state.callbackToken) return;
    const flag = state.preMergeAudit && !state.started ? "mergeCardSent" : "auditDecisionCardSent";
    fins[key] = { ...state, [flag]: false, callbackToken: null };
    writeJsonAtomic(SF.finisher, fins);
    try {
      await advanceFinisherLocked(key);
    } catch (error) {
      log(`[hub] could not regenerate finisher card for ${key}: ${error.message}`);
    }
  }

  async function handleFinisherCallback({ verb, id, key }) {
    return withFinisherSerialization(key, async () => {
      let fins = loadJson(SF.finisher, {});
      let state = fins[key];
      let token = state?.callbackToken;
      let actions = token?.context?.actions;
      if (!state || !Array.isArray(actions) || !actions.includes(verb)) {
        await send("That finisher button is stale or invalid. Use /status for the current action.");
        return;
      }
      const livePr = await d.gh.getPr({ slug: slugOf(state.repoKey), number: state.prNumber }).catch(() => null);
      const headSha = livePr?.status === 200 ? livePr.json?.head?.sha : null;
      if (!headSha) {
        await send("Can't verify the live PR right now. No action was taken; try the current card again.");
        return;
      }
      // The network read above may have yielded to disk recovery or another
      // process. Validate and consume only the currently persisted state/token.
      fins = loadJson(SF.finisher, {});
      state = fins[key];
      token = state?.callbackToken;
      actions = token?.context?.actions;
      if (!state || !Array.isArray(actions) || !actions.includes(verb)) {
        await send("That finisher button is stale or invalid. Use /status for the current action.");
        return;
      }
      const context = finisherCallbackContext(key, state, { headSha, actions });
      const checked = d.callbackTokens.validateCallbackToken(token, {
        id, context, now: d.now, maxAgeMs: FINISHER_CALLBACK_TTL_MS,
      });
      if (!checked.ok) {
        if (token?.id === id && checked.reason !== "unknown") {
          fins[key] = { ...state, callbackToken: null };
          writeJsonAtomic(SF.finisher, fins);
          await rearmFinisherCardLocked(key);
        }
        await send("That finisher button is stale or expired. Use /status for the current action.");
        return;
      }

      // Consume before the first mutation/launch await. A second tap now fails as unknown.
      fins[key] = { ...state, callbackToken: null };
      writeJsonAtomic(SF.finisher, fins);
      let result = { ok: true };
      try {
        if (verb === "go") result = await startFinisherLocked(key, { skipAudit: false });
        else if (verb === "fix") result = await startAuditFixLocked(key);
        else if (verb === "force") {
          result = await markFinisherStartedLocked(key, { skipAudit: true });
          if (result.ok) {
            const latest = loadJson(SF.finisher, {});
            latest[key] = finisher.applyOwnerMergeDecision(latest[key] || result.state, true);
            writeJsonAtomic(SF.finisher, latest);
            await advanceFinisherLocked(key);
          }
        } else if (verb === "stop") {
          result = await parkFinisherLocked(key, "owner parked from finisher card");
        }
      } catch (error) {
        result = { ok: false, reason: error.message };
        await send(`Finisher action for ${key} failed: ${error.message}. A fresh action card will be generated.`);
      }
      if (!result?.ok) await rearmFinisherCardLocked(key);
      await refreshInbox().catch(() => null);
    });
  }

  async function handleCallback(cq) {
    const data = cq.data || "";
    const ask = inbox.parseAskCallback(data);
    if (ask) {
      await answerCallback(cq.id);
      const q = questions.getQuestion(loadQ(), ask.id);
      if (!q) { await send("That question is gone (restart or already handled)."); return true; }
      if (q.status !== "pending") { await send("Already answered."); return true; }
      if (ask.verb === "yes") await deliverAnswer(ask.id, q.recommended);
      else if (ask.verb === "other") {
        patchPrefsHermes({ awaitingAnswerId: ask.id });
        await send(`✍️ Reply with your answer for ${q.repoKey}#${q.issue} (text or voice).`);
      } else if (ask.verb === "explain") await handleExplain(q);
      return true;
    }
    if (data.startsWith("fin:")) {
      await answerCallback(cq.id);
      const parsed = Buffer.byteLength(data, "utf8") <= 64
        ? /^fin:(go|fix|force|stop):([A-Za-z0-9_-]{12}):([A-Za-z0-9_-]+#\d+)$/.exec(data)
        : null;
      if (!parsed) {
        await send("That finisher button is malformed or expired. Use /status for the current action.");
        return true;
      }
      await handleFinisherCallback({ verb: parsed[1], id: parsed[2], key: parsed[3] });
      return true;
    }
    if (data.startsWith("disp:go:")) {
      await answerCallback(cq.id);
      await send("That legacy dispatch button is no longer accepted. Use /dispatch repo#issue for a fresh GitHub check.");
      return true;
    }
    if (data.startsWith("file:repo:")) {
      await answerCallback(cq.id);
      const parsed = Buffer.byteLength(data, "utf8") <= 64
        ? /^file:repo:([A-Za-z0-9_-]{12}):([A-Za-z0-9_-]+)$/.exec(data)
        : null;
      if (!parsed) { await send("That filing button is invalid — /file again."); return true; }
      const [, id, repoKey] = parsed;
      const draft = prefsHermes().fileDraft;
      const checked = d.callbackTokens.validateCallbackToken(draft, {
        id, context: { kind: "file-draft" }, now: d.now, maxAgeMs: FILE_DRAFT_TTL_MS,
      });
      if (!checked.ok || !H.repos[repoKey]) {
        if (draft?.id === id && checked.reason !== "unknown") patchPrefsHermes({ fileDraft: null });
        await send("That filing draft is stale or expired — /file again.");
        return true;
      }
      patchPrefsHermes({ fileDraft: null });
      const { id: _id, createdAt: _createdAt, context: _context, ...file } = draft;
      await createFiledIssue({ ...file, repoKey });
      return true;
    }
    return false;
  }

  async function handleCommand(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    if (cmd === "/auto") {
      const auto = autopilot.loadAutopilot({ file: SF.autopilot });
      if (/^(on|off)$/i.test(arg)) {
        const next = autopilot.setAutopilot(auto, arg.toLowerCase() === "on");
        autopilot.saveAutopilot(next, { file: SF.autopilot });
        await send(next.enabled ? "🚗 Autopilot ON — draining ready issues through the gates." : "🛑 Autopilot OFF.", { silent: false });
      } else {
        await send(autopilot.autopilotStatusText({
          enabled: auto.enabled, dispatched: auto.dispatched, dailyBudget: H.autopilot.dailyBudget,
          running: sessions.runningSessions(loadS()),
          pendingQuestions: questions.pendingQuestions(loadQ()).length,
        }));
      }
      return true;
    }
    if (cmd === "/status") {
      const fresh = await refreshIssueCache();
      await send(renderStatusText(fresh), { silent: false });
      return true;
    }
    if (cmd === "/ops" || cmd === "/doctor") {
      await handleOpsCommand(arg);
      return true;
    }
    if (cmd === "/tiers") {
      const parts = arg.split(/\s+/).filter(Boolean);
      const current = Object.fromEntries(TIER_JOBS.map((job) => [job, tierModel(job)]));
      if (parts.length === 2 && current[parts[0]] !== undefined && isSupportedModel(parts[1])) {
        patchPrefsHermes({ tiers: { ...(prefsHermes().tiers || {}), [parts[0]]: parts[1] } });
        await send(`🎚 ${parts[0]} → ${parts[1]}`);
      } else if (parts.length === 2 && parts[0] === "engine" && isSupportedEngine(parts[1])) {
        patchPrefsHermes({ defaultEngine: parts[1] });
        await send(`🎚 default engine → ${parts[1]}`);
      } else if (parts.length === 2 && parts[0] === "engine") {
        await send("⚠️ Engine must be codex or claude.");
      } else if (parts.length === 2 && current[parts[0]] !== undefined) {
        await send("⚠️ Model must be one of haiku, sonnet, opus.");
      } else {
        await send([
          "Tiers (job → model). Change: /tiers <job> <model>",
          ...Object.entries(current).map(([k, v]) => `• ${k}: ${v}`),
          `• engine: ${defaultEngine()} (change: /tiers engine codex|claude)`,
        ].join("\n"));
      }
      return true;
    }
    if (cmd === "/file") { await handleFile(arg); return true; }
    if (cmd === "/gh") { await handleIssueChat(arg || "what's open?"); return true; }
    if (cmd === "/dispatch") {
      // accept "rn#42", "rn 42", or "rn42"
      const m = /^(\w+)[#\s]?(\d+)$/.exec(arg.trim());
      await manualDispatch(m ? `${m[1]}#${m[2]}` : arg.trim());
      return true;
    }
    return false;
  }

  // ❌-Other answers (typed or voice-transcribed) get captured here before the
  // text would fall through to the Paperclip concierge.
  async function captureAwaitingInput(text) {
    const awaiting = prefsHermes().awaitingAnswerId;
    if (!awaiting) return false;
    patchPrefsHermes({ awaitingAnswerId: null });
    const ok = await deliverAnswer(awaiting, text.trim());
    await send(ok ? "✅ Sent to the session." : "That question was already handled.");
    return true;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async function start() {
    // Crash counter (build mandate): count starts in the last hour; warn on a storm.
    const crashes = (loadJson(SF.crashes, { starts: [] }).starts || [])
      .filter((t) => d.now() - new Date(t) < 3600_000);
    crashes.push(d.now().toISOString());
    writeJsonAtomic(SF.crashes, { starts: crashes });
    if (crashes.length === 5) {
      await send(`⚠️ Hermes restarted ${crashes.length}× in the last hour — check logs/hermes.err.log.`, { silent: false });
    } else if (crashes.length > 5) {
      await sendHealthStatus("crash-storm", `⚠️ Hermes restart storm continues: ${crashes.length} starts in the last hour. Check logs/hermes.err.log.`, { silent: true });
    }

    // Startup reconcile (ADR-0004): probe persisted sessions, finalize the
    // completed dead, queue orphans for resume.
    const migrated = sessions.ensureAskTokens(loadS());
    if (migrated.changed) saveS(migrated.data);
    const rec = sessions.reconcileSessions(migrated.data, { now: d.now() });
    saveS(rec.data);
    for (const fin of rec.finished) {
      // Reconcile already set the final status, so finalize() would no-op —
      // run the role finalizer directly for sessions that completed while the
      // bot was down:
      const meta = sessions.sessionOutputMeta(fin);
      const ok = fin.status !== "failed";
      if (fin.role === "griller") await finalizeGriller(fin, meta, ok).catch(() => {});
      else if (fin.role === "implementer") {
        await withIssueFinalization(fin, () => finalizeImplementerLocked(fin, meta, ok)).catch(() => {});
      } else if (fin.role === "auditor") {
        await withIssueFinalization(fin, () => finalizeAuditorLocked(fin, meta)).catch(() => {});
      } else if (fin.role === "fixer" || fin.role === "resolver") {
        await withIssueFinalization(fin, () => finalizeFinisherWorkerLocked(fin, meta, ok)).catch(() => {});
      }
    }
    for (const orphan of rec.orphaned) {
      const pend = questions.pendingQuestions(loadQ())
        .filter((q) => q.sessionId === orphan.id);
      if (pend.length) {
        // Blocked on an unanswered question: resume happens when the answer
        // arrives (deliverAnswer → resumeWithAnswer). Re-surface the cards.
        for (const q of pend) {
          const msgId = await send(inbox.questionCardText(q), { silent: true, rows: inbox.questionCardKbd(q) });
          if (msgId) saveQ(questions.setTgMessageId(loadQ(), q.id, msgId));
        }
      } else {
        await respawn(orphan, { resume: true, prompt: "The bot restarted while you ran. Re-read your ledger comment and continue (or report done)." })
          .catch((e) => log(`[hub] orphan resume ${orphan.id}: ${e.message}`));
      }
    }
    if (rec.alive.length) log(`[hub] ${rec.alive.length} session(s) still running across the restart`);

    const swept = await d.reapHubDiskRetention({ cfg, stateDir: SD, now: d.now, exec: d.exec }).catch((e) => {
      log(`[hub] retention sweep failed: ${e.message}`);
      return { worktrees: 0, simArtifacts: 0 };
    });
    if (swept.worktrees || swept.simArtifacts) {
      log(`[hub] reaped ${swept.worktrees} finisher worktree(s), ${swept.simArtifacts} simulator artifact dir(s)`);
    }

    askServer = createAskServer({ sockPath: hubSock, authenticate: authenticateAskRequest, onAsk, getAnswer, log });
    await askServer.start();
    startPollWatcher();
    await refreshInbox();
    log(`[hub] started — repos ${Object.keys(H.repos).join(", ")}, engine ${defaultEngine()}, autopilot ${autopilotEnabled() ? "ON" : "off"}`);
  }

  async function checkpoint() {
    stopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    await ledgerEditor.flush().catch(() => {});
    if (askServer) await askServer.stop().catch(() => {});
  }

  return {
    start, checkpoint, handleCommand, handleCallback, captureAwaitingInput,
    // exposed for tests / manual driving:
    authenticateAskRequest, onAsk, getAnswer, deliverAnswer, pollTick, advanceFinisher, refreshInbox,
  };
}

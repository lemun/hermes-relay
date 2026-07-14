// Hermes — Telegram hub for the GitHub shipping pipeline.
//
// Long-polls Telegram for YOUR messages and relays owner-class decisions from
// headless GitHub-issue sessions.
//
//   node hermes-bot.mjs            # run the bot (launchd uses this)
//   node hermes-bot.mjs --whoami   # print the chat id of whoever messages (onboarding)
//
import path from "node:path";
import {
  loadPrefs, savePrefs, ROOT,
} from "./lib/runtime.mjs";
import { loadConfigForCli } from "./lib/config-cli.mjs";
import { MODELS } from "./lib/models.mjs";
import { createTelegram, chunk } from "./lib/telegram.mjs";
import { voiceConfig, isHebrew, transcribeVoice } from "./lib/voice.mjs";
import {
  startCodingJob, resumeCodingJob, stopCodingJob, codingStatus,
  pushCodingResult, reapStaleActive, recoverPendingCodingFinalization,
  reapOldWorktrees, lastCodingSession,
  assertCodingConfig, EFFORTS,
} from "./lib/coder.mjs";
import { createCodingWizard } from "./lib/coding/wizard.mjs";
import { createHermesHub } from "./lib/hermes-hub.mjs";
import { gatherApplianceSnapshot, renderApplianceReport } from "./lib/ops.mjs";
import { createActionAuthorization, classifyTelegramMessage } from "./lib/action-authorization.mjs";
import { createTelegramCallbackBindingResolver } from "./lib/callback-binding.mjs";
import { enforcePrivateUmask } from "./lib/runtime-security.mjs";
import { acquireSingletonLock as acquireDescriptorSingletonLock } from "./lib/singleton-lock.mjs";
import { activateRuntimeAfterLocalUnlock } from "./lib/runtime-activation.mjs";

const WHOAMI = process.argv.includes("--whoami");
const CHECK = process.argv.includes("--check");
enforcePrivateUmask();

// Unattended-operation posture: a stray fetch rejection (Telegram/GitHub HTTP/2
// GOAWAY, transient DNS) must not kill a bot that babysits hours-long sessions —
// log it loudly and keep running. True exceptions stay fatal: state may be
// corrupt, and launchd (KeepAlive) + the hub's crash counter own that restart.
process.on("unhandledRejection", (e) => {
  console.error(`[hermes] UNHANDLED REJECTION (surviving): ${e?.stack || e}`);
});
const cfg = loadConfigForCli({ diagnostic: CHECK });
const TOKEN = cfg.telegram?.botToken;
const ALLOWED = String(cfg.telegram?.allowedChatId || 0);
const ALLOWED_USER = String(cfg.telegram?.allowedUserId || 0);
const CODING = cfg.coding || {}; // opt-in coding mode (write+bash); enabled defaults false
const HERMES = cfg.hermes || {}; // opt-in v2 pipeline (ratification relay + dispatch); defaults false

const resolveCallbackBinding = createTelegramCallbackBindingResolver(loadPrefs);

const actionAuthorization = createActionAuthorization({
  configuredChatId: ALLOWED,
  configuredUserId: ALLOWED_USER,
  totpSecret: cfg.telegram?.totpSecret,
  stateFile: path.join(ROOT, "state", "hermes-security.json"),
  resolveCallbackBinding,
});
const { tg, kbd, answerCallback, sendKbd, editMsg } = createTelegram(TOKEN, {
  callbackAuthorization: actionAuthorization,
});
function assertRuntimeAction(action) {
  if (!actionAuthorization.authorizeRuntimeAction(action)) throw new Error("runtime security policy denied the action");
}

// The v2 hub (lib/hermes-hub.mjs): ask-server, poll watcher, sessions, finisher.
// Constructed lazily in startup() only when hermes.enabled — a disabled hub costs
// zero (idle = zero LLM tokens is the autopilot design line, and this is its floor).
let hub = null;

// Voice notes → text (local, no API): whisper.cpp + ffmpeg, bilingual models (lib/voice.mjs).
const VOICE = voiceConfig(cfg, ROOT);
const DEFAULT_LANG = cfg.transcribeLanguage || "he"; // he | en | auto — overridable live via /lang

// Preferences live in state/hermes-prefs.json and are saved atomically.
const LANGS = ["he", "en", "auto"];
function currentLang() { const l = loadPrefs().lang || DEFAULT_LANG; return LANGS.includes(l) ? l : "he"; }

const HELP = [
  "Hermes — your GitHub shipping hub. Start with /status.",
  "",
  ...(cfg.hermes?.enabled ? [
    "Next:   /status shows what needs your phone tap now",
    "Ops:    /ops or /doctor checks the live appliance health",
    "Ship:   /dispatch rn#42 · /auto on|off · /tiers",
    "Issues: /file <bug or idea> · /gh <question about issues>",
  ] : []),
  "Set:    /lang he|en|auto",
  "Info:   /me (settings)",
  "Secure: /auth <TOTP> grants one action (2-minute expiry) · /lock locks remotely",
  ...(CODING.enabled ? [
    "Code:   /code (start a coding session) · /codestatus · /stop · /code again <text>",
  ] : []),
  "/help — this message",
].join("\n");

if (!TOKEN || TOKEN.includes("PASTE")) {
  console.error("[hermes] No telegram.botToken in config.json — get one from @BotFather and set it.");
  process.exit(1);
}

// ── Coding mode ────────────────────────────────────────────────────────────────
// A real write-enabled Claude Code session, isolated in a git worktree (lib/coder.mjs).
// The inline-keyboard wizard (repo → model → effort → prompt → confirm) lives in
// lib/coding/wizard.mjs; constructed once here with the real deps. The job runs detached
// (never awaited here) so Telegram polling stays responsive.
const codingWizard = createCodingWizard({
  cfg,
  telegram: { tg, kbd, answerCallback, sendKbd, editMsg },
  prefs: { loadPrefs, savePrefs },
  coder: { startCodingJob, resumeCodingJob, codingStatus, pushCodingResult, lastCodingSession, EFFORTS },
  models: MODELS, chunk,
  security: {
    authorizeRuntimeAction: actionAuthorization.authorizeRuntimeAction,
    authorizeCurrentRuntimeAction: actionAuthorization.authorizeCurrentRuntimeAction,
  },
});
const { handleCode, handleCodeCallback, handleWizardPrompt, sendCodingStatus, doPush } = codingWizard;

async function onCallback(cq) {
  const data = cq.data || "";
  if (data.startsWith("code:")) await handleCodeCallback(cq);
  else if (hub && (data.startsWith("ask:") || data.startsWith("fin:") || data.startsWith("file:") || data.startsWith("disp:"))) await hub.handleCallback(cq);
  else await answerCallback(cq.id);
}

async function onMessage(msg) {
  const chatId = String(msg.chat.id);

  // Onboarding: --whoami replies the chat id to whoever messaged, then EXITS (it's an open
  // relay while running — never leave it up, and never run it under launchd).
  if (WHOAMI) {
    console.log(`[hermes] message from chat id ${chatId} (${msg.chat.username || msg.chat.first_name || "?"})`);
    await tg("sendMessage", { chat_id: chatId, text: `Your chat id is ${chatId}. Put it in .env → TELEGRAM_CHAT_ID, then restart Hermes (without --whoami).` });
    console.log("[hermes] whoami done — exiting. Set TELEGRAM_CHAT_ID and restart.");
    process.exit(0);
  }
  // Bot-handled slash commands. Free text is intentionally not sent to a generic
  // host-side model; GitHub questions use the narrowly-scoped /gh route.
  const text = msg.text?.trim();
  if (hub && text && /^\/?status$/i.test(text)) {
    if (await hub.handleCommand("/status")) return;
  }
  if (hub && text && /^\/(auto|tiers|file|gh|dispatch|ops|doctor)\b/.test(text)) {
    if (await hub.handleCommand(text)) return;
  }
  if (!hub && text && /^\/?status$/i.test(text)) {
    await tg("sendMessage", { chat_id: chatId, text: "Hermes GitHub pipeline is off (set hermes.enabled=true)." });
    return;
  }
  if (!hub && text && /^\/(ops|doctor)\b/i.test(text)) {
    const appliance = await gatherApplianceSnapshot({ root: ROOT, config: cfg });
    await tg("sendMessage", { chat_id: chatId, text: renderApplianceReport(appliance) });
    return;
  }
  if (text && /^\/(lang|me|help|start|code|codestatus|stop)\b/.test(text)) {
    const [cmd, arg] = text.split(/\s+/);
    if (cmd === "/code") { await handleCode(chatId, text); return; }
    if (cmd === "/codestatus") { await sendCodingStatus(chatId); return; }
    if (cmd === "/stop") {
      await tg("sendMessage", { chat_id: chatId, text: stopCodingJob() ? "🛑 Stopping the coding job…" : "Nothing to stop." });
      return;
    }
    if (cmd === "/me") {
      await tg("sendMessage", { chat_id: chatId, text: `Voice: ${currentLang()}${CODING.enabled ? `\nCoding: ${codingStatus().running ? "running" : "idle"}` : ""}` });
    } else if (cmd === "/lang") {
      const a = (arg || "").toLowerCase();
      if (LANGS.includes(a)) { assertRuntimeAction("hub.runtime.mutate"); const p = loadPrefs(); p.lang = a; savePrefs(p); await tg("sendMessage", { chat_id: chatId, text: `🎙 Voice language → ${a}.` }); }
      else await tg("sendMessage", { chat_id: chatId, text: `Voice language is "${currentLang()}".\nChange: /lang he · /lang en · /lang auto` });
    } else {
      await tg("sendMessage", { chat_id: chatId, text: HELP });
    }
    return;
  }

  // Resolve the user's text — typed message, or a transcribed voice note.
  let userText = msg.text;
  if (!userText && msg.voice) {
    const lang = currentLang();
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    try {
      assertRuntimeAction("hub.runtime.spawn");
      userText = await transcribeVoice({ fileId: msg.voice.file_id, lang, voice: VOICE, tg, token: TOKEN });
      const heard = isHebrew(userText) ? "שמעתי" : "heard";
      await tg("sendMessage", { chat_id: chatId, text: `🎤 ${heard}: ${userText}` });
    } catch (e) {
      await tg("sendMessage", { chat_id: chatId, text: `(couldn't transcribe that: ${e.message})` });
      return;
    }
  }
  if (!userText) return; // photo/sticker/etc — nothing to act on

  // A question card's ❌-Other answer (typed or voice) is captured BEFORE anything
  // else could swallow it — it unblocks a session waiting on the phone.
  if (hub && await hub.captureAwaitingInput(userText)) return;

  // If the coding wizard is waiting for the task/follow-up prompt, capture it here.
  const wiz = loadPrefs().coding?.wizard;
  if (wiz && (wiz.step === "prompt" || wiz.step === "resumePrompt")) {
    await handleWizardPrompt(chatId, userText, wiz);
    return;
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text: "Hermes no longer has a general or Paperclip concierge. Use /status, /gh <question>, /file <work>, or /help.",
  });
}

// Handle one update. Its own try/catch so a poison message surfaces to the phone instead of only
// a logfile, and never bubbles to the loop. Runs on dispatchChain (see loop).
async function dispatch(u) {
  try {
    if (WHOAMI && u.message) {
      await onMessage(u.message);
      return;
    }
    if (u.callback_query) {
      const checked = actionAuthorization.consumeCallback(u);
      if (!checked.ok) {
        await answerCallback(u.callback_query.id, checked.reason === "step_up_required"
          ? "Step-up required. Send /auth <code>, then use a fresh button."
          : "Not authorized or button expired.");
        return;
      }
      await actionAuthorization.runWithAuthorization(checked.generation, () => onCallback({
        ...u.callback_query,
        data: checked.originalData,
        securityBinding: checked.binding,
      }));
      return;
    }
    if (u.message) {
      const checkedIdentity = actionAuthorization.authorizeIdentity(u);
      if (!checkedIdentity.ok) {
        await tg("sendMessage", { chat_id: u.message.chat.id, text: "Not authorized." });
        return;
      }
      const prefs = loadPrefs();
      const action = classifyTelegramMessage({
        text: u.message.text,
        hasVoice: !!u.message.voice,
        awaitingAnswer: !!hub?.hasAwaitingInput(),
        wizardStep: prefs.coding?.wizard?.step,
      });
      if (action === "auth.step_up") {
        const match = /^\/auth\s+(\d{6,10})\s*$/i.exec(u.message.text || "");
        const result = match ? actionAuthorization.verifyStepUp(match[1]) : { ok: false };
        await tg("sendMessage", {
          chat_id: u.message.chat.id,
          text: result.ok ? "✅ Step-up active for 2 minutes." : "Step-up failed.",
        });
        return;
      }
      if (action === "lock") {
        const result = actionAuthorization.lockRemote();
        await tg("sendMessage", { chat_id: u.message.chat.id, text: result.ok ? "🔒 Hermes is locked." : "Lock failed." });
        return;
      }
      if (action === "unlock") {
        actionAuthorization.unlockRemote();
        await tg("sendMessage", { chat_id: u.message.chat.id, text: "Remote unlock is disabled. Unlock locally on the host." });
        return;
      }
      const allowed = actionAuthorization.authorizeCommand(u, action);
      if (!allowed.ok) {
        await tg("sendMessage", {
          chat_id: u.message.chat.id,
          text: allowed.reason === "step_up_required"
            ? "Step-up required. Send /auth <code>, then retry."
            : "Action denied by security policy.",
        });
        return;
      }
      await actionAuthorization.runWithAuthorization(allowed.generation, () => onMessage(u.message));
    }
  } catch (e) {
    console.error(`[hermes] handler error: ${e.message}`);
    const chatId = u.callback_query?.message?.chat?.id || u.message?.chat?.id;
    if (chatId && actionAuthorization.authorizeIdentity(u).ok) {
      await tg("sendMessage", { chat_id: chatId, text: "Something broke handling that — check the logs." }).catch(() => {});
    }
  }
}

let offset = 0;
let backoffMs = 0;
let dispatchChain = Promise.resolve(); // serializes handlers in arrival order, off the poll loop
async function loop() {
  try {
    const res = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, 60000);
    if (res && res.ok === false) {
      console.error(`[hermes] getUpdates not ok: ${res.error_code} ${res.description}`);
      backoffMs = Math.min((backoffMs || 1000) * 2, 60000);
      await new Promise((r) => setTimeout(r, backoffMs));
    } else {
      backoffMs = 0; // healthy response — reset backoff
    }
    if (res?.ok) {
      for (const u of res.result) {
        offset = u.update_id + 1;
        // Serialize handlers in arrival order so the prefs-backed wizard state cannot interleave.
        // The poll loop still does not await this chain; offset is already advanced.
        dispatchChain = dispatchChain.then(() => dispatch(u));
      }
    }
  } catch (e) {
    console.error(`[hermes] loop error: ${e.message}`);
    backoffMs = Math.min((backoffMs || 1000) * 2, 60000);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  setImmediate(loop);
}

// Singleton guard: refuse to start a second Hermes (e.g. a manual `npm run hermes` while the
// launchd service is up) — two getUpdates consumers steal each other's updates. Best-effort
// descriptor-held pidfile in a validated root-owned sticky temp directory; its
// deterministic key is derived from the canonical repo root. A stale regular
// lock (dead pid) is reclaimed without trusting user-replaceable state ancestry.
function acquireSingletonLock() {
  const claimed = acquireDescriptorSingletonLock({ rootPath: ROOT });
  if (!claimed.ok) return claimed;
  const release = claimed.release;
  process.on("exit", () => { try { release(); } catch { /* process exit cannot recover */ } });
  // Checkpoint, release the lock, then exit with the conventional 128+signal code.
  // The checkpoint (flush coalesced ledger edits, close the ask socket) is what the
  // plist's ExitTimeOut=30 exists for — a SIGKILL mid-edit loses ledger writes.
  const shutdown = (code) => async () => {
    try {
      if (hub) await Promise.race([hub.checkpoint(), new Promise((r) => setTimeout(r, 20000))]);
    } catch { /* checkpoint is best-effort */ }
    release();
    process.exit(code);
  };
  process.on("SIGTERM", shutdown(143));
  process.on("SIGINT", shutdown(130));
  return { ok: true };
}

async function startup() {
  // 0. Coding mode is write+bash enabled — refuse to run it behind an open auth gate or a
  // broken repo allowlist. (Read-only mode tolerates a missing chat id but fails closed.)
  // Skipped in --whoami, whose whole job is to hand you the chat id before you configure it.
  if (CODING.enabled && !WHOAMI) {
    if (!ALLOWED || ALLOWED === "0" || !ALLOWED_USER || ALLOWED_USER === "0" || !cfg.telegram?.totpSecret) {
      console.error("[hermes] coding.enabled requires TELEGRAM_CHAT_ID, TELEGRAM_USER_ID, and HERMES_TOTP_SECRET — refusing to start.");
      process.exit(1);
    }
    try { await assertCodingConfig(cfg); }
    catch (e) { console.error(`[hermes] coding config invalid: ${e.message}`); process.exit(1); }
  }

  // 1. Verify the token works (loud — a bad token is the #1 cause of "bot is silent").
  const me = await tg("getMe", {});
  if (!me?.ok) {
    console.error(`[hermes] getMe FAILED — token rejected (${me?.error_code} ${me?.description}). Check TELEGRAM_BOT_TOKEN in .env.`);
    process.exit(1);
  }
  console.log(`[hermes] token OK → bot is @${me.result.username}`);

  // 2. Inspect webhook posture. Clearing it is an external mutation and therefore
  // waits for local unlock together with every other runtime activation step.
  const wh = await tg("getWebhookInfo", {});

  if (CHECK) {
    console.log(`[hermes] check OK. authorized chat = ${ALLOWED || "(none — fail-closed, refuses all)"}. webhook = ${wh?.result?.url || "(none)"}. coding = ${CODING.enabled ? `ON (${Object.keys(CODING.repos).join(", ") || "no repos"})` : "off"}. hermes = ${HERMES.enabled ? `ON (${Object.keys(HERMES.repos || {}).join(", ") || "no repos"})` : "off"}.`);
    process.exit(0);
  }

  // Singleton guard FIRST — before any state-mutating recovery below — so a second instance
  // (e.g. a manual run while launchd's is up) exits without touching prefs or worktrees.
  const lock = acquireSingletonLock();
  if (!lock.ok) {
    console.error(`[hermes] another Hermes is already running (pid ${lock.pid}) — refusing to start a second poller. Stop it first (launchctl bootout / kill) before running manually.`);
    process.exit(1);
  }

  // Construct the hub without starting its recovery, relay, retention, or polling.
  // This lets locked mode retain read/control routing without touching durable state.
  if (HERMES.enabled && !WHOAMI && !CHECK) {
    if (!ALLOWED || ALLOWED === "0" || !ALLOWED_USER || ALLOWED_USER === "0" || !cfg.telegram?.totpSecret) {
      console.error("[hermes] hermes.enabled requires TELEGRAM_CHAT_ID, TELEGRAM_USER_ID, and HERMES_TOTP_SECRET — refusing to start.");
      process.exit(1);
    }
    hub = createHermesHub({
      cfg, chatId: ALLOWED,
      telegram: { tg, kbd, answerCallback, sendKbd, editMsg },
      deps: { authorizeRuntimeAction: actionAuthorization.authorizeRuntimeAction },
      log: (m) => console.error(m),
    });
  }

  let activationPromise = null;
  const activateRuntime = () => {
    if (activationPromise) return activationPromise;
    activationPromise = (async () => {
      const codingEnabled = !WHOAMI && CODING.enabled;
      const activated = await activateRuntimeAfterLocalUnlock({
        authorizeRuntimeAction: actionAuthorization.authorizeCurrentRuntimeAction,
        readLockdownGeneration: () => actionAuthorization.inspectState().lockdownGeneration,
        webhookUrl: wh?.ok ? wh.result?.url : null,
        deleteWebhook: wh?.ok && wh.result?.url
          ? () => {
            console.log(`[hermes] clearing existing webhook after local unlock: ${wh.result.url}`);
            return tg("deleteWebhook", { drop_pending_updates: false });
          }
          : undefined,
        recoverCoding: codingEnabled
          ? async () => {
            const stale = reapStaleActive();
            if (!stale) return null;
            if (stale.phase !== "finalization_pending") return { stale, recovered: false };
            const recovery = await recoverPendingCodingFinalization({
              authorizeCurrentRuntimeAction: actionAuthorization.authorizeCurrentRuntimeAction,
            });
            if (recovery.deferred) throw new Error(`coding finalization remains deferred: ${recovery.reason}`);
            return { stale, recovered: recovery.recovered === true, result: recovery.result };
          }
          : undefined,
        notifyCodingRecovery: ALLOWED && ALLOWED !== "0"
          ? async ({ stale, recovered }) => {
            const prefix = recovered
              ? "✅ Recovered and finalized an interrupted coding job"
              : "⚠️ A coding job was interrupted by a restart";
            await tg("sendMessage", {
              chat_id: ALLOWED,
              text: `${prefix} (${stale.repoLabel || stale.repoKey}, branch ${stale.branch}). Its worktree is at:\n${stale.worktreePath}`,
            });
          }
          : undefined,
        runRetention: codingEnabled
          ? (assertFresh) => reapOldWorktrees(cfg, { assertFresh })
          : undefined,
        startHub: hub
          ? (assertFresh) => hub.start({ assertFresh })
          : undefined,
      });
      if (activated.reaped) console.log(`[hermes] reaped ${activated.reaped} stale coding worktree(s)`);
      console.log("[hermes] write-enabled runtime activated after local unlock");
    })();
    return activationPromise;
  };

  if (actionAuthorization.isLocked()) {
    console.log("[hermes] locked-first startup — recovery, retention, relay, and polling remain deferred until local unlock");
    const unlockWatcher = setInterval(() => {
      if (actionAuthorization.isLocked()) return;
      clearInterval(unlockWatcher);
      activateRuntime().catch((error) => {
        console.error(`[hermes] post-unlock activation failed: ${error.message}`);
        process.exit(1);
      });
    }, 1000);
    unlockWatcher.unref?.();
  } else {
    await activateRuntime();
  }

  // Slash command menu is managed by you in BotFather — the bot does not overwrite it.
  console.log(`[hermes] start — voice "${currentLang()}", coding ${CODING.enabled ? "ON" : "off"}, ${WHOAMI ? "WHOAMI mode (DM the bot to get your chat id)" : `authorized chat ${ALLOWED || "(none — fail-closed)"}`}`);
  loop();
}

startup().catch((e) => { console.error(`[hermes] startup failed: ${e.message}`); process.exit(1); });

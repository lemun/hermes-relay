// Hermes — Telegram texting concierge for the Paperclip org.
//
// Long-polls Telegram for YOUR messages, runs each through `claude -p` (your
// SUBSCRIPTION — ANTHROPIC_API_KEY is stripped so it never meters) with the
// read-only paperclip-cockpit MCP attached, and texts the answer back.
//
//   node hermes-bot.mjs            # run the bot (launchd uses this)
//   node hermes-bot.mjs --whoami   # print the chat id of whoever messages (onboarding)
//
// v1 is read + advise only: the MCP exposes reads, and the tool allowlist blocks
// everything else. Hermes can tell you the exact card to tap; it cannot tap it.

import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, ROOT } from "./lib/paperclip.mjs";

const WHOAMI = process.argv.includes("--whoami");
const CHECK = process.argv.includes("--check");
const cfg = loadConfig();
const TOKEN = cfg.telegram?.botToken;
const ALLOWED = String(cfg.telegram?.allowedChatId || 0);
const DEFAULT_MODEL = cfg.claudeModel || "claude-sonnet-4-6";
const CLAUDE = cfg.claudeBin || "claude";
const MCP_CONFIG = path.join(ROOT, "mcp-config.json");
const API = `https://api.telegram.org/bot${TOKEN}`;

// Voice notes → text (local, no API): whisper.cpp with TWO models for true bilingual.
const WHISPER = cfg.whisperBin || "/opt/homebrew/bin/whisper-cli";
const MODEL_HE = cfg.whisperModelHe || path.join(ROOT, "models/ggml-ivrit-large-v3-turbo.bin");   // Hebrew-elite (ivrit-ai)
const MODEL_MULTI = cfg.whisperModelMulti || path.join(ROOT, "models/ggml-large-v3-turbo.bin");    // multilingual (vanilla)
const FFMPEG = cfg.ffmpegBin || "/opt/homebrew/bin/ffmpeg";
const DEFAULT_LANG = cfg.transcribeLanguage || "he"; // he | en | auto — overridable live via /lang

const PREFS = path.join(ROOT, "state", "hermes-prefs.json");
const LANGS = ["he", "en", "auto"];
function loadPrefs() { try { return JSON.parse(readFileSync(PREFS, "utf8")); } catch { return {}; } }
function savePrefs(p) { try { mkdirSync(path.dirname(PREFS), { recursive: true }); writeFileSync(PREFS, JSON.stringify(p, null, 2)); } catch { /* ignore */ } }
function currentLang() { const l = loadPrefs().lang || DEFAULT_LANG; return LANGS.includes(l) ? l : "he"; }

// Claude model, switchable live via /model haiku|sonnet|opus (persisted in prefs).
const MODELS = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-4-6", opus: "claude-opus-4-8" };
function currentModelId() { const m = loadPrefs().model; return (m && MODELS[m]) || DEFAULT_MODEL; }
function currentModelName() {
  const m = loadPrefs().model;
  if (m && MODELS[m]) return m;
  const hit = Object.entries(MODELS).find(([, v]) => v === DEFAULT_MODEL);
  return hit ? hit[0] : "sonnet";
}

// Map a language mode to {model, lang}. Hebrew → ivrit-ai (Hebrew-elite); English &
// auto → the vanilla multilingual model (it won't transliterate English into Hebrew).
function sttPlan(lang) {
  if (lang === "he") return { model: MODEL_HE, lang: "he" };
  if (lang === "en") return { model: MODEL_MULTI, lang: "en" };
  return { model: MODEL_MULTI, lang: "auto" };
}

const HELP = [
  "Hermes — your Paperclip concierge. Text me or send a voice note (Hebrew/English).",
  "",
  "See:    /status · /needs · /recent · /today",
  "Look:   /issue HOM-N · /agents · /find <word>",
  "Act:    /accept HOM-N · /reject HOM-N  (I send a 1-tap link)",
  "Chat:   /new (fresh) · /again (re-run last) · /me (settings)",
  "Set:    /lang he|en|auto · /model haiku|sonnet|opus",
  "/help — this message",
].join("\n");

if (!TOKEN || TOKEN.includes("PASTE")) {
  console.error("[hermes] No telegram.botToken in config.json — get one from @BotFather and set it.");
  process.exit(1);
}

const ALLOWED_TOOLS = [
  "mcp__paperclip__board_status",
  "mcp__paperclip__whats_blocking_me",
  "mcp__paperclip__list_issues",
  "mcp__paperclip__get_issue",
  "mcp__paperclip__agent_states",
  "mcp__paperclip__recent_activity",
];

const SYSTEM = [
  "You are Hermes, the phone concierge for the owner's Paperclip AI company (a small consumer app, mid-launch).",
  "You reply by phone text: concise, plain sentences. PLAIN TEXT ONLY — no markdown at all (no **bold**, no #, no tables, no backticks). A few short lines max.",
  "Print every link as the RAW url on its own line (http://… or https://…), NEVER as [text](url) — phone apps only auto-link raw urls.",
  "You have read-only MCP tools (mcp__paperclip__*) over the LIVE org: board_status, whats_blocking_me, list_issues, get_issue, agent_states.",
  "Always answer from live tool data — never invent issue numbers, statuses, or counts. If unsure, call a tool.",
  "Voice transcripts can garble issue ids — 'HOM 27', 'home 27', 'accept 27' all mean HOM-27. Map loosely-spoken or mis-heard numbers to the right HOM-N identifier using the live issue list; if genuinely ambiguous, ask which one.",
  "For 'what needs me' / 'status', call whats_blocking_me or board_status and give the 1-tap actions in priority order, each with its tapToOpen link so the user can open the card and act in one tap.",
  "The user may send short commands, with or without a leading slash — treat both the same: status → board_status; needs → whats_blocking_me; accept/approve HOM-N → the tapToOpen link to accept; reject HOM-N → the tapToOpen link to reject in the UI; issue HOM-N → get_issue; agents → agent_states; recent → recent_activity (what happened lately); today → list_issues, summarize the ones whose 'updated' is today; find <keyword> → list_issues filtered by that keyword in the title, returning matches with tapToOpen links. To explain why an agent errored, use recent_activity (its details carry failure reasons).",
  "Reply in the SAME language the user used (Hebrew or English).",
  "You READ only — you cannot accept/reject cards or post comments yourself. When the user asks to accept/approve/reject/act on a card, DO NOT claim you did it. Instead reply with the tapToOpen link for that issue (from whats_blocking_me / get_issue) so they tap Accept in the Paperclip UI, e.g. 'Tap to accept HOM-27: <link>'.",
  "Keep replies under ~1500 characters.",
].join(" ");

async function tg(method, body, timeoutMs = 15000) {
  const r = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json();
}

function runClaudeOnce(prompt, resumeId) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // force subscription auth, never the metered API
    const args = [
      "-p", prompt,
      "--model", currentModelId(),
      "--mcp-config", MCP_CONFIG,
      "--strict-mcp-config",
      "--allowedTools", ...ALLOWED_TOOLS,
      "--disallowedTools", "Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task",
      "--output-format", "json",
    ];
    // Continue the same conversation when we have a session; else start one with the system prompt.
    if (resumeId) args.push("--resume", resumeId);
    else args.push("--append-system-prompt", SYSTEM);
    execFile(CLAUDE, args, { env, timeout: 120000, maxBuffer: 16 * 1024 * 1024, cwd: ROOT }, (err, stdout, stderr) => {
      if (!stdout) return resolve({ ok: false, text: `(hermes error: ${err ? err.message : stderr?.slice(0, 200) || "no output"})` });
      try {
        const j = JSON.parse(stdout);
        resolve({ ok: !j.is_error, sid: j.session_id, text: (j.result || j.text || "").trim() || "(no reply)" });
      } catch {
        resolve({ ok: false, text: stdout.slice(0, 1500) });
      }
    });
  });
}

// Run a prompt with conversation continuity via the persisted session id; fall back to a
// fresh session if the stored one is stale/expired. Persists the (possibly new) session id.
async function runClaude(prompt) {
  const sid = loadPrefs().sessionId;
  let r = await runClaudeOnce(prompt, sid);
  if (!r.ok && sid) r = await runClaudeOnce(prompt, null);
  if (r.sid) { const p = loadPrefs(); p.sessionId = r.sid; savePrefs(p); }
  return r.text;
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(bin)} failed: ${err.message} ${(stderr || "").slice(0, 200)}`));
      else resolve(stdout);
    });
  });
}

// Telegram voice note (OGG/Opus) → text via ffmpeg + whisper.cpp (model picked by lang).
async function transcribeVoice(fileId, lang) {
  const plan = sttPlan(lang);
  if (!existsSync(plan.model)) throw new Error(`${lang} model not downloaded yet`);
  const f = await tg("getFile", { file_id: fileId });
  if (!f?.ok) throw new Error(`getFile: ${f?.description || "failed"}`);
  const r = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`, {
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`download: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const base = path.join(os.tmpdir(), `hermes-voice-${fileId.slice(-12)}-${Date.now()}`);
  const ogg = `${base}.oga`, wav = `${base}.wav`;
  writeFileSync(ogg, buf);
  try {
    await run(FFMPEG, ["-y", "-i", ogg, "-ar", "16000", "-ac", "1", wav]);
    const out = await run(WHISPER, ["-m", plan.model, "-f", wav, "-l", plan.lang, "-nt", "-np"]);
    return out.replace(/\s+/g, " ").trim();
  } finally {
    for (const p of [ogg, wav]) { try { unlinkSync(p); } catch { /* ignore */ } }
  }
}

function chunk(s, n = 3800) {
  const out = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : ["(empty)"];
}

// Run a prompt through Claude and reply, remembering it as the "last prompt" for /again.
async function answer(chatId, prompt) {
  const p = loadPrefs(); p.lastPrompt = prompt; savePrefs(p);
  await tg("sendChatAction", { chat_id: chatId, action: "typing" });
  const reply = await runClaude(prompt);
  for (const part of chunk(reply)) await tg("sendMessage", { chat_id: chatId, text: part });
}

let offset = 0;
async function loop() {
  try {
    const res = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, 60000);
    if (res && res.ok === false) {
      console.error(`[hermes] getUpdates not ok: ${res.error_code} ${res.description}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (res?.ok) {
      for (const u of res.result) {
        offset = u.update_id + 1;
        const msg = u.message;
        if (!msg) continue;
        const chatId = String(msg.chat.id);

        if (WHOAMI) {
          console.log(`[hermes] message from chat id ${chatId} (${msg.chat.username || msg.chat.first_name || "?"})`);
          await tg("sendMessage", { chat_id: chatId, text: `Your chat id is ${chatId}. Put it in .env → TELEGRAM_CHAT_ID, then restart Hermes.` });
          continue;
        }
        if (ALLOWED !== "0" && chatId !== ALLOWED) {
          await tg("sendMessage", { chat_id: chatId, text: "Not authorized." });
          continue;
        }

        // Bot-handled slash commands: /lang, /model, /help, /start.
        // (Everything else — status, needs, accept, issue, agents, today — falls through to Claude.)
        if (msg.text && /^\/(lang|model|new|me|again|help|start)\b/.test(msg.text.trim())) {
          const [cmd, arg] = msg.text.trim().split(/\s+/);
          if (cmd === "/new") {
            const p = loadPrefs(); delete p.sessionId; savePrefs(p);
            await tg("sendMessage", { chat_id: chatId, text: "🧵 New chat — earlier context cleared." });
          } else if (cmd === "/again") {
            const last = loadPrefs().lastPrompt;
            if (last) await answer(chatId, last);
            else await tg("sendMessage", { chat_id: chatId, text: "Nothing to repeat yet — ask me something first." });
          } else if (cmd === "/me") {
            const pr = loadPrefs();
            await tg("sendMessage", { chat_id: chatId, text: `Model: ${currentModelName()}\nVoice: ${currentLang()}\nChat: ${pr.sessionId ? "continuing a thread" : "fresh"}` });
          } else if (cmd === "/lang") {
            const a = (arg || "").toLowerCase();
            if (LANGS.includes(a)) {
              const p = loadPrefs(); p.lang = a; savePrefs(p);
              await tg("sendMessage", { chat_id: chatId, text: `🎙 Voice language → ${a}.` });
            } else {
              await tg("sendMessage", { chat_id: chatId, text: `Voice language is "${currentLang()}".\nChange: /lang he · /lang en · /lang auto` });
            }
          } else if (cmd === "/model") {
            const a = (arg || "").toLowerCase();
            if (MODELS[a]) {
              const p = loadPrefs(); p.model = a; savePrefs(p);
              await tg("sendMessage", { chat_id: chatId, text: `🧠 Model → ${a}.` });
            } else {
              await tg("sendMessage", { chat_id: chatId, text: `Model is "${currentModelName()}".\nChange: /model haiku · /model sonnet · /model opus` });
            }
          } else {
            await tg("sendMessage", { chat_id: chatId, text: HELP });
          }
          continue;
        }

        // Resolve the user's text — typed message, or a transcribed voice note.
        let userText = msg.text;
        if (!userText && msg.voice) {
          const lang = currentLang();
          await tg("sendChatAction", { chat_id: chatId, action: "typing" });
          try {
            userText = await transcribeVoice(msg.voice.file_id, lang);
            const isHebrew = [...userText].some((c) => c.charCodeAt(0) >= 0x0590 && c.charCodeAt(0) <= 0x05ff);
            const heard = isHebrew ? "שמעתי" : "heard";
            await tg("sendMessage", { chat_id: chatId, text: `🎤 ${heard}: ${userText}` });
          } catch (e) {
            await tg("sendMessage", { chat_id: chatId, text: `(couldn't transcribe that: ${e.message})` });
            continue;
          }
        }
        if (!userText) continue; // photo/sticker/etc — nothing to act on

        // Strip a leading slash so `claude -p` treats "/today" as a prompt, not a CLI slash command.
        const prompt = userText.replace(/^\/+/, "").trim() || userText;
        await answer(chatId, prompt);
      }
    }
  } catch (e) {
    console.error(`[hermes] loop error: ${e.message}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  setImmediate(loop);
}

async function startup() {
  // 1. Verify the token works (loud — a bad token is the #1 cause of "bot is silent").
  const me = await tg("getMe", {});
  if (!me?.ok) {
    console.error(`[hermes] getMe FAILED — token rejected (${me?.error_code} ${me?.description}). Check TELEGRAM_BOT_TOKEN in .env.`);
    process.exit(1);
  }
  console.log(`[hermes] token OK → bot is @${me.result.username}`);

  // 2. Clear any webhook — if one is set, getUpdates returns 409 and the bot never sees messages.
  const wh = await tg("getWebhookInfo", {});
  if (wh?.ok && wh.result?.url) {
    console.log(`[hermes] clearing existing webhook: ${wh.result.url}`);
    await tg("deleteWebhook", { drop_pending_updates: false });
  }

  if (CHECK) {
    console.log(`[hermes] check OK. authorized chat = ${ALLOWED}. webhook = ${wh?.result?.url || "(none)"}.`);
    process.exit(0);
  }

  // Slash command menu is managed by you in BotFather — the bot does not overwrite it.
  console.log(`[hermes] start — claude ${currentModelName()}, voice lang "${currentLang()}", ${WHOAMI ? "WHOAMI mode (DM the bot to get your chat id)" : `authorized chat ${ALLOWED}`}`);
  loop();
}

startup().catch((e) => { console.error(`[hermes] startup failed: ${e.message}`); process.exit(1); });

# Paperclip — phone bridge

Two small services that put the live Paperclip AI company in your pocket:

- **`notifier.mjs`** — polls the Paperclip loopback API and pushes an **ntfy** alert to
  your phone when the board (you) is needed: a new pending `request_confirmation` card,
  or an agent entering `error`. Outbound-only; works over cellular.
- **`hermes-bot.mjs`** — a **Telegram** texting concierge. You DM the bot; it runs your
  message through `claude -p` (your **subscription**, never the metered API) with a
  read-only `paperclip-cockpit` MCP and texts the answer back.

Everything is **read-only** against Paperclip. Acting on the board (accepting a card,
commenting) is a deliberate gated fast-follow, not in v1.

```
phone ◄── ntfy ──── notifier.mjs ──GET──► Paperclip :3100
you  ──► Telegram ─► hermes-bot.mjs ─► claude -p + paperclip-cockpit-mcp ──GET──► :3100
```

## Secrets

Secrets live in **`.env`** (gitignored), NOT in `config.json`. `.env` values override
the matching `config.json` fields at load time, so `config.json` stays secret-free.
`config.json` and `.env` are both gitignored; only `*.example.*` are committed.

| key (`.env`) | what |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather token (the one real secret) |
| `TELEGRAM_CHAT_ID` | your numeric chat id (only this chat may talk to Hermes) |
| `NTFY_TOPIC` | your ntfy topic (semi-secret — keep it unguessable) |
| `NTFY_SERVER` | optional, defaults to `https://ntfy.example.com` |

## Setup (one time)

1. **Install the dependency + make your files:**
   ```sh
   cd ~/src/hermes-relay
   npm install
   cp config.example.json config.json   # non-secret structure
   cp .env.example .env                  # secrets go here
   ```

2. **ntfy (push):** install the **ntfy** app (iOS/Android) and subscribe to your topic
   (default `REDACTED-TOPIC`). Anyone who knows the topic can read its alerts,
   so keep it unguessable (or self-host ntfy and set `NTFY_SERVER`).

3. **Telegram (Hermes):**
   - Message **@BotFather** → `/newbot` → put the token in `.env` → `TELEGRAM_BOT_TOKEN`.
   - Verify it: `npm run check` → prints `token OK → bot is @yourbot` (or the exact error).
   - Get your chat id: `npm run whoami`, then DM your bot anything — it prints and replies
     with your chat id. Put it in `.env` → `TELEGRAM_CHAT_ID`, Ctrl-C the whoami run.

4. **Smoke-test by hand:**
   ```sh
   npm run notifier:once     # pushes one "notifier is live" digest to your phone
   npm run hermes            # then DM the bot: "what needs me?"
   ```

5. **Run them 24/7 (launchd):**
   ```sh
   cp launchd/com.example.*.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.example.paperclip-notifier.plist
   launchctl load ~/Library/LaunchAgents/com.example.hermes-bot.plist
   ```
   Logs: `logs/notifier.log`, `logs/hermes.log`. To stop: `launchctl unload <plist>`.

## Troubleshooting — "the bot doesn't answer"

Run `npm run check`. It does a `getMe` and reports the bot name or the exact API error,
and clears any stale webhook (a set webhook makes `getUpdates` return 409 and the bot
never sees your messages — the #1 silent failure). Common causes:
- **Token empty/typo** → `check` says token rejected. Fix `TELEGRAM_BOT_TOKEN` in `.env`.
- **A webhook was set** → `check` clears it; restart `npm run hermes`.
- **Process not running** → it must stay running (use the launchd service for 24/7).
- Watch `logs/hermes.err.log` for `getUpdates not ok` lines.

## Notes / knobs (`config.json`)

- `pollSeconds` — notifier poll cadence (default 45s).
- `claudeModel` — Hermes model (default `claude-sonnet-4-6`; bump to Opus if you want).
- `uiBaseUrl` — your Tailscale URL to the Paperclip UI, used for the tap-through link in
  notifications. Defaults to the Mac mini tailnet host; fix if your tailnet differs.
- `companyId` — the company UUID (already filled).

## Try Hermes

> what needs me right now?
> why is eng-lead in error?
> summarize HOM-27
> what shipped today?
> status

## Commands

`/lang`, `/model`, `/new`, `/me`, `/again`, `/help` are bot-handled; the rest fall through
to Claude (the bot strips the leading slash so `claude -p` doesn't treat `/today` as its own
command). The bot keeps a conversation session (`--resume`), so follow-ups have context;
`/new` clears it. Paste this into **BotFather** (`/setcommands`) for the "/" menu:

    status - Board snapshot: counts, reviews, agent states
    needs - What needs you now, with one-tap links to act
    recent - What happened lately across the org
    today - What shipped or changed today
    issue - Look up an issue, e.g. /issue HOM-27
    find - Search issues by keyword, e.g. /find landing
    agents - Agent run-states: idle, running, or error
    accept - Tap-link to accept a card, e.g. /accept HOM-27
    reject - Tap-link to reject a card, e.g. /reject HOM-27
    new - Start a fresh chat (clear earlier context)
    again - Re-run your last question on fresh data
    me - Show current model, voice language, and chat
    lang - Voice language: /lang he | en | auto
    model - Claude model: /model haiku | sonnet | opus
    help - What you can ask Hermes

## Voice notes — true bilingual (BUILT)

DM Hermes a Telegram **voice note** in Hebrew or English; it transcribes locally (no API)
via `ffmpeg` + `whisper.cpp`, replies `🎤 (lang) heard: …` so you can catch mishears, then
acts on the transcript. Two models, picked by the current language mode:

- **Hebrew** → the **ivrit-ai** model (`models/ggml-ivrit-large-v3-turbo.bin`) — Hebrew-elite.
- **English / auto** → the vanilla **large-v3-turbo** (`models/ggml-large-v3-turbo.bin`) —
  clean English; `auto` detects either language without transliterating English into Hebrew.

**Switch language right from Telegram** (persists in `state/hermes-prefs.json`):

    /lang he      # Hebrew (ivrit-ai model)   ← default
    /lang en      # English (vanilla model)
    /lang auto    # detect either (vanilla)
    /lang         # show current

Setup: `brew install whisper-cpp` + both models in `models/`. `/lang` and `/help` also show
in Telegram's "/" command menu. Default mode is `config.json` → `transcribeLanguage`.

## Acting from your phone (v2 — deep-link tap-through, BUILT)

Hermes never mutates the board. When you ask to accept/reject/act on a card, it replies
with the **raw tap-through link** to that card in the Paperclip UI (over your Tailscale),
where you tap Accept yourself — one tap, full auth + context, zero write code. The MCP
returns a `tapToOpen` url on `whats_blocking_me`, `board_status`, and `get_issue`.

## Roadmap (not built — deliberately deferred)

- **True hands-free actions:** let Hermes call Paperclip's write API itself (accept/reject/
  comment) behind a Telegram "reply YES" confirm. Deferred on purpose — it authorizes an
  automated agent to mutate the live company, and needs the board write+auth path wired
  through Paperclip's sealed-secret store. Ask to build it when you want it.

# Hermes

The phone-side hub for Shai's GitHub-issue pipeline: it relays agents' decision questions to
Telegram, dispatches disposable coding sessions, and keeps all durable state on the GitHub
issue. Dead time becomes shipped decisions.

This repo was renamed **`hermes-relay` → `hermes-relay`** (GitHub redirects the
old URLs). Hermes v2 (the
GitHub-issue pipeline below) is the headline; the original Paperclip bridge — notifier,
concierge, `/code`, board accept/reject — still runs, unchanged, as a secondary surface. See
[Paperclip bridge (v1, dormant unless configured)](#paperclip-bridge-v1-dormant-unless-configured).

```
GitHub issue ──labels/ledger──► hermes-bot.mjs (the hub) ◄──Telegram──► you
                                       │
                          spawns disposable sessions (griller / implementer / auditor)
                                       │
                            claude -p  or  codex exec   (subscription, never metered API)
```

Both pipelines are **opt-in and off by default**. Cloning and running this code with a stock
`config.json` changes nothing until you set `hermes.enabled=true` (and, separately,
`coding.enabled=true` for the v1 coding sessions).

## Hermes v2 — the GitHub-issue pipeline

An issue moves through a small set of GitHub labels. The bot never blocks on you unless it
genuinely needs an owner-class decision — everything else is self-resolved and logged to the
issue's ledger comment.

### Issue lifecycle

| Label | Meaning |
|---|---|
| `needs-grilling` | Filed, awaiting a grilling session |
| `grilling` | Grilling session in flight |
| `waiting-input` | ≥1 question pending for you (coexists with `grilling`/`implementing`; the inbox rebuilds from this label on restart) |
| `ready` | Ratified, awaiting dispatch |
| `implementing` | Implementation session in flight |
| `pr-open` | PR exists, awaiting the finisher pipeline |
| `finishing` | Finisher pipeline in flight (conflicts → audit → CI → merge) |
| `blocked` | Parked with a plain-language reason in the ledger comment |
| `engine:codex` / `engine:claude` | Per-issue engine override (default codex) |

Every session writes to a single **ledger comment** on the issue — one structured, edited-in-place
comment per session holding decisions, assumptions, questions asked/answered, a handoff note (so
a fresh session can continue without re-exploring the repo), and the outcome. The issue is the
system of record; the bot is only a hub — restart it and it rebuilds everything from labels and
ledger comments.

### The ratification relay

The core of v2: a session's decision question travels to your phone and the answer travels back
to unblock it. A **question** is a single ratification request with a recommended answer and
one-tap reply buttons — never a bare prompt or alert.

- **Inbox**: one pinned Telegram message, edited in place (`🔔 N waiting` + one line per
  question) — never unpinned/re-pinned. Notification sound fires only on the 0→1 transition
  (first question after quiet); everything else sends silently. A morning digest goes out at
  `hermes.morningDigestHour`.
- **Question card**: question + recommended answer, with buttons `✅ <recommended>` / `❌ Other`
  / `🔍 Explain`. `✅` accepts the recommendation immediately. `❌` arms a short-lived state that
  captures your next message — typed or **voice** — as the answer. `🔍` asks a one-shot Claude
  call to explain the decision in plain language without touching the session.
- Answers unblock the session in place — v2 does not end the session's turn and replay the
  conversation on every question (that would multiply subscription-quota burn). A crashed or
  restarted session instead resumes with `--resume` / `codex exec resume` (see
  [Recovery](#recovery--ops)).

### Grilling

Before an issue is dispatched, a **grilling** session (Claude) interrogates the design against
the actual repo — reading code first, not assuming. It **self-grills**: every question it can
settle by reading the repo, it answers itself and logs the reasoning as an assumption. It
escalates to you only **owner-class decisions** — product/UX choices, scope calls, irreversible
actions, or anything with no repo precedent — via the same ask_owner relay, with no cap on how
many it can ask. The session always ends by asking **which engine** (codex, the default, or
claude) and **which effort** (low/medium/high) to implement with, recommending both, then the
issue goes straight to `ready`.

### Dispatch

Dispatching an issue spawns an implementation session on a **ready** issue. The default engine
is **codex**, run via the bundled CLI at `/Applications/Codex.app/Contents/Resources/codex`
(overridable per issue with an `engine:claude` label, or live via `/tiers engine`). Codex runs
`workspace-write` with **network access off** — a prompt-injected implementer can't exfiltrate
over the network — and there is exactly **ONE global codex slot**: concurrent `codex exec`
processes sharing one auth store can race and invalidate each other's ChatGPT-subscription
tokens, so autopilot drains the ready queue through codex one at a time (parallelism instead
comes from Claude sessions, which use a separate auth store). The bot itself — never a sandboxed
session — does the `git push` and `gh pr create` once a session finishes.

### The finisher

Tapping **✅ Merge** on a finished PR is an *intent* ("couch-merge"), not a git command. The
pipeline then does whatever is actually required, in order: resolve conflicts → cross-engine
audit (the engine that reviews is always the *other* engine from the one that implemented, so
the reviewer doesn't share the author's blind spots) → wait for CI green, with one automatic
fix-up session if it's red → merge. Each stage gets **exactly one retry**; a second failure at
any stage parks the issue `blocked` with a plain-language reason in the ledger instead of looping
unattended.

### Autopilot

With autopilot off (the default), a freshly-grilled issue arrives with a **🚀 Dispatch now**
button, and `/dispatch rn#42` dispatches any `ready` issue on demand — owner taps skip the
courtesy gates below but never the safety bounds (session cap, single codex slot).

`/auto on` lets the bot drain the `ready` queue on its own; `/auto off` (default) stops it. It's
gated, not a free-for-all:

- **Session cap** — won't exceed `hermes.sessionCap` concurrent sessions.
- **Load / memory** — skips a tick if load-per-core or free memory crosses
  `hermes.autopilot.maxLoadPerCore` / `minFreeMemMB`.
- **HID idle ("owner at keyboard → yield")** — a courtesy gate, not a safety gate: if you've
  touched the keyboard within `hermes.autopilot.hidIdleMinutes`, autopilot yields the machine
  to you.
- **Daily dispatch budget** — `hermes.autopilot.dailyBudget` caps how many issues autopilot
  dispatches per day.

`/auto` with no argument reports current status: on/off, today's dispatch count, running
sessions, and pending questions.

### Filing and chat

- **`/file <text>`** — describe a bug or idea (text or voice) and Hermes shapes it into a
  GitHub issue with `needs-grilling`, asking which repo if it's ambiguous.
- **`/gh <question>`** — a read-only one-shot chat over the repos' issues (defaults to "what's
  open?" with no argument) — for quick lookups without opening GitHub.

### `/tiers` — job → model table

`/tiers` alone prints the current job→model table plus the default engine; `/tiers <job>
<model>` changes one job's model live (persisted in prefs, not `config.json`); `/tiers engine
codex|claude` changes the default engine. Default tiers (`hermes.tiers` in `config.json`):

| Job | Default model |
|---|---|
| `digest` | haiku |
| `prose` | sonnet |
| `grilling` | opus |
| `audit` | opus |
| `implementation` | codex |

All of it runs on **subscriptions** — Claude via your `claude` subscription, codex via the
Codex.app CLI's ChatGPT subscription — never the metered API (`ANTHROPIC_API_KEY` is stripped
before every invocation, same as v1).

## Commands

`/lang`, `/model`, `/new`, `/me`, `/again`, `/help`, the coding commands (`/code`, `/codestatus`,
`/stop`), and the v2 commands (`/auto`, `/tiers`, `/file`, `/gh`, `/dispatch`) are bot-handled; anything else
falls through to the read-only concierge. Paste this into **BotFather** (`/setcommands`):

    status - Board snapshot: counts, reviews, agent states
    needs - What needs you now, with one-tap links to act
    recent - What happened lately across the org
    today - What shipped or changed today
    issue - Look up an issue, e.g. /issue HOM-27
    find - Search issues by keyword, e.g. /find landing
    agents - Agent run-states: idle, running, or error
    accept - Accept a card (YES confirm), e.g. /accept HOM-27
    reject - Reject a card with a reason, e.g. /reject HOM-27
    new - Start a fresh chat (clear earlier context)
    again - Re-run your last question on fresh data
    me - Show current model, voice language, and chat
    lang - Voice language: /lang he | en | auto
    model - Claude model: /model haiku | sonnet | opus
    code - Start a coding session (pick repo, model, effort)
    codestatus - Show the running coding job, if any
    stop - Cancel the running coding job
    dispatch - Dispatch a ready issue now, e.g. /dispatch rn#42
    auto - Autopilot: /auto on | off (drain ready issues)
    tiers - Job-to-model tiers: /tiers, or /tiers <job> <model>
    file - File a bug or idea as a GitHub issue, e.g. /file the search box is broken
    gh - Ask about the repos' issues, e.g. /gh what's blocked
    help - What you can ask Hermes

## Setup (one time)

1. **Clone, install, make your config files** (same as before):
   ```sh
   git clone git@github.com:lemun/hermes-relay.git
   cd hermes-relay
   npm install
   cp config.example.json config.json   # non-secret structure
   cp .env.example .env                  # secrets go here
   ```

2. **`gh` CLI, authenticated.** Hermes v2 uses `gh auth token` for GitHub REST access and the
   bot's own `git push` / `gh pr create` after a session finishes:
   ```sh
   gh auth login
   gh auth status   # confirm before enabling hermes.enabled
   ```

3. **Codex CLI.** Point `hermes.codexBin` at the bundled CLI inside Codex.app (default
   `/Applications/Codex.app/Contents/Resources/codex`) and make sure it's logged into your
   ChatGPT subscription — this is what implementer sessions run by default.

4. **Fill in the `hermes` block in `config.json`** — see [`config.example.json`](config.example.json)
   for the full shape (`repos`, `defaultEngine`, `codexBin`, poll cadence, `sessionCap`,
   `autopilot`, `tiers`, `morningDigestHour`). `repos` is the allowlist: each entry needs a
   local `path` **and** a `slug` (`owner/name`) for GitHub REST calls.

5. **Enable it — fail-closed by design:**
   ```jsonc
   "hermes": { "enabled": true, ... }
   ```
   plus a configured `TELEGRAM_CHAT_ID` in `.env` — **required**. With no chat id, every
   Telegram surface fails closed and refuses everyone; with `hermes.enabled: false` (the
   default), the v2 hub never even constructs, so a disabled hub costs nothing.

6. **Verify:** `npm run check` prints whether hermes is ON and which repos are allowlisted,
   alongside the existing token/webhook/coding checks.

7. **launchd.** The plists now invoke `launchd/run-node.sh`, a small wrapper that sources `nvm`
   at run time and resolves `node` from your default alias, instead of baking a version-pinned
   nvm path into the plist `PATH` (that broke silently on every `nvm install`). Two other
   details matter if you hand-edit a plist:
   - `KeepAlive` is `{ "SuccessfulExit": false }`, **not** a bare `true` — a bool-`true` job
     restarts even after a deliberate clean exit, so the bot could never stop itself on
     purpose (a clean `exit 0` is meant to **stop** the service, not trigger a relaunch).
     `ThrottleInterval` is 30s.
   - `ExitTimeOut` is 30 — the window the bot's SIGTERM handler gets to checkpoint (flush
     coalesced ledger edits, persist state) before launchd escalates to SIGKILL.
   ```sh
   cp launchd/com.example.*.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.hermes-bot.plist
   ```

## Architecture

Hermes v2 is a bot-as-hub design: the bot process owns one long-lived hub object (the ratification
relay, session launch/finalize, the REST+ETag poll watcher, autopilot, the finisher pipeline);
durable state lives on the GitHub issue (labels + ledger comments), so the hub is fully
rebuildable from GitHub on every restart. See [docs/architecture.md](docs/architecture.md) for the
binding module contracts and [docs/adr/](docs/adr/) (0001–0005) for the reasoning behind the
harder calls — blocking `ask_owner` with resume as fallback, REST+ETag polling instead of `gh
issue list`, the bot owning push/PR while codex runs network-off, detached+reconciled sessions
instead of supervised ones, and the single global codex slot.

Local state (`state/`, single writer: the bot) is small and disposable:

- `hermes-sessions.json`, `hermes-questions.json`, `hermes-etags.json`, `hermes-finisher.json`,
  `hermes-plans.json`, `hermes-autopilot.json`, `hermes-inbox.json`, `hermes-hub-prefs.json` —
  session records, pending questions, per-repo issue/ETag cache, finisher stage state, autopilot
  on/off + daily counter, the pinned inbox message id, and runtime-overridable tier/engine prefs.
- `hermes-ask.sock` — a local unix socket the ask-server listens on for the `ask_owner` MCP tool
  (see [SECURITY.md](SECURITY.md)).

Each session's own output lives under `logs/sessions/<id>/` (`out.jsonl`, `err.log`,
`last-message.txt`) — separate from the bot's own `logs/hermes.log`.

## Recovery / ops

Sessions are **disposable** — nothing durable lives inside one, everything is in the ledger
comment or `state/`. When the bot restarts:

- It reconciles every persisted session by `kill -0`-ing the recorded PID. Survivors keep
  running; the dead ones that finished while the bot was down get finalized from their output
  files. The truly dead-mid-run ones become `orphaned` and are resumed — `claude -p --resume
  <session-id>` or `codex exec resume <thread-id>` — from the **same worktree** they started in.
- A worktree with a pending question is **never pruned** — resume only works from the original
  working directory, so pruning it would strand the session permanently.
- If a session was blocked on a question when the bot went down, the inbox re-surfaces that
  question's card rather than resuming immediately; resume happens once you answer.
- The inbox rebuilds itself from issues carrying the `waiting-input` label, so a lost
  `hermes-inbox.json` self-heals from GitHub rather than needing manual repair.
- A crash counter tracks restarts in the last hour; five or more triggers a warning to Telegram
  so a restart storm doesn't fail silently.

## Paperclip bridge (v1, dormant unless configured)

The original bridge still runs, unchanged, alongside v2 — it's a separate product (the live
Paperclip AI company board) with its own opt-in gates:

- **`notifier.mjs`** polls the Paperclip loopback API and pushes an **ntfy** alert to your phone
  when the board needs you: a new pending `request_confirmation` card, or an agent entering
  `error`. Outbound-only; works over cellular.
- **The concierge** (part of `hermes-bot.mjs`) is a read-only Telegram texting layer over the
  Paperclip board: DM it and it runs your message through `claude -p` (subscription, never the
  metered API) with a read-only board MCP attached, replying by text or voice.
- **Confirm-gated accept/reject** (`accept HOM-27` / `reject HOM-27 <reason>`) is built and
  fail-closed behind `PAPERCLIP_BOARD_API_KEY` — empty key ⇒ read-only, degrading to a
  tap-through link instead of a direct write.
- **Interactive pending-card push** (`lib/push.mjs`) — Hermes itself watches the board and texts
  you inline `✅ Approve` / `✖️ Reject` / `ℹ️ Tell me more` buttons on new cards, routing into the
  exact same confirm + TOCTOU-checked write gate as typing `accept HOM-27`.
- **Coding mode** (`/code`, opt-in, off by default) starts a real write-enabled Claude Code
  session against your own repos (not Paperclip) in an isolated git worktree on a `phone/*`
  branch, streaming progress to Telegram and offering a one-tap **Push & open PR** button.

None of this is going away — see the original setup steps below for prerequisites (voice models,
Tailscale exposure, ntfy) and the command reference. `hermes.enabled` and `coding.enabled` are
independent flags; you can run either, both, or neither.

### v1 setup essentials

- **Prerequisites:** macOS + Node 18+, the `claude` CLI logged into your subscription, a running
  Paperclip instance on `http://127.0.0.1:3100`. Voice notes need `ffmpeg` + `whisper.cpp` and two
  GGML model files (optional — text DMs work without them).
- **Secrets** live in `.env` (gitignored): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `NTFY_TOPIC`,
  optional `NTFY_SERVER`, optional `PAPERCLIP_BOARD_API_KEY` (enables accept/reject writes).
- **Smoke-test:** `npm run check` (Telegram token + webhook), `npm run notifier:once`, then
  `npm run hermes` and DM the bot "what needs me?".
- **Voice models:** `brew install ffmpeg whisper-cpp`, then download the Hebrew (`ivrit-ai`) and
  English/auto (vanilla `large-v3-turbo`) GGML models into `models/` — see the model URLs and
  `/lang he|en|auto` switch in [config.example.json](config.example.json)'s `_voice` comment.
- **Tailscale tap-through:** the bridge itself only needs loopback; the notifier's "open this
  card" link and Hermes' read-only fallback link need Paperclip's UI reachable on your **tailnet**
  (`uiBaseUrl` in `config.json`). Use `tailscale serve`, never `funnel` — see
  [SECURITY.md](SECURITY.md) and the git history of this README for the full walkthrough if you
  need to re-expose it.
- **Coding mode:** set `coding.enabled: true` and fill `coding.repos` (path + label per
  selectable repo) and `coding.worktreeBase`; requires `TELEGRAM_CHAT_ID` (the bot refuses to
  start otherwise) and, for the push-button PR flow, an authenticated `gh` CLI.

### v1 commands quick reference

`/lang`, `/model`, `/new`, `/me`, `/again`, `/help`, `/code`, `/codestatus`, `/stop` are
bot-handled; everything else falls through to the concierge. Full BotFather list is in the
[Commands](#commands) section above (it now includes both v1 and v2 entries).

```
/code                      # start the wizard: pick repo → model → effort → send the task
/code fix the flaky test   # same, pre-filled task
/codestatus                # what the running job is doing + elapsed time
/stop                      # cancel the running job (partial work is committed + summarized)
/code again <follow-up>    # resume the last session in the same worktree to iterate
```

> Note: coding mode needs a recent `claude` CLI (developed against **v2.1.179**) for the
> `--effort`, `--permission-mode bypassPermissions`, and `stream-json` flags.

## Notes / knobs (`config.json`)

- `pollSeconds` — v1 notifier poll cadence (default 45s).
- `claudeModel` — v1 concierge model (default `claude-sonnet-4-6`).
- `uiBaseUrl` — your Tailscale URL to the Paperclip UI for tap-through links.
- `companyId` — your Paperclip company UUID.
- `transcribeLanguage`, `whisperBin`, `whisperModelHe`, `whisperModelMulti`, `ffmpegBin` — voice
  transcription paths and default language.
- `coding` — v1 opt-in coding mode: `enabled`, `repos`, `worktreeBase`, `defaultModel`,
  `defaultEffort`, `jobTimeoutMs`, `worktreeRetentionDays`.
- `push` — v1 interactive pending-card push: `enabled` (default true), `pollSeconds` (default 60).
- `health` / `selfcheck` — v1 notifier watchdog and independent self-health probe.
- `hermes` — v2 pipeline block: `enabled` (default **false**), `repos` (path + `slug` per repo),
  `defaultEngine`, `codexBin`, `pollActiveSeconds`/`pollIdleSeconds`, `askSock`, `askTimeoutHours`,
  `sessionCap`, `autopilot.{dailyBudget,maxLoadPerCore,minFreeMemMB,hidIdleMinutes}`, `tiers`,
  `morningDigestHour`. Full shape and comments in [config.example.json](config.example.json).

**Logs grow unbounded.** Both services log to `logs/*.log` 24/7, plus `logs/coder.log` per v1
coding job and `logs/sessions/<id>/` per v2 session. There's no built-in rotation — add a
`newsyslog.d` entry or periodically truncate if you run these long-term.

## Self-monitoring (the watcher watches itself)

The bridge's whole job is to break silence — so it must not fail silently itself. Two layers,
unchanged from v1:

- **Notifier health watchdog** (`deriveHealth` in `lib/paperclip.mjs`, escalation in
  `notifier.mjs`): re-pages on a sticky-error curve (1h then daily) and on a stuck-`running`
  agent, instead of pinging once and going silent. Dry-run: `node notifier.mjs --once --dry-run`.
- **Self-health probe** (`selfcheck.mjs`, launchd `StartInterval` one-shot): pages **directly via
  ntfy** if the Paperclip API is down or the notifier's heartbeat file is stale — so a dead or
  wedged notifier can't suppress its own alarm. Dry-run: `npm run selfcheck:dry`.

## Troubleshooting — "the bot doesn't answer"

Run `npm run check`. It does a Telegram `getMe`, clears any stale webhook (a set webhook makes
`getUpdates` return 409 and the bot never sees your messages), and reports whether coding and
hermes are ON and which repos are allowlisted for each. Common causes:
- **Token empty/typo** → `check` says token rejected. Fix `TELEGRAM_BOT_TOKEN` in `.env`.
- **A webhook was set** → `check` clears it; restart `npm run hermes`.
- **Process not running** → it must stay running (use the launchd service for 24/7).
- **Voice note says "model not downloaded yet"** → grab the models into `models/` (see v1 setup).
- **v2 pipeline seems stuck** → check the issue's ledger comment first (it's the system of
  record); `logs/hermes.err.log` and `logs/sessions/<id>/err.log` have the raw session output.
- Watch `logs/hermes.err.log` for `getUpdates not ok` lines.

## Try Hermes

> what needs me right now?
> why is eng-lead in error?
> summarize HOM-27
> what shipped today?
> status

**Memory:** say "remember …" (or "note that …", "for next time …") and Hermes saves a durable,
one-line note via its `remember` tool. Notes live in `state/hermes-memory.md` (append-only).
Recall is **pull-based**: Hermes reads its notes back on demand via a separate `recall` tool (a
tool result it reads, never spliced into its system prompt), so a note that a prompt-injected
board entry tricked it into saving can never become a standing system instruction. It's the one
write the read-only concierge is allowed — it touches that file and nothing else.

## Roadmap (not built — deliberately deferred)

- **More board writes (comment, status, reassign):** `lib/paperclip-write.mjs` deliberately
  exposes only `accept`/`reject` today.
- **Unattended v1 board autonomy:** a confirm tap is convenience-while-present, not
  autonomy-while-away for the Paperclip board specifically (v2's autopilot is the analogous
  autonomy surface for the GitHub pipeline, and it ships with load/idle/budget gates already).
- **True hands-free Paperclip actions:** Hermes calling Paperclip's write API itself behind a
  Telegram confirm, without a human re-checking the card. Deferred on purpose.

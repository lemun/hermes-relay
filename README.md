# Hermes

Hermes is a private Telegram control plane for a GitHub-issue delivery pipeline. It relays owner decisions, dispatches allowlisted work, tracks sessions and finishers, and can run an optional legacy coding workflow in isolated Git worktrees.

The repository is intentionally single-purpose. It has one long-running service (`com.example.hermes-bot`), one authenticated Telegram channel, and no secondary notification provider or board integration.

## Security boundary

- Every Telegram message and callback must come from the exact configured private chat ID and sender user ID.
- Sensitive actions require a short-lived TOTP step-up and single-use callback capability.
- Startup is locked after first install, state loss, or an emergency lock. Unlock is local-only.
- Config, state, logs, sockets, backups, and temporary files are owner-only.
- Child processes receive explicit environment allowlists rather than the service environment.
- Lockdown generation is rechecked before deferred actions, pushes, and finalization.
- A singleton lock prevents two Telegram pollers from consuming the same bot updates.

This is still host-capable software. If coding or session modes are enabled, an authorized action can cause local child processes to run. Use a dedicated trusted macOS account/host, FileVault, screen lock, and narrowly scoped repository allowlists.

## Setup

Requirements: macOS, Node 18 or newer, `git`, `gh`, and the configured Codex/Claude CLIs for the lanes you enable.

```sh
npm ci
cp .env.example .env
cp config.example.json config.json
chmod 600 .env config.json
npm test
npm run security:check
```

Provision these values locally in `.env`; never paste them into chat or commit them:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `TELEGRAM_USER_ID`
- `HERMES_TOTP_SECRET`

Set repository paths/slugs and feature gates in `config.json`. Keep `coding.enabled=false` and `hermes.allowClaudeWriteSessions=false` unless their host risk is explicitly accepted.

## Commands

- `/status` — current GitHub delivery queue and owner actions
- `/gh <question>` — scoped GitHub issue question
- `/file <bug or idea>` — create an issue through the guided flow
- `/dispatch repo#issue` — start an approved ready issue
- `/auto on|off` — control bounded autopilot
- `/tiers` — inspect or change model tiers
- `/ops` or `/doctor` — read-only runtime health
- `/auth <TOTP>` — grant one sensitive action for two minutes
- `/lock` — emergency remote lockdown
- `/code`, `/codestatus`, `/stop` — optional legacy coding workflow
- `/lang he|en|auto` — local voice transcription language

Free text is not sent to a general host-side concierge. Use `/gh` for the scoped question path.

## Install and operate

Render the single LaunchAgent from the live checkout:

```sh
npm run install:update -- --root /absolute/path/to/live/checkout --dry-run
npm run install:update -- --root /absolute/path/to/live/checkout --apply
```

The apply step also removes the retired notifier/self-check plist files and the retired concierge MCP config if they are still present. Unload any still-running retired jobs before applying; `npm run live:check` fails while one remains loaded.

Then load or restart it with the local operator account. First deployment intentionally starts locked:

```sh
npm run security:control -- unlock
npm run live:restart
npm run live:check
```

The doctor is read-only and fails closed when critical deployment evidence is missing or unreadable:

```sh
npm run security:check
npm run security:check -- --json
```

See [docs/architecture.md](docs/architecture.md), [docs/hardening.md](docs/hardening.md), and [SECURITY.md](SECURITY.md) before enabling host-capable modes.

## Verification

```sh
npm test
npm audit --omit=dev
node --check hermes-bot.mjs
sh -n launchd/run-node.sh
plutil -lint launchd/com.example.hermes-bot.plist
git diff --check
```

Green tests are not a deployment proof. Rehearse locked restart, local unlock, authenticated Telegram/TOTP/callback flows, rollback, and live observation on the deployment host.

# Security model

This is a **single-user personal tool**. It runs on your own Mac under `launchd`, talks to a
loopback Paperclip API, and answers exactly one Telegram chat. Severity is calibrated to that.
There is no multi-tenant surface and no public network ingress.

## Trust boundaries

- **One authorized chat.** Every Telegram message and button is checked against
  `TELEGRAM_CHAT_ID` and **fails closed**: with no chat id configured, nobody is authorized
  (`isAuthorized` in `lib/paperclip.mjs`). With coding mode on, the bot refuses to start at all
  without a configured chat id.
- **Subscription auth, never the metered API.** `ANTHROPIC_API_KEY` is stripped from the
  environment before every `claude` invocation, so Hermes uses your Claude subscription.
- **The concierge is read-only by construction.** `claude -p` is launched with `--tools ""`,
  which disables *every* built-in tool (no `Read`/`Grep`/`Glob`/`Bash`/`Write`), leaving only the
  read-only board MCP tools. It runs in an empty sandbox cwd (`state/concierge-sandbox`), never the
  repo root. So a prompt-injected board entry cannot make the concierge read `.env`, run a command,
  or write a file. (Verified: a canary file read is refused while board reads still work.)
- **Board writes are fail-closed.** `lib/paperclip-write.mjs` is the only module that mutates the
  board, exposes exactly two hard-coded actions (accept / reject) with key-allowlisted bodies, and
  **throws without `PAPERCLIP_BOARD_API_KEY`**. Empty key ⇒ the bot degrades to a read-only deep
  link. Every write is confirm-gated (a YES button that echoes the card title) and re-checks the
  card is still pending right before mutating (TOCTOU guard).

## Coding mode is the one high-trust surface

Opt-in coding mode (`coding.enabled`, off by default) runs a real
`claude --permission-mode bypassPermissions` session. **This is arbitrary code execution on the
host**, by design. The git worktree isolates *file writes* to a throwaway branch — it does **not**
sandbox `Bash`, so a session can read or run anything your user account can. It is gated behind:
your single chat id, an explicit per-job confirm step, and a configured repo allowlist. Treat
turning it on as "I trust whatever I type/dictate to run on this machine."

## Secrets

All secrets live in `.env` (gitignored). Only `*.example.*` files are committed, and they ship
**placeholders** — never real values.

| `.env` key | what it grants if leaked |
|---|---|
| `TELEGRAM_BOT_TOKEN` | full control of the bot (the one real credential) |
| `TELEGRAM_CHAT_ID` | not secret; just the allowed recipient |
| `NTFY_TOPIC` | read your alerts **and** publish fake alerts to your phone |
| `PAPERCLIP_BOARD_API_KEY` | accept/reject cards on your live board |

### Rotate-and-scrub note (history)

Earlier commits of `.env.example` / `config.example.json` contained a real `NTFY_TOPIC`
(`REDACTED-TOPIC`), the live `companyId`, and a real Tailscale MagicDNS hostname.
Those values are in git history. If this repo is, or may ever become, non-private:

1. **Rotate the ntfy topic** to a fresh unguessable value in `.env` (the old one is burned).
2. Consider rotating the `TELEGRAM_BOT_TOKEN` via @BotFather if it was ever committed.
3. **Scrub history** with `git filter-repo` (or BFG) and force-push, then have any clone re-clone.

The Tailscale hostname and `companyId` are low-sensitivity (unreachable without being on your
tailnet), but rotate the topic regardless — it is an unauthenticated read+write channel.

## Reporting

It's a personal tool; "reporting" means: open an issue or just fix it. If you fork it and find a
real footgun in the shared logic, a PR is welcome.

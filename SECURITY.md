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
  - **Saved memory is pull-based, never system prompt.** Notes saved via `remember` are read back
    only through the `recall` tool — they come back as a *tool result* (data the model reads on
    demand), and are never injected into the concierge's system prompt. So a note that a
    prompt-injected board entry persuaded the model to "remember" stays untrusted data; it cannot
    become a standing system instruction of every future session (no data-plane → control-plane
    escalation).
- **Board writes are fail-closed.** `lib/paperclip-write.mjs` is the only module that mutates the
  board, exposes exactly two hard-coded actions (accept / reject) with key-allowlisted bodies, and
  **throws without `PAPERCLIP_BOARD_API_KEY`**. Empty key ⇒ the bot degrades to a read-only deep
  link. Every write is confirm-gated (a YES button that echoes the card title) and re-checks the
  card is still pending right before mutating (TOCTOU guard).
- **Proactive pending-card pushes are READ-side.** Hermes' interactive alert (`lib/push.mjs`)
  only *reads* the board to find new cards; its `[Approve]`/`[Reject]` buttons route into the
  **same** confirm + TOCTOU + fail-closed write gate as a typed `accept HOM-N` — they add no new
  write path. A stale button on an already-resolved card re-checks pending state fresh and answers
  "nothing pending" (safe to tap twice). The push only ever sends to the single authorized chat.

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

## v2 (Hermes pipeline)

The GitHub-issue pipeline (grilling → dispatch → finisher, see [README.md](README.md) and
[docs/architecture.md](docs/architecture.md)) adds new write surfaces on top of the same
single-chat trust model above. It is opt-in and fails closed the same way.

- **Session spawning is gated the same way coding mode is.** The whole v2 hub only constructs
  when `hermes.enabled` is true, and — same as coding mode — the bot refuses to run any
  session-spawning path without a configured `TELEGRAM_CHAT_ID`. Disabled is zero cost: no poll
  loop, no ask-server, no sessions.
- **Implementers are sandboxed; the bot owns push/PR.** Implementation sessions (default engine
  codex) run `workspace-write` with **network access off** (ADR-0003) — a prompt-injected
  implementer cannot exfiltrate anything over the network, and the local Codex CLI sandbox has
  no per-domain allowlist to lean on instead. `git push` and `gh pr create` are performed by the
  bot itself, from the worktree, after the session exits and only once — never by a sandboxed
  session, and uniformly across engines regardless of which one implemented.
- **Grillers and auditors are read-only static allowlists.** A grilling session gets read tools
  plus `mcp__hermes__ask_owner` and a scoped `Bash(gh …)` — no generic write access. The
  cross-engine audit session is likewise read-only; it can flag issues but not fix them itself
  (a flagged audit routes back to you via the finisher card, not straight to a retry).
- **`ask_owner` is a local socket, not a network service.** `hermes-ask-mcp.mjs` talks to the bot
  over HTTP on a **unix domain socket** (`state/hermes-ask.sock`, mode `0600`, bot is the server)
  — there is no TCP listener, so the relay is unreachable from anywhere except a process on this
  machine that can open that socket file.
- **Subscriptions only, same as v1.** `ANTHROPIC_API_KEY` is stripped before every `claude`
  invocation (griller/auditor sessions included); codex sessions run through the Codex.app
  bundled CLI's ChatGPT-subscription login. Nothing in v2 meters a pay-per-token API.
- **Injection posture: issue bodies are untrusted input to sessions.** A grilling or
  implementation session reads the full issue body (and prior ledger comments) as part of its
  prompt — treat that content as adversarial, the same way a board entry is treated as
  adversarial input to the v1 concierge. The containment is the **sandbox + no-network +
  allowlisted tools**, not any attempt to sanitize the issue text: even if a session is talked
  into a bad decision, it cannot push anywhere except its own throwaway worktree/branch, cannot
  reach the network from inside codex, and cannot call tools outside its static allowlist. Ledger
  comments themselves are **rendered, not executed** — `lib/ledger.mjs` parses them back into
  structured fields; nothing in the ledger format is ever interpreted as a command.

## Reporting

It's a personal tool; "reporting" means: open an issue or just fix it. If you fork it and find a
real footgun in the shared logic, a PR is welcome.

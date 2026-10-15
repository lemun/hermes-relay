# Hermes

> **Status: RETIRED (July 2026). Not maintained. Superseded.**
> This is a reference implementation published as history. It gets no fixes, no security
> updates and no support. Issues and pull requests will not be answered.

Hermes was a phone-first approval loop for agent coding sessions. A Telegram bot, used by one
person, sat over a GitHub-issue pipeline: it relayed the decisions only the owner could make to
the owner's phone, carried the answers back into the live session, dispatched allowlisted
Claude/Codex work into isolated Git worktrees, and ran a gated finisher that took a pull request
from "open" to "merged".

It was built by one developer to ship a small consumer app, a React Native and Next.js
app, and ran from June to July 2026. It was replaced by a lighter setup that kept the control and
dropped most of the apparatus. The write-up is the case study
[Hermes: the issue board I ran from my phone](https://shaisinai.com/work/hermes).

## Safety statement

**Hermes runs host-side coding agents from chat.** An authorized Telegram message can cause local
child processes (Claude Code, Codex, `git`, `gh`) to run on the machine that hosts the bot, with
that account's files and credentials within reach. Compromise of the Telegram account, the bot
token, the TOTP seed, the host account, the GitHub credentials or the repository allowlist is a
path to those host resources.

Do not run it unless you understand that threat model, and then only on a dedicated, trusted macOS
account with FileVault and screen lock, narrow repository allowlists, and the host-capable modes
(`coding.enabled`, `hermes.allowClaudeWriteSessions`) left off. Read [SECURITY.md](SECURITY.md) and
[docs/hardening.md](docs/hardening.md) first. Running the test suite is safe: it is hermetic and
starts no bot, no agent and no network client.

## What it did

- **The issue is the runtime.** Each piece of work lived in a GitHub issue moving through a small
  label vocabulary (`needs-grill`, `grilling`, `waiting-input`, `ready`, `implementing`, `pr-open`,
  `finishing`, `blocked`). Sessions were disposable; the issue was the system of record.
- **Ledger comment.** Every session kept one structured comment on its issue, edited in place:
  decisions, assumptions, questions, answers, a handoff note and the outcome
  ([lib/ledger.mjs](lib/ledger.mjs)). A fresh session could resume from it.
- **Split by job.** A grilling session interrogated an issue and escalated only owner-class
  questions; an implementer worked one repository on one branch; a finisher resolved conflicts,
  got a cross-engine audit from the engine that had not written the code, waited for CI, and
  merged only if all of that held. One retry per failing stage, then `blocked` with a reason.
- **Ratification relay.** Agents asked through a local MCP tool (`ask_owner`,
  [hermes-ask-mcp.mjs](hermes-ask-mcp.mjs)); the question arrived on the phone with a recommended
  answer and one-tap buttons, and the answer unblocked the waiting session.
- **Telegram commands:** `/status`, `/gh <question>`, `/file <bug or idea>`, `/dispatch repo#issue`,
  `/auto on|off`, `/tiers`, `/ops` or `/doctor`, `/auth <TOTP>`, `/lock`, `/lang he|en|auto`, `/me`,
  `/help`, plus the optional legacy `/code`, `/codestatus`, `/stop`. Voice notes were transcribed
  locally with whisper.cpp.

The vocabulary is in [CONTEXT.md](CONTEXT.md), the module contracts in
[docs/architecture.md](docs/architecture.md), and the decisions in [docs/adr/](docs/adr/).

## Security model

- **One authorized operator.** Every message and callback must come from the exact configured
  private chat ID and sender user ID. Possessing the phone is not authority.
- **Step-up for sensitive actions.** RFC 6238 TOTP plus a short-lived, single-use capability bound
  to identity, action, repository, target, message and, where relevant, the live commit SHA
  ([ADR 0006](docs/adr/0006-step-up-action-authorization.md)).
- **Approval is about one commit.** A push or merge button is bound to the head SHA it was issued
  against; the worktree HEAD is re-checked before pushing, the push names the commit explicitly,
  and the merge call passes the audited SHA so GitHub refuses it if the head moved.
- **Lockdown is fail-closed.** First install, state loss or `/lock` starts locked. Locking works
  from the phone; unlocking is local-only. Deferred work re-checks the lockdown generation.
- **Children see less.** Host-capable child processes get an explicit minimal environment
  allowlist instead of the service environment. Codex write sessions run network-off, and the bot,
  not the session, pushes and opens the PR
  ([ADR 0003](docs/adr/0003-bot-owns-push-and-pr-codex-sandbox-closed.md)).
- **Private storage.** Config, state, logs and sockets are owner-only, written atomically, with
  symlink defenses. A singleton lock prevents two pollers consuming the same updates.
- **A read-only doctor** (`npm run security:check`) fails closed when critical deployment evidence
  is missing or unreadable.

## The lesson

A July 2026 security review found that the finisher's CI stage read check state as three counts
that each defaulted to zero when the response was missing. An API error or an unparseable answer
therefore looked like "no checks, none pending, none failed", and the pipeline fell through to
merge, in the stage that was meant to be the last gate. The fix in
[lib/finisher.mjs](lib/finisher.mjs) (`nextFinisherStep`) makes an unavailable or malformed
response a wait, not a pass; the same commit binds an audit approval to the head SHA it approved.
The regression tests are `nextFinisherStep: unavailable or malformed CI state waits instead of
merging` and `nextFinisherStep: approved audit is reset when PR head changed` in
[tests/finisher.test.mjs](tests/finisher.test.mjs).

The general point: a gate can be present, wired in and tested, and still answer with confidence in
the one case where it has nothing to answer with. Treat "absent" and "empty" as different states.

## Running the tests

Requirements: Node 22 or newer and npm. The suite is hermetic (fetch-mocked or tmpdir-based): no
Telegram, GitHub, model CLIs or secrets are needed.

```sh
npm ci
npm test                  # node --test, 562 tests
npm audit --omit=dev
node --check hermes-bot.mjs
sh -n launchd/run-node.sh
```

On macOS you can also lint the LaunchAgent template with
`plutil -lint launchd/com.example.hermes-bot.plist`.

## How it was deployed (historical)

It ran as a single per-user LaunchAgent (`com.example.hermes-bot`, rendered from
[launchd/](launchd/) by `npm run install:update`) on a dedicated Mac, with secrets in an
owner-only `.env` (see [.env.example](.env.example)) and repositories and feature gates in
`config.json` (see [config.example.json](config.example.json); `OWNER/example-app` and the
`/path/to/...` paths are placeholders). Deployment and rollback procedure, the security
doctor and the local unlock flow are described in [docs/hardening.md](docs/hardening.md) and
[SECURITY.md](SECURITY.md). It is not recommended to deploy it; see the safety statement above.

The `security:retire-paperclip` script and the `retired*` service labels are a one-time migration
away from an earlier board integration and are kept only because the tests cover them.

## License

No license is granted. The source is published for reference only; all rights reserved.

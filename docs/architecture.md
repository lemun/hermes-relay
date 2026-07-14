# Hermes v2 architecture contracts

Binding contracts between modules. Vocabulary from [CONTEXT.md](../CONTEXT.md); decisions from
[docs/adr/0001–0005](adr/). The GitHub issue is the continuity; sessions are disposable; the bot
is a hub, not a bus.

## Label vocabulary (GitHub issue labels)

`lib/labels.mjs` is the code source of truth for required repository labels; this table is the
human-readable contract.

| Label | Meaning |
|---|---|
| `needs-grill` | Filed, awaiting a grilling session |
| `grilling` | Grilling session in flight |
| `waiting-input` | ≥1 question pending for the owner (coexists with `grilling`/`implementing`; inbox rebuilds from this on recovery) |
| `ready` | Ratified, awaiting dispatch |
| `implementing` | Implementation session in flight |
| `pr-open` | PR exists, awaiting the finisher pipeline |
| `finishing` | Finisher pipeline in flight (conflict-resolve → audit → CI → merge) |
| `blocked` | Parked with a plain-language reason in the ledger comment |
| `engine:codex` / `engine:claude` | Per-issue engine override (default codex) |

## State files (`state/`, atomic writes via `writeJsonAtomic`, single writer: the bot)

- `hermes-sessions.json` — `{ sessions: [SessionRecord] }`. Persisted **before** any question can
  flow (ADR-0004). SessionRecord:
  ```js
  { id: "sess-<shortid>", role: "griller|implementer|auditor|fixer|resolver",
    engine: "claude|codex", repoKey, issue, pid, caffeinatePid,
    worktree, branch, engineSessionId,   // claude session_id (we mint via --session-id) or codex thread_id (parsed from first --json event)
    outFile, errFile, lastMessageFile,   // absolute paths under logs/sessions/
    status: "running|done|failed|orphaned", startedAt, endedAt,
    ledgerCommentId }                    // GitHub comment id, null until first write
  ```
- `hermes-questions.json` — `{ questions: [Question] }`:
  ```js
  { id: "q-<shortid>", sessionId, repoKey, issue, question, recommended, context,
    status: "pending|answered|expired", answer, askedAt, answeredAt, tgMessageId }
  ```
- `hermes-inbox.json` — `{ pinnedMessageId, lastDigestDate }`
- `hermes-etags.json` — `{ [repoKey]: { etag, issues: [...], fetchedAt } }` (last known open issues per repo)
- `hermes-autopilot.json` — `{ enabled, dispatched: { date: "YYYY-MM-DD", count } }`
- `hermes-prefs.json` (existing) gains `hermes: { defaultEngine, tiers }` for runtime-switchable
  defaults (`/tiers`).

## ask_owner relay protocol (ADR-0001)

`hermes-ask-mcp.mjs` is a **local stdio MCP server** (name `hermes`, one tool `ask_owner`)
spawned by engine sessions. It talks to the bot over HTTP on a unix domain socket
(`state/hermes-ask.sock`, 0600, bot is the server):

- `POST /ask` body `{ sessionKey, question, recommended, context }` → `{ id }`.
  Bot handler order (binding): persist Question to disk → ensure ledger comment carries
  engineSessionId + worktree (immediate write, not coalesced) → send Telegram question card →
  respond.
- `GET /answer/<id>` → `{ status: "pending" }` or `{ status: "answered", answer }`.
  The MCP server polls every 5s and blocks the tool call until answered or its deadline
  (`HERMES_ASK_TIMEOUT_MS`, default 8h) → then returns an error result instructing the session to
  checkpoint into the ledger and exit (resume fallback picks it up).

Session identity reaches the MCP server via env: `HERMES_SESSION_KEY`, `HERMES_SOCK`,
`HERMES_ASK_TIMEOUT_MS`. Tool schema: `ask_owner({ question, recommended, context? }) → answer text`.
Every question ships a recommended answer. ask_owner is a plain tool call — never MCP elicitation
(codex `approval_policy=never` auto-rejects elicitations); never flagged `requiresUserInteraction`.

Timeouts: claude side sets per-server `"timeout"` in the session's generated MCP config; codex side
sets `-c mcp_servers.hermes.tool_timeout_sec=28800` (default is 60s).

## Ledger comment (one per session, edited in place, coalesced ≥5s — ADR-0002)

Machine header + fixed sections; `lib/ledger.mjs` renders from an object and parses back:

```markdown
<!-- hermes-ledger v1 session=sess-abc123 -->
### Hermes session `sess-abc123` — implementer · codex
**Status:** running | waiting-input | done | failed | blocked
**Worktree:** `<path>` · **Engine session:** `<id>` · **Branch:** `<branch>`

#### Decisions
#### Assumptions          <!-- lines of `assumed: X because Y` -->
#### Questions            <!-- [q-id] asked <t> — "…" → answered <t>: "…" -->
#### Handoff note         <!-- compact; lets a fresh session continue without re-exploring -->
#### Outcome              <!-- PR link, or parked reason -->
```

## GitHub access (ADR-0002, ADR-0003)

`lib/gh.mjs` uses native `fetch` with a token from `gh auth token` (cached; re-fetched on 401) —
REST v3 only, honoring ADR-0002's REST+ETag mandate; never `gh issue list`/GraphQL.
Poll: `GET /repos/{slug}/issues?state=open&per_page=100` with `If-None-Match`; 304 = free no-op;
filter labels locally. Cadence: 30s while sessions run or questions pend, 3min idle; guard with
free `/rate_limit`; back off on 403/429 Retry-After. Ledger comment edits coalesce ≥5s.
The bot (never a sandboxed session) does `git push` + `gh pr create`.

## Engine sessions (ADR-0003/0004/0005)

- Spawn `detached: true`, own PGID, `stdio: ["ignore", outFileFd, errFileFd]`, `unref()`;
  `caffeinate -i -w <pid>` alongside (also detached).
- claude: `claude -p <prompt> --output-format stream-json --verbose --session-id <minted-uuid>
  --model <m> --mcp-config <generated per-session file> --allowedTools <static whitelist>`
  (grillers/auditors: local read tools + `mcp__hermes__ask_owner` + the structured,
  repo-allowlisted `mcp__github_read__*` tools; no Bash. Implementers get write tools via
  `--permission-mode bypassPermissions` like lib/coder.mjs, but those Claude write lanes are
  disabled unless the trusted-host opt-in is set). Resume:
  `claude -p --resume <session-id> "<msg>"` from the **same cwd** (never prune a worktree with a
  pending question).
- codex: `codex exec -C <worktree> -s workspace-write -c approval_policy=never
  -c sandbox_workspace_write.network_access=false -c mcp_servers.hermes.command=… (+env, +tool_timeout_sec)
  --json -o <lastMessageFile> <prompt>` — binary at `cfg.hermes.codexBin`
  (`/Applications/Codex.app/Contents/Resources/codex`, 0.142.5). thread_id = first `--json` event.
  Resume: `codex exec resume <thread_id>`. **Empty stdout + empty last-message + exit 0 = failure**
  (bug #19945): retry once wrapped in `script -q /dev/null …` (macOS syntax).
- Codex global slot = 1 (ADR-0005). Parallelism comes from claude sessions; total concurrent cap
  default 6.
- Startup reconcile: `kill -0` each persisted pid; dead + incomplete → `orphaned`, resume from
  recorded worktree once its pending question (if any) is answered.

## Config (`config.json` → `hermes` key; env wins where noted)

```jsonc
"hermes": {
  "enabled": false,                    // master gate for the GitHub pipeline
  "repos": { "rn": { "path": "…", "slug": "lemun/example-app", "label": "…" }, … },
  "defaultEngine": "codex",
  "allowClaudeWriteSessions": false,
  "codexBin": "/Applications/Codex.app/Contents/Resources/codex",
  "pollActiveSeconds": 30, "pollIdleSeconds": 180,
  "askSock": "state/hermes-ask.sock", "askTimeoutHours": 8,
  "sessionCap": 6,
  "autopilot": { "dailyBudget": 10, "maxLoadPerCore": 0.8, "minFreeMemMB": 1024,
                 "hidIdleMinutes": 10 },   // enabled flag lives in state, toggled by /auto
  "tiers": { "digest": "haiku", "prose": "sonnet", "grilling": "opus", "audit": "opus" },
  // runtime-overridable via /tiers → prefs; values are model aliases only
  "morningDigestHour": 8
}
```

## Telegram surface

- **Inbox**: one pinned message, edited in place (`🔔 N waiting` + one line per question), never
  unpinned/re-pinned. Notification sound only on 0→1; all other sends `disable_notification`.
  Morning digest at `morningDigestHour`.
- **Question card** per question: question + recommended answer;
  buttons `✅ <recommended>` / `❌ Other` / `🔍 Explain` (callback_data `ask:yes:<qid>` etc.,
  ≤64 bytes → short ids). `❌` arms a prefs state machine awaiting free text/voice; voice replies
  are first-class (existing transcription path).
- **Finisher card**: `✅ Merge` = intent, launches the finisher pipeline, not a git command.
- Commands: `/auto on|off`, `/tiers`, `/file <text>`, plus existing v1 commands unchanged.

### Telegram surface policy

Hermes has four Telegram surfaces. Pick the smallest surface that still gives the owner the right
action affordance:

| Surface | Use for | Do not use for |
|---|---|---|
| Fresh phone card | Owner intent or urgent breakage: owner questions, audit/merge decisions, repo choice during `/file`, and crash storms at the alert threshold. | Routine lifecycle progress, background session output, or repeated crash-health noise after the initial storm warning. |
| Edited status message | Lifecycle noise for a command or session: grilling started, dispatched, PR opened, audit started, fixer started, parked, merged, or failed. | Decisions that need a tap, free-text owner input, or separate long-running `/gh` result chunks. |
| Pinned inbox | Owner-action queue only: pending questions and pending audit/merge decisions. | Running sessions, fixer summaries, command progress, or already-answered decisions. |
| Digest / silent log | Non-urgent rollups and durable context: morning digest, quiet session bookkeeping, repeated health updates after a crash warning, and background notes that should not buzz the phone. | Anything that is blocked on immediate owner intent or an urgent breakage threshold. |

Reusable rule: a new card means "the owner should notice and decide now." An edited status means
"Hermes is continuing the same thread of work." The pinned inbox means "these are the owner actions
still waiting." A digest or silent log means "record this without interrupting."

Manual commands may answer immediately. Multi-step commands should create or reuse one command/status
message and edit it as the command advances. `/gh` may stream chunks because it is an explicit owner
query and can return owner-facing source material rather than lifecycle noise.

Crash warnings send one fresh card when the storm threshold is crossed. After that, Hermes updates one
health/status message or records silent log entries until the condition clears or crosses a new owner
decision threshold.

#### Telegram surface examples

| Case | Before | After |
|---|---|---|
| Question | A session posts a fresh question card and also sends separate "waiting for owner" status cards. | Send one fresh question card with answer buttons, add it to the pinned inbox, and keep any session lifecycle note in the edited ledger/status message. |
| Audited PR approved | Audit result, merge prompt, and "ready to merge" each arrive as separate phone cards. | Send one fresh finisher/merge decision card because owner intent is required; keep supporting audit detail in the card text or linked ledger, and list the pending merge decision in the pinned inbox. |
| Audit blocked | The blocked audit sends repeated alerts while the issue stays parked. | Edit the session/status message to `blocked` with the plain-language reason; use a fresh card only if the owner must choose a path forward now. |
| Fixer started | Opening a fixer session sends a new phone card, followed by another card when the fixer branch appears. | Edit the existing PR/session status message from audit to fixer started, then to fixer running, then to fixer result. |
| Command failure | A failed multi-step command posts one message per failed substep. | Keep one command/status message and edit it to the failure state with the useful error and next action. If the failure needs owner input, send one decision card. |
| Filing flow | `/file` asks for a repo by sending multiple candidate cards and status summaries. | Send one fresh repo-choice card when owner intent is needed; after selection, edit the command/status message as filing, issue-created, dispatched, or parked. |
| Crash warning | Every crash in a storm posts a fresh alert. | Send one fresh crash-storm warning at the threshold, then update one health/status message or silent log with counts and recovery state. |

# Hermes v2 architecture contracts

Binding contracts between modules. Vocabulary from [CONTEXT.md](../CONTEXT.md); decisions from
[docs/adr/0001–0005](adr/). The GitHub issue is the continuity; sessions are disposable; the bot
is a hub, not a bus.

## Label vocabulary (GitHub issue labels)

| Label | Meaning |
|---|---|
| `needs-grilling` | Filed, awaiting a grilling session |
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
  (grillers: read tools + `mcp__hermes__ask_owner` + scoped `Bash(gh …)`; implementers get write
  tools via `--permission-mode bypassPermissions` like lib/coder.mjs). Resume:
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
  "enabled": false,                    // master gate; Paperclip modules stay as-is
  "repos": { "rn": { "path": "…", "slug": "lemun/example-app", "label": "…" }, … },
  "defaultEngine": "codex",
  "codexBin": "/Applications/Codex.app/Contents/Resources/codex",
  "pollActiveSeconds": 30, "pollIdleSeconds": 180,
  "askSock": "state/hermes-ask.sock", "askTimeoutHours": 8,
  "sessionCap": 6,
  "autopilot": { "dailyBudget": 10, "maxLoadPerCore": 0.8, "minFreeMemMB": 1024,
                 "hidIdleMinutes": 10 },   // enabled flag lives in state, toggled by /auto
  "tiers": { "digest": "haiku", "prose": "sonnet", "grilling": "opus", "audit": "opus",
             "implementation": "codex" },  // runtime-overridable via /tiers → prefs
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

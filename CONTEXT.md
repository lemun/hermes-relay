# Hermes

The phone-side hub for a single owner's GitHub-issue pipeline: it relays agents' decision questions to Telegram, dispatches disposable coding sessions, and keeps all durable state on the GitHub issue.

## Language

**Ratification relay**:
The core product — an agent's decision question travels to the owner's phone and the answer travels back to unblock the waiting session.
_Avoid_: notification system, chat bridge

**Question**:
A single ratification request carrying a recommended answer and one-tap reply buttons.
_Avoid_: prompt, alert, ping

**Inbox**:
The one pinned, edited-in-place Telegram message showing how many questions are waiting.
_Avoid_: feed, firehose, notification stream

**Session**:
One disposable headless engine run (griller, implementer, auditor). A session may die at any time; nothing durable lives in it.
_Avoid_: agent (ambiguous), job, task

**Ledger comment**:
The single structured GitHub issue comment per session, edited in place, holding decisions, assumptions, the handoff note, and the outcome. The issue is the system of record; the bot is only a hub.
_Avoid_: status comment, log comment

**Handoff note**:
The compact section of the ledger comment that lets a fresh session continue the work without re-exploring the repo.

**Grilling**:
The Claude-run interrogation of an issue's design before it is marked ready. Self-grilling answers its own questions by default and escalates only owner-class decisions.

**Dispatch**:
Spawning an implementation session for a ready issue. Default engine is Codex; overridable per issue.

**Autopilot**:
The opt-in mode that drains ready issues on its own, subject to load and idle gates. Idle means zero LLM tokens spent.

**Finisher pipeline**:
The post-implementation lane: cross-engine audit, then couch-merge — a phone-approved merge of the audited PR.

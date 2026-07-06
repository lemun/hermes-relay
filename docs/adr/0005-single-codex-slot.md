---
status: accepted (2026-07-06)
---

# One global codex slot; parallelism comes from Claude sessions

Concurrent `codex exec` processes sharing one `~/.codex/auth.json` can race during ChatGPT-subscription token refresh and invalidate each other's tokens (OpenAI CI/CD auth guidance; openai/codex #17041, #15502 — refresh tokens behave single-use, so per-session CODEX_HOME copies are also unsafe). A race bricks all codex work until a manual re-login — the worst failure mode for unattended autopilot.

Autopilot therefore drains the ready queue FIFO through a single codex slot; grilling/audit sessions (Claude, separate auth store) run in parallel alongside. Rejected: N concurrent codex (risk compounds over unattended weeks), per-session CODEX_HOME logins (interactive setup, unclear quota/ToS, independent staleness).

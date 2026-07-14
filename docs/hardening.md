# Hermes host hardening

## Account and device

- Use a dedicated trusted macOS account where practical.
- Enable FileVault, automatic security updates, and immediate screen lock.
- Review login items and LaunchAgents; Hermes should install only `com.example.hermes-bot`.
- Keep remote-login and sharing services disabled unless intentionally required.

## Telegram

- Enable a passkey or additional password and review active sessions regularly.
- Disable bot group joins and inline mode in BotFather.
- Use exact numeric chat and user IDs; do not authorize by username.
- Store the BotFather token and TOTP seed only in the owner-local `.env`.

## Hermes

- Keep `coding.enabled=false` unless the legacy host-capable child is explicitly needed.
- Keep `hermes.allowClaudeWriteSessions=false`; prefer the sandboxed Codex write path.
- Keep repository paths/slugs in explicit allowlists.
- Run `npm run security:check` before every deployment and after changing credentials or gates.
- Treat a missing or malformed security-state file as locked. Unlock only with `npm run security:control -- unlock` on the host.
- Retain private backups before upgrades and rehearse rollback without fabricating state.

## Deployment proof

A release is not ready solely because CI is green. On the deployment host verify:

1. Owner-only permissions on `.env`, `config.json`, `state/`, and `logs/`.
2. One loaded Hermes LaunchAgent and one Telegram poller.
3. Locked-first restart, denied remote unlock, and successful local unlock.
4. Correct identity rejection, TOTP replay rejection, stale callback rejection, and fresh authorized callback success.
5. Deferred-action generation invalidation across lock/restart.
6. Rollback to the prior known-good SHA and return to the candidate.
7. A quiet observation window with no duplicate pollers, crashes, or unexpected warnings.

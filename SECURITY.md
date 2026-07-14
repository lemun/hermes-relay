# Security policy

Hermes is a private, single-operator Telegram control plane that can spawn host-capable development sessions. Treat compromise of its Telegram account, bot token, TOTP seed, local account, GitHub credentials, or repository allowlist as a path to the configured host resources.

## Enforced controls

- Exact private-chat, chat-ID, and sender-user-ID checks run on messages and callbacks.
- Sensitive actions use bounded RFC 6238 TOTP verification plus short-lived, single-use capabilities bound to identity, action, repository, target, message, and optional SHA.
- Lockdown is fail-closed. Remote lock is allowed; unlock is local-only.
- Deferred work rechecks lockdown generation and live target/SHA before mutation.
- Private storage uses owner-only directories/files, atomic writes, symlink defenses, and surfaced persistence errors.
- Host-capable children receive an explicit minimal environment allowlist. Prompts and prompt-derived identifiers do not enter audit logs.
- Runtime health checks inspect only the Hermes LaunchAgent, live repository SHA, private state, GitHub/Telegram reachability, and recent Hermes logs.

## Operator responsibilities

- Enable Telegram passkey/additional password and review active sessions.
- Disable BotFather group joins and inline use unless deliberately required.
- Keep FileVault enabled and use an immediate screen lock.
- Keep `.env`, `config.json`, `state/`, and `logs/` owner-only.
- Keep repository allowlists narrow and review any use of legacy coding or Claude write sessions.
- Rotate credentials after suspected disclosure. Never paste secrets into issues, PRs, logs, prompts, or chat.
- Run `npm run security:check` before startup and after configuration changes.

## Emergency response

1. Send `/lock` if the authorized Telegram channel is still trustworthy; otherwise stop the LaunchAgent locally.
2. Preserve logs and state privately for investigation.
3. Revoke the Telegram bot token and review Telegram account sessions.
4. Revoke affected GitHub or model-provider credentials and inspect repository changes.
5. Re-provision locally, run the security doctor, and perform a locked restart/local unlock rehearsal before restoring service.

Report vulnerabilities privately to the repository owner. Do not include secrets or exploit material in a public issue.

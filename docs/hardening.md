# Hermes operator hardening

Hermes is a command plane for one trusted operator. It can start coding sessions and approve board actions, so protect the Telegram account, the bot, the Mac, and local state as one security boundary.

Run the local, read-only posture check after configuration changes and before enabling write-capable modes:

```sh
npm run security:check
npm run security:check -- --json
```

The checker reads local configuration, environment, state, generated child configuration, and file modes. It makes no network or Telegram calls and never prints secret values. It does not change permissions, stop services, rotate tokens, or create markers. Only critical findings make it exit nonzero; high and warning findings still require operator review.

## Telegram account

Bot chats are cloud chats and are **not end-to-end encrypted**. Treat Telegram as a command plane, not a secrets or data plane: send short commands and decisions, never credentials, `.env` contents, private source, customer data, long logs, or sensitive documents.

For the operator account:

1. Add a passkey in Telegram account security settings and protect the passkey's Apple or Google account.
2. Enable Telegram's additional password (two-step verification) with a unique password and a current recovery email.
3. Review **Devices / Active Sessions**. Terminate every session you do not recognize and remove old browsers, desktops, and phones you no longer control.
4. Repeat the session review after travel, device repair, account recovery, or any suspicious bot action.

When separate user-ID configuration becomes available, configure the operator's numeric Telegram user ID as well as the allowed chat ID. A chat ID alone does not prove which member acted inside a group.

## BotFather and bot token

Open BotFather and verify both protections manually:

- Disable joining groups for the Hermes bot.
- Disable inline mode. Hermes should not be callable from unrelated chats.

The posture check warns because it deliberately makes no Telegram calls and cannot verify these settings.

Rotate the BotFather token immediately if it was pasted into a chat, issue, log, shell history, generated child config, or shared screen. Revoke the old token in BotFather, store the replacement only in the owner-readable `.env`, restart Hermes, and confirm the old token no longer works. Never paste either token into a public issue or PR.

## ntfy rotation

The historically exposed ntfy topic must be replaced, not merely renamed in documentation. Create a new long, unguessable topic, update `NTFY_TOPIC` locally, remove the old subscription from operator devices, and assume anyone who knew the old topic could both read alerts and publish forged alerts.

After verifying delivery on the replacement topic, record only the confirmation date—not the topic—in a local owner-readable marker:

```sh
umask 077
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > state/ntfy-rotation-confirmed
```

The marker is operator attestation, not proof from ntfy. Delete it and rotate again if the replacement topic is later exposed.

## Mac host

- Keep FileVault enabled and retain the recovery key somewhere separate from the Mac.
- Require a password immediately after screen lock or sleep. Use a short automatic screen-lock timeout.
- Keep macOS and the Telegram client current, and do not run Hermes from a shared macOS account.
- Keep `.env`, secret-bearing configuration, all files under `state/`, and generated child configuration owner-readable only. `npm run security:check` reports group/other-readable files but does not fix them.
- Do not enable `coding.enabled` or `hermes.allowClaudeWriteSessions` on a general-purpose or shared host. Legacy Claude coding bypass mode is host-capable.
- Do not leave `GH_TOKEN` or `GITHUB_TOKEN` in the environment of a host-capable child. Prefer narrow, bot-owned GitHub operations.

## Emergency lockdown

`state/hermes.lockdown` is an operator marker for incident handling. The current runtime does not enforce it by itself; it exists so the checker can detect a dangerous contradiction between claimed lockdown and enabled write/session posture.

If the Telegram account, bot token, ntfy topic, board key, GitHub token, Mac, or a spawned child may be compromised:

1. Stop Hermes and its launch agent. Do not rely on the marker to stop a running process.
2. Create the marker owner-readable: `umask 077; : > state/hermes.lockdown`.
3. Disable `coding.enabled`, `hermes.enabled`, runtime autopilot, and `hermes.allowClaudeWriteSessions`. Remove the board write key from the runtime environment.
4. Review and terminate suspicious Telegram sessions. Revoke and rotate the BotFather token, board key, GitHub tokens, and ntfy topic as applicable.
5. Inspect generated child configuration, session state, worktrees, branches, PRs, and audit logs for unauthorized actions. Do not execute unknown child output.
6. Run `npm run security:check` and resolve every critical and high finding. Independently verify the Telegram/BotFather warnings.
7. Restart in read-only posture first. Remove `state/hermes.lockdown` only after credential rotation and review are complete, then deliberately re-enable the minimum required capabilities.

## Data-handling boundary

Do no public-project extraction work with Hermes. Do not move private repository content, private chat history, configuration, state files, prompts, logs, credentials, customer data, or incident artifacts into public repositories, public issues, public projects, or third-party examples. Use a private, access-controlled incident record and redact it before sharing even internally.

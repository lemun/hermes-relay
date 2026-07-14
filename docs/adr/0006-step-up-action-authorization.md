---
status: accepted (2026-07-12)
---

# Step-up authorization uses strict identity, TOTP, and single-use action capabilities

Hermes accepts security-sensitive instructions over Telegram. A Telegram account name is mutable, a forwarded or group message is not an owner-authenticated private command, a TOTP code can be replayed during its time step, and an old inline button can outlive the state it was intended to approve. Lockdown also needs an emergency path that cannot be undone by the same compromised remote channel.

This ADR is enforced by `hermes-bot.mjs`, `lib/action-authorization.mjs`, the secured Telegram transport, and the hub's deferred spawn/push/merge gates.

## Decision

### Strict Telegram identity

Every message and callback is passed through `authorizeTelegramIdentity({ update, configuredChatId, configuredUserId })`. It normalizes both update forms through `normalizeTelegramUpdate(update)` and authorizes only when:

- the update has a message-backed chat, sender, and message ID;
- `chat.type` is exactly `private`;
- the numeric chat ID exactly matches the configured chat ID; and
- the numeric sender user ID exactly matches the configured user ID.

Missing or malformed configuration and updates fail closed. Usernames, display names, callback-query IDs, and message text are never identity signals.

### TOTP verification

`createTotpVerifier({ secret, clock, stepSeconds, window, digits, algorithm, replayCache })` implements RFC 6238 with Node's built-in crypto. It accepts a secret as bytes or base32, supports SHA-1/SHA-256/SHA-512, compares candidate codes with `timingSafeEqual`, and permits deterministic time/window injection for tests.

The returned object exposes only `verify(code)`. It never returns or serializes the secret. A successful counter is recorded in the injected `replayCache` (a dedicated `has`/`add` store for that TOTP identity), so the same time-step code cannot be accepted again. The runtime must never log the input code or secret. If replay rejection must survive verifier reconstruction, the integration must provide a durable dedicated replay-cache adapter; the default `Set` is process-local.

### Step-up boundary

`/auth <TOTP>` creates a process-local, single-action step-up grant that expires after two minutes if unused. The grant is bound to a persisted lockdown generation, so a lock or unlock performed by a separate local process invalidates it. Fresh step-up is required before every mutating or session-spawning Telegram route, including:

- starting or resuming host-capable coding;
- enabling autopilot;
- pushing or opening a pull request;
- merging;
- enabling Claude write lanes;
- dispatch, filing, issue chat, preference changes, board actions, and owner-answer resume paths.

Ordinary reads, status, help, and stop remain outside TOTP step-up. TOTP codes and secrets are never copied into prompts, callback data, logs, or error output.

### Single-use action capabilities

After identity and any required TOTP step-up pass, the runtime may call `createActionCapabilityStore({ clock, ttlMs, randomBytesImpl }).issue(binding)`. The binding contains:

```js
{
  userId,
  chatId,
  action,
  repo,
  target,
  messageId,
  expectedSha, // optional; absence is also bound
}
```

Issuance returns `{ id, callbackData, expiresAt }`, where `callbackData === id`. The ID is an opaque base64url value generated from at least 128 bits of cryptographic randomness. No action, repository, target, SHA, or identity data is placed in Telegram `callback_data`; the binding remains server-side.

The callback handler must repeat strict Telegram identity validation, reconstruct the complete expected binding from trusted current context, and call `consume({ id, ...binding })`. Identity and step-up are checked before consumption so a missing grant does not strand a valid button. Binding mismatches burn the capability, and successful consumption is persisted atomically before the side effect. The default lifetime is two minutes and configuration is capped at five minutes. Capabilities are stored atomically in owner-only security state, bounded to 256 live entries, and pruned on issue/consume. They bind identity, message, action, repository, target, and optional expected SHA. They survive a restart only until their original expiry; the process-local TOTP grant does not, so a sensitive callback requires fresh step-up after restart. Replay counters persist across restart in the same private state. Cross-process updates use an owner-only exclusive lock and always merge from the latest state, so a concurrent local lock cannot be overwritten by a stale capability write.

For SHA-bound operations, capability consumption is not a substitute for a final live head-SHA comparison at the execution boundary. The caller must perform both checks.

### Lockdown

`evaluateLockdown({ mode, action, classification })` is the pure authorization decision. In `normal` mode, valid actions are permitted. In `locked` mode:

- `status`, `help`, `stop`, and the idempotent `lock` action remain available;
- other operations are allowed only when explicitly classified as `read`; and
- mutations, session spawns, and unclassified/unknown actions are denied.

`transitionLockdown({ mode, operation, source })` permits `lock` from Telegram or local control. It permits `unlock` only when `source === "local"`. The host-only operation is `npm run security:control -- unlock`; Telegram `/unlock` always refuses.

## Required integration order

For commands: normalize and authorize Telegram identity, evaluate lockdown, verify TOTP when the action is in the step-up boundary, then issue a capability for the exact proposed action.

For callbacks: normalize and authorize identity again, evaluate lockdown again, rebuild the binding from trusted current state, consume the opaque capability, carry its lockdown generation through the async execution context, re-check live mutable state such as the expected SHA, then execute. Every deferred runtime gate must still match that authorization generation. Any missing classification, binding field, configuration, state lookup, replay-cache availability, or generation match must deny the action.

## Threats covered

- group/channel messages and callbacks, wrong chat IDs, wrong sender IDs, username impersonation, missing identity configuration, and incomplete callback updates;
- malformed, out-of-window, and replayed TOTP codes, including replay across verifier reconstruction when a shared cache is supplied;
- guessed, expired, replayed, or context-shifted callback capabilities, including mismatches in user, chat, action, repository, target, message, or expected SHA;
- stale-button reuse after a failed mismatch attempt;
- remote attempts to unlock lockdown; and
- new or unknown actions accidentally bypassing locked/read-only mode.

## Consequences

Runtime wiring maintains explicit action classification and trusted binding reconstruction. Security state is intentionally fail-closed: losing the capability store invalidates pending buttons, and losing required TOTP replay state blocks step-up until storage is repaired. New commands or callbacks require an explicit registry entry before they can execute.

Missing security state bootstraps as `locked`, never `normal`. The operator must initialize or recover it with `npm run security:control -- unlock` on the host.

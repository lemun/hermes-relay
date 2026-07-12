---
status: accepted (2026-07-12)
---

# Step-up authorization uses strict identity, TOTP, and single-use action capabilities

Hermes accepts security-sensitive instructions over Telegram. A Telegram account name is mutable, a forwarded or group message is not an owner-authenticated private command, a TOTP code can be replayed during its time step, and an old inline button can outlive the state it was intended to approve. Lockdown also needs an emergency path that cannot be undone by the same compromised remote channel.

This ADR defines policy primitives only. It does not wire them into `hermes-bot.mjs` or any current runtime path.

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

Fresh TOTP step-up is required before:

- starting or resuming host-capable coding;
- enabling autopilot;
- pushing or opening a pull request;
- merging;
- enabling Claude write lanes.

Ordinary reads, status, explanations, stop, and low-risk confirm-gated board actions remain outside TOTP step-up. Existing confirmation and freshness gates still apply to those board actions; being outside TOTP does not turn them into ungated writes.

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

The callback handler must repeat strict Telegram identity validation, reconstruct the complete expected binding from trusted current context, and call `consume({ id, ...binding })`. Consumption removes the capability before checking expiry or bindings. Therefore success, mismatch, expiry, and a malicious probing attempt all leave the identifier unusable. The default lifetime is two minutes and configuration is capped at five minutes. A process restart intentionally invalidates all outstanding capabilities.

For SHA-bound operations, capability consumption is not a substitute for a final live head-SHA comparison at the execution boundary. The caller must perform both checks.

### Lockdown

`evaluateLockdown({ mode, action, classification })` is the pure authorization decision. In `normal` mode, valid actions are permitted. In `locked` mode:

- `status`, `help`, `stop`, and the idempotent `lock` action remain available;
- other operations are allowed only when explicitly classified as `read`; and
- mutations, session spawns, and unclassified/unknown actions are denied.

`transitionLockdown({ mode, operation, source })` permits `lock` from Telegram or local control. It permits `unlock` only when `source === "local"`. A future runtime must expose unlock through a local CLI, local file/control socket, or equivalent host-only operation—not a Telegram command or callback.

## Required integration order

For commands: normalize and authorize Telegram identity, evaluate lockdown, verify TOTP when the action is in the step-up boundary, then issue a capability for the exact proposed action.

For callbacks: normalize and authorize identity again, evaluate lockdown again, rebuild the binding from trusted current state, consume the opaque capability, re-check live mutable state such as the expected SHA, then execute. Any missing classification, binding field, configuration, state lookup, or replay-cache availability must deny the action.

## Threats covered

- group/channel messages and callbacks, wrong chat IDs, wrong sender IDs, username impersonation, missing identity configuration, and incomplete callback updates;
- malformed, out-of-window, and replayed TOTP codes, including replay across verifier reconstruction when a shared cache is supplied;
- guessed, expired, replayed, or context-shifted callback capabilities, including mismatches in user, chat, action, repository, target, message, or expected SHA;
- stale-button reuse after a failed mismatch attempt;
- remote attempts to unlock lockdown; and
- new or unknown actions accidentally bypassing locked/read-only mode.

## Consequences

Runtime wiring must maintain explicit action classification and trusted binding reconstruction. Security state is intentionally fail-closed: losing the capability store invalidates pending buttons, and losing required TOTP replay state must block step-up until the configured replay store is available. This adds a small amount of state management but keeps secrets and authority out of Telegram payloads.

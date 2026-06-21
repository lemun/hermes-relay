// Shared magic numbers. Call-specific values (e.g. the 50s Telegram long-poll, the 20s voice
// download) stay inline at their use site; only values reused across modules live here so they
// can't drift apart.

export const API_TIMEOUT_MS = 8000; // Paperclip GET/POST + ntfy POST — all hit the loopback/ntfy

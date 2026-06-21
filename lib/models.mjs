// Single source of truth for Claude model aliases + effort levels. Shared by the concierge
// (hermes-bot.mjs) and the coding engine (lib/coder.mjs) so a /model pick and a /code pick
// resolve to the same id, and so the alias list can't drift between the two.

export const MODELS = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-8",
};

export const MODEL_ALIASES = Object.keys(MODELS); // haiku | sonnet | opus
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export const DEFAULT_MODEL_ALIAS = "sonnet";
export const DEFAULT_EFFORT = "high";

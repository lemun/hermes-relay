export function resolveTelegramCallbackBinding(data, prefs) {
  if (data === "code:push" || data === "code:iterate") {
    const last = prefs.coding?.last;
    return {
      repo: last?.repoKey || "coding",
      target: [last?.sessionId, last?.branch].filter(Boolean).join("|") || "missing-coding-session",
      expectedSha: data === "code:push" ? last?.headSha : null,
    };
  }
  if (data?.startsWith("code:")) {
    const wizard = prefs.coding?.wizard;
    return {
      repo: wizard?.repoKey || "coding",
      // Telegram message identity is bound independently by the capability
      // store. Keep only the trusted wizard state here so assigning msgId
      // after sendMessage cannot invalidate freshly issued buttons.
      target: [wizard?.step, wizard?.repoKey, wizard?.model, wizard?.effort]
        .filter((value) => value !== undefined)
        .join("|") || data,
    };
  }
  return { repo: "telegram", target: data };
}

export function createTelegramCallbackBindingResolver(loadPrefs) {
  if (typeof loadPrefs !== "function") throw new TypeError("loadPrefs must be a function");
  return (data) => resolveTelegramCallbackBinding(data, loadPrefs());
}

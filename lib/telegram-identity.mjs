function normalizeTelegramId(value, { allowNegative = false } = {}) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    value = String(value);
  } else if (typeof value === "bigint") {
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const pattern = allowNegative ? /^-?\d+$/ : /^\d+$/;
  return pattern.test(value) ? value : null;
}

export function normalizeTelegramUpdate(update) {
  const callback = update?.callback_query;
  const message = callback ? callback.message : update?.message;
  const sender = callback ? callback.from : message?.from;
  const kind = callback ? "callback" : update?.message ? "message" : null;
  const chatId = normalizeTelegramId(message?.chat?.id, { allowNegative: true });
  const userId = normalizeTelegramId(sender?.id);
  const messageId = normalizeTelegramId(message?.message_id);

  if (!kind || !message?.chat || !sender || !chatId || !userId || !messageId) return null;
  return {
    kind,
    chatType: message.chat.type,
    chatId,
    userId,
    messageId,
  };
}

export function authorizeTelegramIdentity({ update, configuredChatId, configuredUserId } = {}) {
  const expectedChatId = normalizeTelegramId(configuredChatId, { allowNegative: true });
  const expectedUserId = normalizeTelegramId(configuredUserId);
  if (!expectedChatId || !expectedUserId) {
    return { ok: false, reason: "identity_not_configured" };
  }

  const identity = normalizeTelegramUpdate(update);
  if (!identity) return { ok: false, reason: "invalid_update" };
  if (identity.chatType !== "private") return { ok: false, reason: "private_chat_required" };
  if (identity.chatId !== expectedChatId) return { ok: false, reason: "chat_mismatch" };
  if (identity.userId !== expectedUserId) return { ok: false, reason: "user_mismatch" };
  return { ok: true, identity };
}

// Telegram Bot API transport + inline-keyboard helpers, factored out of hermes-bot.mjs.
// createTelegram(token) returns the bound helpers used throughout the bot; chunk() is pure.

import { assertTelegramCallbackData } from "./callback-tokens.mjs";

const TG_TIMEOUT_MS = 15000;

export function createTelegram(token, { fetchImpl = fetch, callbackAuthorization } = {}) {
  const API = `https://api.telegram.org/bot${token}`;
  async function raw(method, body, timeoutMs = TG_TIMEOUT_MS) {
    const r = await fetchImpl(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.json();
  }
  function protectMarkup(markup, chatId, messageId) {
    if (!callbackAuthorization || !markup?.inline_keyboard) return markup;
    return {
      ...markup,
      inline_keyboard: markup.inline_keyboard.map((row) => row.map((button) => {
        if (!button.callback_data) return button;
        return {
          ...button,
          callback_data: assertTelegramCallbackData(callbackAuthorization.issueCallback({
            originalData: button.callback_data,
            chatId,
            messageId,
          })),
        };
      })),
    };
  }
  async function tg(method, body, timeoutMs = TG_TIMEOUT_MS) {
    if (callbackAuthorization && method === "sendMessage" && body?.reply_markup?.inline_keyboard) {
      const { reply_markup: markup, ...withoutMarkup } = body;
      const sent = await raw(method, withoutMarkup, timeoutMs);
      const messageId = sent?.result?.message_id;
      if (!sent?.ok || !messageId) return sent;
      const protectedMarkup = protectMarkup(markup, body.chat_id, messageId);
      const edited = await raw("editMessageReplyMarkup", {
        chat_id: body.chat_id,
        message_id: messageId,
        reply_markup: protectedMarkup,
      }, timeoutMs);
      if (!edited?.ok) throw new Error("Telegram callback protection could not be installed");
      return sent;
    }
    if (callbackAuthorization && method === "editMessageText" && body?.reply_markup?.inline_keyboard) {
      return raw(method, {
        ...body,
        reply_markup: protectMarkup(body.reply_markup, body.chat_id, body.message_id),
      }, timeoutMs);
    }
    return raw(method, body, timeoutMs);
  }
  const kbd = (rows) => ({
    inline_keyboard: rows.map((row) => row.map(([text, data]) => ({
      text,
      callback_data: assertTelegramCallbackData(data),
    }))),
  });
  const answerCallback = (id, text) => tg("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
  async function sendKbd(chatId, text, rows) {
    const r = await tg("sendMessage", { chat_id: chatId, text, reply_markup: kbd(rows) });
    return r?.result?.message_id;
  }
  const editMsg = (chatId, msgId, text, rows) =>
    tg("editMessageText", { chat_id: chatId, message_id: msgId, text, ...(rows ? { reply_markup: kbd(rows) } : {}) });
  return { tg, kbd, answerCallback, sendKbd, editMsg };
}

// Split a long reply into Telegram-sized chunks (default ~3800 chars). Pure.
export function chunk(s, n = 3800) {
  const str = String(s);
  const out = [];
  for (let i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
  return out.length ? out : ["(empty)"];
}

// Telegram Bot API transport + inline-keyboard helpers, factored out of hermes-bot.mjs.
// createTelegram(token) returns the bound helpers used throughout the bot; chunk() is pure.

import { assertTelegramCallbackData } from "./callback-tokens.mjs";

const TG_TIMEOUT_MS = 15000;

export function createTelegram(token) {
  const API = `https://api.telegram.org/bot${token}`;
  async function tg(method, body, timeoutMs = TG_TIMEOUT_MS) {
    const r = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return r.json();
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

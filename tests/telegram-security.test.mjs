import test from "node:test";
import assert from "node:assert/strict";
import { createTelegram } from "../lib/telegram.mjs";

test("Telegram keyboards publish only opaque protected callback capabilities", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ method: url.split("/").at(-1), body });
    return { async json() { return requests.length === 1 ? { ok: true, result: { message_id: 77 } } : { ok: true, result: true }; } };
  };
  const issued = [];
  const callbackAuthorization = {
    issueCallback(binding) {
      issued.push(binding);
      return "sec:AAAAAAAAAAAAAAAAAAAAAA";
    },
  };
  const { sendKbd } = createTelegram("test-token", { fetchImpl, callbackAuthorization });
  assert.equal(await sendKbd("123", "Act?", [[["Go", "code:push"]]]), 77);
  assert.equal(requests[0].method, "sendMessage");
  assert.equal("reply_markup" in requests[0].body, false);
  assert.equal(requests[1].method, "editMessageReplyMarkup");
  assert.equal(requests[1].body.reply_markup.inline_keyboard[0][0].callback_data, "sec:AAAAAAAAAAAAAAAAAAAAAA");
  assert.deepEqual(issued, [{ originalData: "code:push", chatId: "123", messageId: 77 }]);
  assert.equal(JSON.stringify(requests).includes("code:push"), false);
});

test("unknown callback classifications fail before Telegram receives a button", async () => {
  const requests = [];
  const { sendKbd } = createTelegram("test-token", {
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body));
      return { async json() { return { ok: true, result: { message_id: 9 } }; } };
    },
    callbackAuthorization: { issueCallback() { throw new Error("callback action is unknown"); } },
  });
  await assert.rejects(() => sendKbd("123", "Bad", [[["Bad", "future:action"]]]), /unknown/);
  assert.equal(requests.length, 1);
  assert.equal("reply_markup" in requests[0], false, "the sent message contains no executable button");
});

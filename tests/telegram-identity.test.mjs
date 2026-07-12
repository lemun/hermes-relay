import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeTelegramIdentity,
  normalizeTelegramUpdate,
} from "../lib/telegram-identity.mjs";

const messageUpdate = {
  message: {
    message_id: 41,
    chat: { id: -100123, type: "private", username: "not-identity" },
    from: { id: 456, username: "owner" },
  },
};

const callbackUpdate = {
  callback_query: {
    id: "callback-1",
    from: { id: 456, username: "owner" },
    message: {
      message_id: 42,
      chat: { id: -100123, type: "private", username: "not-identity" },
    },
  },
};

test("normalizes messages and callbacks into the same identity shape", () => {
  assert.deepEqual(normalizeTelegramUpdate(messageUpdate), {
    kind: "message",
    chatType: "private",
    chatId: "-100123",
    userId: "456",
    messageId: "41",
  });
  assert.deepEqual(normalizeTelegramUpdate(callbackUpdate), {
    kind: "callback",
    chatType: "private",
    chatId: "-100123",
    userId: "456",
    messageId: "42",
  });
});

test("authorizes only an exact private-chat and sender match", () => {
  for (const update of [messageUpdate, callbackUpdate]) {
    const result = authorizeTelegramIdentity({
      update,
      configuredChatId: "-100123",
      configuredUserId: "456",
    });
    assert.equal(result.ok, true);
    assert.equal(result.identity.chatType, "private");
  }

  assert.deepEqual(authorizeTelegramIdentity({
    update: messageUpdate,
    configuredChatId: "-100999",
    configuredUserId: "456",
  }), { ok: false, reason: "chat_mismatch" });
  assert.deepEqual(authorizeTelegramIdentity({
    update: messageUpdate,
    configuredChatId: "-100123",
    configuredUserId: "999",
  }), { ok: false, reason: "user_mismatch" });
});

test("fails closed for groups, missing configuration, and incomplete updates", () => {
  const group = structuredClone(messageUpdate);
  group.message.chat.type = "group";
  assert.deepEqual(authorizeTelegramIdentity({
    update: group,
    configuredChatId: "-100123",
    configuredUserId: "456",
  }), { ok: false, reason: "private_chat_required" });

  assert.deepEqual(authorizeTelegramIdentity({
    update: messageUpdate,
    configuredChatId: "-100123",
  }), { ok: false, reason: "identity_not_configured" });
  assert.deepEqual(authorizeTelegramIdentity({
    update: { callback_query: { from: { id: 456 } } },
    configuredChatId: "-100123",
    configuredUserId: "456",
  }), { ok: false, reason: "invalid_update" });
});

test("never treats a matching username as identity", () => {
  const impostor = structuredClone(messageUpdate);
  impostor.message.from.id = 999;
  impostor.message.from.username = "456";
  assert.deepEqual(authorizeTelegramIdentity({
    update: impostor,
    configuredChatId: "-100123",
    configuredUserId: "456",
  }), { ok: false, reason: "user_mismatch" });
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  activateRuntimeAfterLocalUnlock,
  RuntimeActivationDeniedError,
} from "../lib/runtime-activation.mjs";

test("post-unlock activation guards every mutation and spawn boundary in order", async () => {
  const calls = [];
  let generation = 7;
  const result = await activateRuntimeAfterLocalUnlock({
    readLockdownGeneration: () => generation,
    authorizeRuntimeAction: (action) => { calls.push(`auth:${action}`); return true; },
    webhookUrl: "https://example.invalid/hook",
    deleteWebhook: async () => { calls.push("deleteWebhook"); return { ok: true }; },
    recoverCoding: async () => { calls.push("recoverCoding"); return { stale: true }; },
    notifyCodingRecovery: async () => { calls.push("notifyCodingRecovery"); },
    runRetention: async (assertFresh) => { calls.push("retention"); assertFresh("hub.runtime.mutate"); return 2; },
    startHub: async (assertFresh) => { calls.push("hub.start"); assertFresh("hub.runtime.spawn"); },
    startPushWatcher: () => { calls.push("push.start"); },
  });

  assert.equal(result.generation, 7);
  assert.equal(result.reaped, 2);
  for (const boundary of ["deleteWebhook", "recoverCoding", "notifyCodingRecovery", "retention", "hub.start", "push.start"]) {
    const index = calls.indexOf(boundary);
    assert.ok(index > 0, `${boundary} must run`);
    assert.match(calls[index - 1], /^auth:hub\.runtime\./, `${boundary} must have an immediate authorization check`);
  }
  assert.equal(generation, 7);
});

for (const [name, flipAt, blockedBoundary] of [
  ["deleteWebhook", "deleteWebhook", "recoverCoding"],
  ["coding recovery", "recoverCoding", "notifyCodingRecovery"],
  ["coding recovery notification", "notifyCodingRecovery", "retention"],
  ["retention", "retention", "hub.start"],
  ["hub start", "hub.start", "push.start"],
]) {
  test(`generation change during ${name} stops the next activation mutation`, async () => {
    const calls = [];
    let generation = 11;
    const operation = (label, result) => async () => {
      calls.push(label);
      if (label === flipAt) generation += 1;
      return result;
    };
    await assert.rejects(() => activateRuntimeAfterLocalUnlock({
      readLockdownGeneration: () => generation,
      authorizeRuntimeAction: () => true,
      webhookUrl: "https://example.invalid/hook",
      deleteWebhook: operation("deleteWebhook", { ok: true }),
      recoverCoding: operation("recoverCoding", { stale: true }),
      notifyCodingRecovery: operation("notifyCodingRecovery"),
      runRetention: operation("retention", 0),
      startHub: operation("hub.start"),
      startPushWatcher: () => { calls.push("push.start"); },
    }), RuntimeActivationDeniedError);
    assert.equal(calls.includes(blockedBoundary), false);
  });
}

test("a policy denial immediately before activation prevents all mutations", async () => {
  const calls = [];
  await assert.rejects(() => activateRuntimeAfterLocalUnlock({
    readLockdownGeneration: () => 3,
    authorizeRuntimeAction: () => false,
    webhookUrl: "https://example.invalid/hook",
    deleteWebhook: async () => { calls.push("deleteWebhook"); },
  }), RuntimeActivationDeniedError);
  assert.deepEqual(calls, []);
});

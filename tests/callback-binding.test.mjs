import test from "node:test";
import assert from "node:assert/strict";
import {
  createTelegramCallbackBindingResolver,
  resolveTelegramCallbackBinding,
} from "../lib/callback-binding.mjs";

test("coding wizard callback binding is stable when Telegram assigns the message ID", () => {
  const before = resolveTelegramCallbackBinding("code:repo:rn", {
    coding: { wizard: { step: "repo", model: "sonnet", effort: "high" } },
  });
  const after = resolveTelegramCallbackBinding("code:repo:rn", {
    coding: { wizard: { step: "repo", msgId: 492, model: "sonnet", effort: "high" } },
  });

  assert.deepEqual(after, before);
  assert.deepEqual(after, { repo: "coding", target: "repo|sonnet|high" });
});

test("coding wizard callback binding still invalidates a button after the trusted step changes", () => {
  const repoStep = resolveTelegramCallbackBinding("code:repo:rn", {
    coding: { wizard: { step: "repo", model: "sonnet", effort: "high" } },
  });
  const modelStep = resolveTelegramCallbackBinding("code:repo:rn", {
    coding: { wizard: { step: "model", repoKey: "rn", model: "sonnet", effort: "high" } },
  });

  assert.notDeepEqual(modelStep, repoStep);
  assert.deepEqual(modelStep, { repo: "rn", target: "model|rn|sonnet|high" });
});

test("binding resolver reloads trusted preferences for every issue and consume decision", () => {
  let prefs = { coding: { wizard: { step: "repo", model: "sonnet", effort: "high" } } };
  const resolve = createTelegramCallbackBindingResolver(() => prefs);
  assert.equal(resolve("code:repo:rn").target, "repo|sonnet|high");
  prefs = { coding: { wizard: { step: "model", repoKey: "rn", model: "sonnet", effort: "high" } } };
  assert.equal(resolve("code:model:sonnet").target, "model|rn|sonnet|high");
});

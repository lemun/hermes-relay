export class RuntimeActivationDeniedError extends Error {
  constructor(message = "runtime activation authorization changed") {
    super(message);
    this.name = "RuntimeActivationDeniedError";
  }
}

/**
 * Activate post-unlock runtime work under one immutable lockdown generation.
 * Every awaited boundary is followed by a generation+policy recheck, and every
 * mutation/spawn boundary has an immediately preceding check.
 */
export async function activateRuntimeAfterLocalUnlock({
  authorizeRuntimeAction,
  readLockdownGeneration,
  webhookUrl,
  deleteWebhook,
  recoverCoding,
  notifyCodingRecovery,
  runRetention,
  startHub,
  startPushWatcher,
} = {}) {
  if (typeof authorizeRuntimeAction !== "function" || typeof readLockdownGeneration !== "function") {
    throw new TypeError("runtime activation authorization is required");
  }
  const generation = readLockdownGeneration();
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RuntimeActivationDeniedError("runtime activation generation is invalid");
  }
  const assertFresh = (...actions) => {
    if (readLockdownGeneration() !== generation) throw new RuntimeActivationDeniedError();
    for (const action of actions) {
      if (authorizeRuntimeAction(action) !== true) throw new RuntimeActivationDeniedError();
    }
    if (readLockdownGeneration() !== generation) throw new RuntimeActivationDeniedError();
  };

  assertFresh("hub.runtime.mutate", "hub.runtime.spawn");
  if (webhookUrl && typeof deleteWebhook === "function") {
    assertFresh("hub.runtime.mutate");
    const cleared = await deleteWebhook();
    assertFresh("hub.runtime.mutate");
    if (!cleared?.ok) {
      throw new Error(`deleteWebhook failed: ${cleared?.description || cleared?.error_code || "unknown error"}`);
    }
  }

  let codingRecovery = null;
  if (typeof recoverCoding === "function") {
    assertFresh("hub.runtime.mutate");
    codingRecovery = await recoverCoding();
    assertFresh("hub.runtime.mutate");
    if (codingRecovery && typeof notifyCodingRecovery === "function") {
      assertFresh("hub.runtime.mutate");
      await notifyCodingRecovery(codingRecovery);
      assertFresh("hub.runtime.mutate");
    }
  }

  let reaped = 0;
  if (typeof runRetention === "function") {
    assertFresh("hub.runtime.mutate");
    reaped = await runRetention(assertFresh);
    assertFresh("hub.runtime.mutate");
  }

  if (typeof startHub === "function") {
    assertFresh("hub.runtime.mutate", "hub.runtime.spawn");
    await startHub(assertFresh);
    assertFresh("hub.runtime.mutate", "hub.runtime.spawn");
  }

  if (typeof startPushWatcher === "function") {
    assertFresh("hub.runtime.mutate");
    startPushWatcher();
  }
  return { generation, codingRecovery, reaped };
}

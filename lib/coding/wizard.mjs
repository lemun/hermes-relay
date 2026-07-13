// Coding-mode wizard — the inline-keyboard flow (repo → model → effort → prompt → confirm)
// that drives lib/coder.mjs from Telegram. Extracted out of hermes-bot.mjs verbatim (behavior-
// preserving): user-visible strings, keyboard layouts, callback data, prefs shapes, and state
// transitions are unchanged. hermes-bot.mjs now just constructs this factory once with the real
// deps and wires its handlers into onMessage/onCallback/HELP/etc.
//
// createCodingWizard(deps) returns { handleCode, handleCodeCallback, handleWizardPrompt,
// sendCodingStatus, doPush } — the wizard's public surface. Everything else (REPO_KEYS,
// MODEL_KEYS, setWizard/clearWizard, confirmText/confirmButtons/sendConfirm, progressFor,
// doneFor, startJob, startResume) is an internal closure over deps, same as it was a closure
// over module-level state in hermes-bot.mjs.

// truncTask is ALSO used outside the wizard (hermes-bot's board-actions actConfirmText), so it's
// a standalone named export, not part of the factory.
import { codingCompletionNtfyContent } from "../paperclip.mjs";

export const truncTask = (t) => (t.length > 200 ? t.slice(0, 200) + "…" : t);

const mmss = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; };

export function createCodingWizard(deps) {
  const { cfg, telegram, prefs, coder, models, ntfy, chunk, security = {} } = deps;
  const authorizeRuntimeAction = security.authorizeRuntimeAction;
  const authorizeCurrentRuntimeAction = security.authorizeCurrentRuntimeAction;
  const { tg, kbd, answerCallback, sendKbd, editMsg } = telegram;
  const { loadPrefs, savePrefs } = prefs;
  const { startCodingJob, resumeCodingJob, codingStatus, pushCodingResult, lastCodingSession, EFFORTS } = coder;
  const CODING = cfg.coding || {};
  const REPO_KEYS = Object.keys(CODING.repos || {});
  const MODEL_KEYS = Object.keys(models); // haiku | sonnet | opus

  function setWizard(w) { const p = loadPrefs(); p.coding = p.coding || {}; p.coding.wizard = w; savePrefs(p); }
  function clearWizard() { const p = loadPrefs(); if (p.coding) { delete p.coding.wizard; savePrefs(p); } }

  async function handleCode(chatId, text) {
    if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.mutate") !== true) throw new Error("runtime security policy denied coding configuration");
    if (!CODING.enabled) {
      await tg("sendMessage", { chat_id: chatId, text: "Coding mode is off. Set coding.enabled=true (and list repos) in config.json to use it." });
      return;
    }
    const rest = text.replace(/^\/code\b/, "").trim();
    if (/^again\b/i.test(rest)) {                       // /code again [follow-up]
      const followup = rest.replace(/^again\b/i, "").trim();
      const expected = lastCodingSession();
      if (followup) await startResume(chatId, followup, expected);
      else { setWizard({ step: "resumePrompt", chatId, ...(expected?.sessionId ? { expectedSessionId: expected.sessionId, expectedBranch: expected.branch } : {}) }); await tg("sendMessage", { chat_id: chatId, text: "↻ Send the follow-up for the last coding session (text or voice)." }); }
      return;
    }
    if (codingStatus().running) { await sendCodingStatus(chatId); return; }
    if (!REPO_KEYS.length) { await tg("sendMessage", { chat_id: chatId, text: "No repos configured (coding.repos is empty)." }); return; }
    const msgId = await sendKbd(chatId, "🛠 New coding session — pick a repo:", REPO_KEYS.map((k) => [[CODING.repos[k].label || k, `code:repo:${k}`]]));
    if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.mutate") !== true) throw new Error("runtime security policy denied coding configuration");
    setWizard({ step: "repo", chatId, msgId, prompt: rest, model: CODING.defaultModel, effort: CODING.defaultEffort });
  }

  async function sendCodingStatus(chatId) {
    const s = codingStatus();
    await tg("sendMessage", { chat_id: chatId, text: s.running
      ? `⏳ Running on ${s.repoLabel} (${s.model}/${s.effort})\nbranch ${s.branch}\nstep ${s.stepCount}: ${s.lastStep}\n${mmss(s.elapsedMs)} elapsed · /stop to cancel.`
      : "No coding job is running." });
  }

  async function handleCodeCallback(cq) {
    const chatId = String(cq.message.chat.id);
    const msgId = cq.message.message_id;
    const data = cq.data || "";
    await answerCallback(cq.id);
    if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.mutate") !== true) throw new Error("runtime security policy denied coding callback");

    if (data === "code:push") { await doPush(chatId, cq.securityBinding); return; }
    if (data === "code:iterate") { const expected = lastCodingSession(); setWizard({ step: "resumePrompt", chatId, ...(expected?.sessionId ? { expectedSessionId: expected.sessionId, expectedBranch: expected.branch } : {}) }); await tg("sendMessage", { chat_id: chatId, text: "↻ Send the follow-up instruction (text or voice)." }); return; }
    if (data === "code:cancel") { clearWizard(); await editMsg(chatId, msgId, "✖️ Cancelled."); return; }

    const wiz = loadPrefs().coding?.wizard;
    if (!wiz || wiz.msgId !== msgId) { await editMsg(chatId, msgId, "This menu expired — send /code to start again."); return; }

    if (data.startsWith("code:repo:")) {
      wiz.repoKey = data.slice("code:repo:".length); wiz.step = "model"; setWizard(wiz);
      await editMsg(chatId, msgId, `Repo: ${CODING.repos[wiz.repoKey]?.label || wiz.repoKey}\nPick a model:`, MODEL_KEYS.map((m) => [[m, `code:model:${m}`]]));
    } else if (data.startsWith("code:model:")) {
      wiz.model = data.slice("code:model:".length); wiz.step = "effort"; setWizard(wiz);
      await editMsg(chatId, msgId, `Model: ${wiz.model}\nPick effort:`, [EFFORTS.map((e) => [e, `code:effort:${e}`])]);
    } else if (data.startsWith("code:effort:")) {
      wiz.effort = data.slice("code:effort:".length);
      if (wiz.prompt) { wiz.step = "confirm"; setWizard(wiz); await sendConfirm(chatId, msgId, wiz); }
      else { wiz.step = "prompt"; setWizard(wiz); await editMsg(chatId, msgId, `${CODING.repos[wiz.repoKey]?.label} · ${wiz.model}/${wiz.effort}\n\nNow send the task (text or voice).`); }
    } else if (data === "code:go") {
      clearWizard(); await startJob(chatId, wiz);
    }
  }

  const confirmText = (wiz) => `Ready to code (write access, isolated worktree):\nRepo: ${CODING.repos[wiz.repoKey]?.label}\nModel: ${wiz.model} · Effort: ${wiz.effort}\n\nTask: ${truncTask(wiz.prompt)}`;
  const confirmButtons = [[["▶️ Start", "code:go"], ["✖️ Cancel", "code:cancel"]]];
  const sendConfirm = (chatId, msgId, wiz) => editMsg(chatId, msgId, confirmText(wiz), confirmButtons);

  // The wizard "prompt"/"resumePrompt" step arriving as a normal text/voice message.
  async function handleWizardPrompt(chatId, userText, wiz) {
    if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.mutate") !== true) throw new Error("runtime security policy denied coding prompt");
    if (wiz.step === "resumePrompt") { clearWizard(); await startResume(chatId, userText, { sessionId: wiz.expectedSessionId, branch: wiz.expectedBranch }); return; }
    wiz.prompt = userText; wiz.step = "confirm";
    wiz.msgId = await sendKbd(chatId, confirmText(wiz), confirmButtons);
    setWizard(wiz);
  }

  const progressFor = (chatId, statusMsgId, label) => ({ stepCount, lastStep, elapsedMs }) =>
    editMsg(chatId, statusMsgId, `⏳ ${label}\nstep ${stepCount}: ${lastStep}\n${mmss(elapsedMs)} elapsed · /stop`).catch(() => {});

  const doneFor = (chatId) => async (r) => {
    const head = r.canceled ? "🛑 Stopped" : r.timedOut ? "⏱ Timed out" : r.ok ? "✅ Done" : "⚠️ Finished with errors";
    const lines = [
      `${head} · ${r.repoLabel} (${r.model}/${r.effort}) · ${mmss(r.durationMs)}`,
      `branch ${r.branch}`,
      r.filesChanged ? `${r.filesChanged} file(s) changed${r.committed ? ", committed" : ""}` : "no file changes",
    ];
    if (r.diffStat) lines.push("", r.diffStat);
    if (r.resultText) lines.push("", r.resultText.slice(0, 1200));
    if (r.auditError) lines.push("", `Security audit error: ${r.auditError}`);
    if (r.storageError) lines.push("", `Security storage error: ${r.storageError}`);
    if (r.securityError) lines.push("", `Security policy error: ${r.securityError}`);
    lines.push("", `worktree: ${r.worktreePath}`);
    const parts = chunk(lines.join("\n"));
    for (let i = 0; i < parts.length; i++) {
      const onLast = i === parts.length - 1 && r.filesChanged;
      await tg("sendMessage", { chat_id: chatId, text: parts[i], ...(onLast ? { reply_markup: kbd([[["⤴️ Push & open PR", "code:push"], ["↻ Iterate", "code:iterate"]]]) } : {}) });
    }
    try {
      const externalNotice = codingCompletionNtfyContent(r.ok);
      await ntfy(cfg, externalNotice.title, externalNotice.message,
        { priority: 4, tags: [r.ok ? "white_check_mark" : "warning"] });
    } catch { /* ntfy optional */ }
  };

  async function startJob(chatId, wiz) {
    const label = `${CODING.repos[wiz.repoKey]?.label || wiz.repoKey} · ${wiz.model}/${wiz.effort}`;
    const statusMsgId = (await tg("sendMessage", { chat_id: chatId, text: `🚀 Starting on ${label}…` }))?.result?.message_id;
    try {
      if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.spawn") !== true) throw new Error("runtime security policy denied coding spawn");
      const job = await startCodingJob({
        repoKey: wiz.repoKey,
        model: wiz.model,
        effort: wiz.effort,
        prompt: wiz.prompt,
        onProgress: progressFor(chatId, statusMsgId, label),
        onDone: doneFor(chatId),
        authorizeRuntimeAction,
        authorizeCurrentRuntimeAction,
      }, cfg);
      await editMsg(chatId, statusMsgId, `🚀 Working on ${label}\nbranch ${job.branch}\nProgress updates here · /stop`).catch(() => {});
    } catch (e) {
      await tg("sendMessage", { chat_id: chatId, text: `Couldn't start: ${e.message}` });
    }
  }

  async function startResume(chatId, followup, expected) {
    if (codingStatus().running) { await sendCodingStatus(chatId); return; }
    const last = lastCodingSession();
    if (!last) { await tg("sendMessage", { chat_id: chatId, text: "No previous coding session to continue. Start one with /code." }); return; }
    const label = `${last.repoLabel || last.repoKey} · ${last.model}/${last.effort}`;
    const statusMsgId = (await tg("sendMessage", { chat_id: chatId, text: `↻ Continuing ${label}…` }))?.result?.message_id;
    try {
      if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.spawn") !== true) throw new Error("runtime security policy denied coding resume");
      const job = await resumeCodingJob({
        prompt: followup,
        onProgress: progressFor(chatId, statusMsgId, label),
        onDone: doneFor(chatId),
        authorizeRuntimeAction,
        authorizeCurrentRuntimeAction,
        expectedSessionId: expected?.sessionId,
        expectedBranch: expected?.branch,
      }, cfg);
      await editMsg(chatId, statusMsgId, `↻ Continuing ${label}\nbranch ${job.branch} · /stop`).catch(() => {});
    } catch (e) {
      await tg("sendMessage", { chat_id: chatId, text: `Couldn't resume: ${e.message}` });
    }
  }

  async function doPush(chatId, securityBinding) {
    await tg("sendChatAction", { chat_id: chatId, action: "typing" });
    try {
      const expected = lastCodingSession();
      if (authorizeRuntimeAction && authorizeRuntimeAction("hub.runtime.mutate") !== true) throw new Error("runtime security policy denied coding push");
      const r = await pushCodingResult({
        expectedSessionId: expected?.sessionId,
        expectedBranch: expected?.branch,
        expectedHeadSha: securityBinding?.expectedSha,
        authorizeRuntimeAction,
      });
      await tg("sendMessage", { chat_id: chatId, text: r.prUrl ? `Pushed and opened PR:\n${r.prUrl}` : (r.note || "Pushed.") });
    } catch (e) {
      await tg("sendMessage", { chat_id: chatId, text: `Push failed: ${e.message}` });
    }
  }

  return { handleCode, handleCodeCallback, handleWizardPrompt, sendCodingStatus, doPush };
}

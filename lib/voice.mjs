// Voice-note transcription, factored out of hermes-bot.mjs. Local + API-free: ffmpeg downsamples
// the Telegram OGG/Opus to 16k mono WAV, whisper.cpp transcribes it. TWO models for true bilingual:
// Hebrew → ivrit-ai (Hebrew-elite); English/auto → vanilla large-v3-turbo (won't transliterate
// English into Hebrew). The pure helpers (voiceConfig, sttPlan, isHebrew) are unit-tested.

import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execText as run } from "./proc.mjs";

const VOICE_DOWNLOAD_TIMEOUT_MS = 20000;

// Resolve whisper/ffmpeg binaries + bilingual model paths from config (with the shipped defaults).
export function voiceConfig(cfg, root) {
  return {
    whisper: cfg.whisperBin || "/opt/homebrew/bin/whisper-cli",
    ffmpeg: cfg.ffmpegBin || "/opt/homebrew/bin/ffmpeg",
    modelHe: cfg.whisperModelHe || path.join(root, "models/ggml-ivrit-large-v3-turbo.bin"),   // Hebrew-elite (ivrit-ai)
    modelMulti: cfg.whisperModelMulti || path.join(root, "models/ggml-large-v3-turbo.bin"),    // multilingual (vanilla)
  };
}

// Map a language mode to {model, lang} against a resolved voiceConfig. Pure.
export function sttPlan(lang, v) {
  if (lang === "he") return { model: v.modelHe, lang: "he" };
  if (lang === "en") return { model: v.modelMulti, lang: "en" };
  return { model: v.modelMulti, lang: "auto" };
}

// Does the string contain any Hebrew letters? (drives the "heard"/"שמעתי" echo). Pure.
export function isHebrew(s) {
  return [...String(s)].some((c) => c.charCodeAt(0) >= 0x0590 && c.charCodeAt(0) <= 0x05ff);
}

// Telegram voice note (OGG/Opus) → text. Needs the bound tg + bot token (file download uses the
// file-API base). Cleans its temp files even on failure.
export async function transcribeVoice({ fileId, lang, voice, tg, token }) {
  const plan = sttPlan(lang, voice);
  if (!existsSync(plan.model)) throw new Error(`${lang} model not downloaded yet`);
  const f = await tg("getFile", { file_id: fileId });
  if (!f?.ok) throw new Error(`getFile: ${f?.description || "failed"}`);
  const r = await fetch(`https://api.telegram.org/file/bot${token}/${f.result.file_path}`, {
    signal: AbortSignal.timeout(VOICE_DOWNLOAD_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`download: ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const base = path.join(os.tmpdir(), `hermes-voice-${randomUUID()}`); // collision-proof per note
  const ogg = `${base}.oga`, wav = `${base}.wav`;
  try {
    writeFileSync(ogg, buf);
    await run(voice.ffmpeg, ["-y", "-i", ogg, "-ar", "16000", "-ac", "1", wav]);
    const out = await run(voice.whisper, ["-m", plan.model, "-f", wav, "-l", plan.lang, "-nt", "-np"]);
    return out.replace(/\s+/g, " ").trim();
  } finally {
    for (const p of [ogg, wav]) { try { unlinkSync(p); } catch { /* ignore */ } }
  }
}

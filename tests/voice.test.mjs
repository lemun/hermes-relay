import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceConfig, sttPlan, isHebrew } from "../lib/voice.mjs";

test("voiceConfig falls back to the shipped Homebrew/model defaults", () => {
  const v = voiceConfig({}, "/root");
  assert.equal(v.whisper, "/opt/homebrew/bin/whisper-cli");
  assert.equal(v.ffmpeg, "/opt/homebrew/bin/ffmpeg");
  assert.equal(v.modelHe, "/root/models/ggml-ivrit-large-v3-turbo.bin");
  assert.equal(v.modelMulti, "/root/models/ggml-large-v3-turbo.bin");
});

test("voiceConfig honors config overrides", () => {
  const v = voiceConfig({ whisperBin: "/w", ffmpegBin: "/f", whisperModelHe: "/he", whisperModelMulti: "/mu" }, "/root");
  assert.deepEqual(v, { whisper: "/w", ffmpeg: "/f", modelHe: "/he", modelMulti: "/mu" });
});

test("sttPlan: Hebrew → ivrit model+he; English → multilingual+en; auto → multilingual+auto", () => {
  const v = { modelHe: "HE", modelMulti: "MULTI" };
  assert.deepEqual(sttPlan("he", v), { model: "HE", lang: "he" });
  assert.deepEqual(sttPlan("en", v), { model: "MULTI", lang: "en" });
  assert.deepEqual(sttPlan("auto", v), { model: "MULTI", lang: "auto" });
  assert.deepEqual(sttPlan("anything-else", v), { model: "MULTI", lang: "auto" }); // default branch
});

test("isHebrew detects Hebrew letters, not Latin", () => {
  assert.equal(isHebrew("שלום עולם"), true);
  assert.equal(isHebrew("accept HOM-27"), false);
  assert.equal(isHebrew("mixed שלום text"), true);
  assert.equal(isHebrew(""), false);
});

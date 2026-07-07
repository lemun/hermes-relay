import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGrillerPrompt, parseGrillerResult, grillerLabelTransitions } from "../lib/griller.mjs";

const ISSUE = {
  number: 42,
  title: "Add dark mode toggle",
  body: "Users want a dark mode. Should persist across sessions.",
  labels: ["needs-grill"],
};

// ── buildGrillerPrompt ───────────────────────────────────────────────────────

test("buildGrillerPrompt: includes role, issue body, ask_owner instruction, and the final engine+effort question in order", () => {
  const prompt = buildGrillerPrompt({ issue: ISSUE, repoSlug: "lemun/example-app", handoffNotes: [] });

  assert.ok(prompt.includes("issue #42"));
  assert.ok(prompt.includes('"Add dark mode toggle"'));
  assert.ok(prompt.includes("lemun/example-app"));
  assert.ok(prompt.includes(ISSUE.body));
  assert.ok(prompt.includes("mcp__hermes__ask_owner"));
  assert.ok(prompt.includes("recommended answer"));
  assert.ok(/which engine/i.test(prompt));
  assert.ok(/which.*effort/i.test(prompt) || /effort.*low\/medium\/high/i.test(prompt));

  const iRole = prompt.indexOf("issue #42");
  const iAskOwner = prompt.indexOf("mcp__hermes__ask_owner");
  const iEngineQuestion = prompt.indexOf("Your LAST ask_owner call");
  const iJsonContract = prompt.indexOf("```json");
  assert.ok(iRole < iAskOwner, "role/body comes before the ask_owner instruction");
  assert.ok(iAskOwner < iEngineQuestion, "ask_owner instruction comes before the final engine+effort question");
  assert.ok(iEngineQuestion < iJsonContract, "final question comes before the fenced-json contract");
});

test("buildGrillerPrompt: fenced json contract lists all required keys", () => {
  const prompt = buildGrillerPrompt({ issue: ISSUE, repoSlug: "lemun/example-app", handoffNotes: [] });
  for (const key of ["ready", "decisions", "assumptions", "handoffNote", "engine", "effort", "blockedReason"]) {
    assert.ok(prompt.includes(`"${key}"`), `contract should mention "${key}"`);
  }
});

test("buildGrillerPrompt: includes prior handoff notes under a heading when given", () => {
  const withNotes = buildGrillerPrompt({
    issue: ISSUE,
    repoSlug: "lemun/example-app",
    handoffNotes: ["earlier session found the toggle lives in SettingsScreen.tsx"],
  });
  assert.ok(/Previous session handoff/i.test(withNotes));
  assert.ok(withNotes.includes("earlier session found the toggle lives in SettingsScreen.tsx"));

  const withoutNotes = buildGrillerPrompt({ issue: ISSUE, repoSlug: "lemun/example-app", handoffNotes: [] });
  assert.equal(/Previous session handoff/i.test(withoutNotes), false);
});

test("buildGrillerPrompt: handles missing labels gracefully", () => {
  const noLabels = { number: 7, title: "Fix crash", body: "crashes on launch", labels: undefined };
  const prompt = buildGrillerPrompt({ issue: noLabels, repoSlug: "lemun/example-web", handoffNotes: [] });
  assert.ok(prompt.includes("issue #7"));
  assert.ok(prompt.includes("(none)"));
});

// ── parseGrillerResult ───────────────────────────────────────────────────────

test("parseGrillerResult: happy path parses the fenced json block", () => {
  const text = [
    "I've finished interrogating the design.",
    "```json",
    JSON.stringify({
      ready: true,
      decisions: ["use AsyncStorage for persistence"],
      assumptions: ["assumed: no server sync needed because issue only mentions local persistence"],
      handoffNote: "touch SettingsScreen.tsx, add a toggle bound to a new ThemeContext",
      engine: "claude",
      effort: "medium",
      blockedReason: null,
    }),
    "```",
  ].join("\n");

  assert.deepEqual(parseGrillerResult(text), {
    ready: true,
    decisions: ["use AsyncStorage for persistence"],
    assumptions: ["assumed: no server sync needed because issue only mentions local persistence"],
    handoffNote: "touch SettingsScreen.tsx, add a toggle bound to a new ThemeContext",
    engine: "claude",
    effort: "medium",
    blockedReason: null,
  });
});

test("parseGrillerResult: tolerates leading/trailing prose around the fenced block", () => {
  const text = [
    "Some rambling analysis text here.",
    "More thoughts.",
    "```json",
    JSON.stringify({ ready: true, decisions: [], assumptions: [], handoffNote: "go", engine: "codex", effort: "low", blockedReason: null }),
    "```",
    "Thanks for reading!",
  ].join("\n");
  const result = parseGrillerResult(text);
  assert.equal(result.ready, true);
  assert.equal(result.engine, "codex");
});

test("parseGrillerResult: takes the LAST fenced json block when multiple are present", () => {
  const text = [
    "```json",
    JSON.stringify({ ready: false, engine: "claude", effort: "low" }),
    "```",
    "actually, let me reconsider...",
    "```json",
    JSON.stringify({ ready: true, engine: "codex", effort: "high" }),
    "```",
  ].join("\n");
  const result = parseGrillerResult(text);
  assert.equal(result.ready, true);
  assert.equal(result.engine, "codex");
  assert.equal(result.effort, "high");
});

test("parseGrillerResult: defaults engine to codex and effort to high when missing", () => {
  const text = "```json\n" + JSON.stringify({ ready: true }) + "\n```";
  const result = parseGrillerResult(text);
  assert.equal(result.engine, "codex");
  assert.equal(result.effort, "high");
  assert.deepEqual(result.decisions, []);
  assert.deepEqual(result.assumptions, []);
  assert.equal(result.handoffNote, "");
  assert.equal(result.blockedReason, null);
});

test("parseGrillerResult: rejects an out-of-enum engine/effort back to defaults", () => {
  const text = "```json\n" + JSON.stringify({ ready: true, engine: "gpt5", effort: "extreme" }) + "\n```";
  const result = parseGrillerResult(text);
  assert.equal(result.engine, "codex");
  assert.equal(result.effort, "high");
});

test("parseGrillerResult: returns null when there is no parseable json block", () => {
  assert.equal(parseGrillerResult("just some prose, no json at all"), null);
  assert.equal(parseGrillerResult(""), null);
  assert.equal(parseGrillerResult(null), null);
  assert.equal(parseGrillerResult("```json\n{ not valid json \n```"), null);
});

// ── grillerLabelTransitions ───────────────────────────────────────────────────

test("grillerLabelTransitions: ready with codex engine adds only 'ready', no engine label", () => {
  const t = grillerLabelTransitions({ ready: true, engine: "codex" });
  assert.deepEqual(t.add, ["ready"]);
  assert.deepEqual(t.remove, ["needs-grill", "grilling"]);
});

test("grillerLabelTransitions: ready with claude engine also adds engine:claude", () => {
  const t = grillerLabelTransitions({ ready: true, engine: "claude" });
  assert.deepEqual(t.add, ["ready", "engine:claude"]);
  assert.deepEqual(t.remove, ["needs-grill", "grilling"]);
});

test("grillerLabelTransitions: not ready adds blocked and removes the grilling labels", () => {
  const t = grillerLabelTransitions({ ready: false, blockedReason: "needs owner input on scope" });
  assert.deepEqual(t.add, ["blocked"]);
  assert.deepEqual(t.remove, ["needs-grill", "grilling"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isAuthorized, issueUrl, writeJsonAtomic, resolveIssue, gatherBoardSignals,
  deriveHealth, nextHealthDueMs, evaluateBridgeHealth,
  loadConfig, isConfigError, formatConfigError,
} from "../lib/paperclip.mjs";
import {
  boardWriteEnabled, acceptCard, rejectCard, parseActIntent,
} from "../lib/paperclip-write.mjs";

test("isAuthorized fails closed when no chat id is configured", () => {
  assert.equal(isAuthorized(0, "123"), false);     // unset → "0"
  assert.equal(isAuthorized("", "123"), false);
  assert.equal(isAuthorized(null, "123"), false);
  assert.equal(isAuthorized(undefined, "123"), false);
});

test("isAuthorized allows only the exact configured chat id", () => {
  assert.equal(isAuthorized("555", "555"), true);
  assert.equal(isAuthorized(555, 555), true);       // numeric forms compare equal
  assert.equal(isAuthorized("555", "556"), false);
  assert.equal(isAuthorized("555", ""), false);
});

test("issueUrl builds the app's canonical /<prefix>/issues/<identifier> url, or undefined without uiBaseUrl", () => {
  const cfg = { uiBaseUrl: "http://host:3100/", issuePrefix: "HOM" };
  assert.equal(issueUrl(cfg, "HOM-27"), "http://host:3100/HOM/issues/HOM-27");
  assert.equal(issueUrl({ issuePrefix: "HOM" }, "HOM-27"), undefined);
  assert.equal(issueUrl(cfg, undefined), undefined);
});

test("writeJsonAtomic writes valid JSON and leaves no temp file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-atomic-"));
  try {
    const f = path.join(dir, "state.json");
    writeJsonAtomic(f, { a: 1, b: [2, 3] });
    assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { a: 1, b: [2, 3] });
    assert.equal(readdirSync(dir).some((n) => n.includes(".tmp-")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig identifies missing, malformed, and invalid config with copyable setup guidance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-config-"));
  const configPath = path.join(dir, "config.json");
  const opts = { configPath, dotenvPath: null };
  try {
    assert.throws(() => loadConfig(opts), (error) => {
      assert.equal(isConfigError(error), true);
      assert.equal(error.kind, "missing");
      assert.match(formatConfigError(error), /cp config\.example\.json config\.json/);
      assert.match(formatConfigError(error), /cp \.env\.example \.env/);
      return true;
    });

    writeFileSync(configPath, "{ not json");
    assert.throws(() => loadConfig(opts), (error) => {
      assert.equal(isConfigError(error), true);
      assert.equal(error.kind, "malformed");
      assert.match(formatConfigError(error), /malformed JSON/);
      return true;
    });

    writeFileSync(configPath, "[]");
    assert.throws(() => loadConfig(opts), (error) => {
      assert.equal(isConfigError(error), true);
      assert.equal(error.kind, "invalid");
      assert.match(formatConfigError(error), /top level must be a JSON object/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fetch-mocked tests for the read-only API client ──────────────────────────
function withFakeApi(routes, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[key] };
  };
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}

const CFG = { paperclipBase: "http://127.0.0.1:3100", companyId: "co-1", issuePrefix: "HOM" };

test("resolveIssue maps HOM-N to the matching issue via the issue list", async () => {
  await withFakeApi({
    "/companies/co-1/issues": [
      { id: "uuid-a", identifier: "HOM-27", issueNumber: 27, title: "Landing", status: "in_review" },
      { id: "uuid-b", identifier: "HOM-3", issueNumber: 3, title: "Auth", status: "done" },
    ],
  }, async () => {
    const hit = await resolveIssue(CFG, "HOM-27");
    assert.equal(hit.id, "uuid-a");
    const byNum = await resolveIssue(CFG, "27"); // bare number also resolves
    assert.equal(byNum.identifier, "HOM-27");
  });
});

test("gatherBoardSignals surfaces pending cards (on in_review issues) and agents in error", async () => {
  await withFakeApi({
    "/companies/co-1/issues": [
      { id: "i1", identifier: "HOM-1", title: "A", status: "in_review" },
      { id: "i2", identifier: "HOM-2", title: "B", status: "done" }, // not in_review → skipped
    ],
    "/issues/i1/interactions": [
      { id: "int1", kind: "request_confirmation", title: "Approve deploy", status: "pending", createdAt: "2026-06-18T10:00:00Z" },
      { id: "int2", kind: "request_confirmation", title: "Old", status: "resolved" }, // not pending → skipped
    ],
    "/companies/co-1/agents": [
      { id: "ag1", name: "eng-lead", status: "error", lastHeartbeatAt: "2026-06-18T09:00:00Z" },
      { id: "ag2", name: "growth-lead", status: "idle" },
    ],
  }, async () => {
    const { pending, errors } = await gatherBoardSignals(CFG);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].issueIdentifier, "HOM-1");
    assert.equal(pending[0].title, "Approve deploy");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].name, "eng-lead");
  });
});

// ── deriveHealth: the watchdog's two deterministic signals ────────────────────
const T0 = Date.parse("2026-06-21T12:00:00Z");
const HEALTH = { enabled: true, stuckRunningMinutes: 25, errorEscalateFirstHours: 1, errorEscalateThenHours: 24 };

test("deriveHealth flags an agent in error (sticky, keyed by id not heartbeat)", () => {
  const agents = [{ id: "ag1", name: "web-engineer", status: "error", lastHeartbeatAt: "2026-06-20T20:51:00Z" }];
  const out = deriveHealth(agents, [], T0, HEALTH);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "error");
  assert.equal(out[0].conditionKey, "error:ag1"); // NOT keyed on the heartbeat ts → survives a frozen heartbeat
  assert.match(out[0].title, /web-engineer/);
});

test("deriveHealth ignores a days-stale IDLE agent (the false-positive the heartbeat rule would cause)", () => {
  // seo-specialist-shaped: healthy, idle, heartbeat 3 days old. MUST yield nothing.
  const agents = [
    { id: "a", name: "seo-specialist", status: "idle", lastHeartbeatAt: "2026-06-18T05:52:00Z" },
    { id: "b", name: "ui-ux", status: "idle", lastHeartbeatAt: "2026-06-17T18:47:00Z" },
  ];
  assert.deepEqual(deriveHealth(agents, [], T0, HEALTH), []);
});

test("deriveHealth flags a stuck run only when activeRun is old enough", () => {
  const agents = [{ id: "ag1", name: "eng-lead", status: "running" }];
  const old = {
    id: "i1", identifier: "HOM-53", title: "Edge config", assigneeAgentId: "ag1",
    activeRun: { id: "run1", status: "running", agentId: "ag1", startedAt: "2026-06-21T11:00:00Z" }, // 60m old
  };
  const fresh = { ...old, id: "i2", identifier: "HOM-9", activeRun: { id: "run2", status: "running", agentId: "ag1", startedAt: "2026-06-21T11:50:00Z" } }; // 10m old
  const out = deriveHealth(agents, [old, fresh], T0, HEALTH);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "stuck");
  assert.equal(out[0].conditionKey, "stuck:i1:run1"); // keyed on run → a new run is a new condition
  assert.equal(out[0].issueIdentifier, "HOM-53");
});

test("deriveHealth ignores a finished/non-running activeRun and a null one", () => {
  const issues = [
    { id: "i1", identifier: "HOM-2", activeRun: null },
    { id: "i2", identifier: "HOM-3", activeRun: { id: "r", status: "succeeded", startedAt: "2026-06-21T01:00:00Z" } },
  ];
  assert.deepEqual(deriveHealth([], issues, T0, HEALTH), []);
});

test("deriveHealth honors the enabled=false kill switch", () => {
  const agents = [{ id: "ag1", name: "x", status: "error", lastHeartbeatAt: "2026-06-20T20:51:00Z" }];
  assert.deepEqual(deriveHealth(agents, [], T0, { ...HEALTH, enabled: false }), []);
});

test("deriveHealth flags a running run with an UNPARSEABLE start instead of silently skipping it", () => {
  // The watchdog must not go quiet on schema/timestamp drift — a NaN age would otherwise be dropped.
  const issues = [{ id: "i9", identifier: "HOM-9", activeRun: { id: "r9", status: "running", agentId: "ag1", startedAt: "not-a-date" } }];
  const out = deriveHealth([{ id: "ag1", name: "eng" }], issues, T0, HEALTH);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "stuck");
  assert.equal(out[0].conditionKey, "stuck:i9:r9");
  assert.match(out[0].body, /unparseable/i);
});

test("nextHealthDueMs returns 0 for a never-notified or null record", () => {
  assert.equal(nextHealthDueMs(null, HEALTH), 0);
  assert.equal(nextHealthDueMs({ notifyCount: 0, firstSeenAt: T0, lastNotifiedAt: T0 }, HEALTH), 0);
  // notifyCount ≥ 2 keeps re-paging on the daily curve from the LAST notification, not firstSeen.
  const afterThree = { firstSeenAt: T0, lastNotifiedAt: T0 + 5 * 3600 * 1000, notifyCount: 3 };
  assert.equal(nextHealthDueMs(afterThree, HEALTH), T0 + 5 * 3600 * 1000 + 24 * 3600 * 1000);
});

test("nextHealthDueMs escalates 1h-then-daily, not every tick", () => {
  const first = T0;
  // After the first ping (count 1), the next is due 1h later — not immediately.
  const afterOne = { firstSeenAt: first, lastNotifiedAt: first, notifyCount: 1 };
  assert.equal(nextHealthDueMs(afterOne, HEALTH), first + 3600 * 1000);
  assert.ok(nextHealthDueMs(afterOne, HEALTH) > first); // not re-paged on the very next tick
  // After the second ping, subsequent re-pings are daily from the last notification.
  const afterTwo = { firstSeenAt: first, lastNotifiedAt: first + 3600 * 1000, notifyCount: 2 };
  assert.equal(nextHealthDueMs(afterTwo, HEALTH), first + 3600 * 1000 + 24 * 3600 * 1000);
});

// ── evaluateBridgeHealth: the self-health probe's decision logic ──────────────
const WEDGED_MS = 5 * 60 * 1000;

test("evaluateBridgeHealth is silent when API is up and the heartbeat is fresh", () => {
  const hb = { at: T0 - 30 * 1000 }; // 30s old
  assert.deepEqual(evaluateBridgeHealth(T0, { apiOk: true, heartbeat: hb, wedgedMs: WEDGED_MS }), []);
});

test("evaluateBridgeHealth flags a down API", () => {
  const hb = { at: T0 - 30 * 1000 };
  const out = evaluateBridgeHealth(T0, { apiOk: false, apiDetail: "ECONNREFUSED", heartbeat: hb, wedgedMs: WEDGED_MS });
  assert.equal(out.length, 1);
  assert.equal(out[0].conditionKey, "api");
  assert.match(out[0].body, /ECONNREFUSED/);
});

test("evaluateBridgeHealth flags a missing heartbeat (notifier never started)", () => {
  const out = evaluateBridgeHealth(T0, { apiOk: true, heartbeat: null, wedgedMs: WEDGED_MS });
  assert.equal(out.length, 1);
  assert.equal(out[0].conditionKey, "notifier");
  assert.match(out[0].title, /missing/i);
});

test("evaluateBridgeHealth flags a STALE heartbeat (notifier wedged) but not a fresh one", () => {
  const stale = { at: T0 - 6 * 60 * 1000 }; // 6m old > 5m threshold
  const out = evaluateBridgeHealth(T0, { apiOk: true, heartbeat: stale, wedgedMs: WEDGED_MS });
  assert.equal(out.length, 1);
  assert.equal(out[0].conditionKey, "notifier");
  assert.match(out[0].title, /wedged|down/i);
  // exactly at the boundary is still fresh (uses strict >)
  assert.deepEqual(evaluateBridgeHealth(T0, { apiOk: true, heartbeat: { at: T0 - WEDGED_MS }, wedgedMs: WEDGED_MS }), []);
});

test("evaluateBridgeHealth can report BOTH api-down and notifier-wedged at once", () => {
  const out = evaluateBridgeHealth(T0, { apiOk: false, apiDetail: "HTTP 502", heartbeat: { at: T0 - 10 * 60 * 1000 }, wedgedMs: WEDGED_MS });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.conditionKey).sort(), ["api", "notifier"]);
});

// ── board write client: fail-closed, narrow surface, no generic forwarder ─────
function withCapturedFetch(response, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: response.ok ?? true, status: response.status ?? 200, text: async () => response.text ?? "{}" }; };
  return Promise.resolve(fn(calls)).finally(() => { globalThis.fetch = real; });
}

test("boardWriteEnabled reflects whether a key is configured", () => {
  assert.equal(boardWriteEnabled({ boardApiKey: "" }), false);
  assert.equal(boardWriteEnabled({ boardApiKey: "k-1" }), true);
});

test("acceptCard FAILS CLOSED with no board key (env + cfg both empty)", async () => {
  const prev = process.env.PAPERCLIP_BOARD_API_KEY;
  delete process.env.PAPERCLIP_BOARD_API_KEY;
  try {
    await assert.rejects(
      () => acceptCard({ paperclipBase: "http://127.0.0.1:3100" }, "i1", "int1"),
      /disabled|PAPERCLIP_BOARD_API_KEY/,
    );
  } finally { if (prev !== undefined) process.env.PAPERCLIP_BOARD_API_KEY = prev; }
});

test("acceptCard POSTs the exact route with bearer auth and an empty body", async () => {
  await withCapturedFetch({ text: "{}" }, async (calls) => {
    await acceptCard({ paperclipBase: "http://127.0.0.1:3100", boardApiKey: "k-123" }, "issue-1", "int-9");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:3100/api/issues/issue-1/interactions/int-9/accept");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers.authorization, "Bearer k-123");
    assert.equal(calls[0].opts.body, "{}"); // no stray fields
  });
});

test("rejectCard sends ONLY the reason key, dropping anything else (no field smuggling)", async () => {
  await withCapturedFetch({ text: "{}" }, async (calls) => {
    await rejectCard({ paperclipBase: "http://h", boardApiKey: "k" }, "i", "int", { reason: "wait for QA", status: "done", interrupt: true });
    assert.deepEqual(JSON.parse(calls[0].opts.body), { reason: "wait for QA" });
  });
});

test("write client surfaces a non-2xx as a thrown error", async () => {
  await withCapturedFetch({ ok: false, status: 403, text: '{"error":"forbidden"}' }, async () => {
    await assert.rejects(() => acceptCard({ paperclipBase: "http://h", boardApiKey: "k" }, "i", "int"), /403|forbidden/);
  });
});

test("parseActIntent acts only on an unambiguous verb+number", () => {
  assert.deepEqual(parseActIntent("accept HOM-27"), { verb: "accept", num: "27", reason: "" });
  assert.deepEqual(parseActIntent("/approve 27"), { verb: "accept", num: "27", reason: "" });
  assert.equal(parseActIntent("accept the changes"), null);   // no number → leave to concierge
  assert.equal(parseActIntent("what needs me"), null);
  const r = parseActIntent("reject HOM-5 wait for QA sign-off");
  assert.equal(r.verb, "reject"); assert.equal(r.num, "5");
  assert.match(r.reason, /wait for QA sign-off/);
});

test("parseActIntent maps every verb alias and tolerant id spellings", () => {
  assert.equal(parseActIntent("approve 27").verb, "accept");
  assert.equal(parseActIntent("deny 27").verb, "reject");
  assert.equal(parseActIntent("decline 27").verb, "reject");
  // dashed / undashed / spaced ids all resolve to the bare number
  assert.equal(parseActIntent("accept HOM-27").num, "27");
  assert.equal(parseActIntent("accept HOM27").num, "27");
  assert.equal(parseActIntent("accept HOM 27").num, "27");
  // reject reason has leading punctuation stripped
  assert.equal(parseActIntent("reject 5: needs QA").reason, "needs QA");
  // accept never carries a reason
  assert.equal(parseActIntent("accept 5 looks great").reason, "");
});

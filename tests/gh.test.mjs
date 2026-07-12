import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ghFetch, clearTokenCache, pollRepoIssues, filterByLabel, issueLabels,
  addLabels, removeLabel, createCoalescedEditor, getChecksForRef, adaptivePollDelayMs,
  listRepoLabels, createRepoLabel, createComment, editComment, createIssue, mergePr,
} from "../lib/gh.mjs";

// ── test helpers ──────────────────────────────────────────────────────────────

// Minimal Headers-like object (case-insensitive get, like the real fetch Headers).
function headers(obj = {}) {
  const map = new Map(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { get: (k) => (map.has(k.toLowerCase()) ? map.get(k.toLowerCase()) : null) };
}

function fakeRes({ status, json = null, headers: h = {} }) {
  return {
    status,
    headers: headers(h),
    json: async () => json,
  };
}

const execOk = (token) => async () => ({ code: 0, stdout: `${token}\n`, stderr: "" });

// ── ghFetch ───────────────────────────────────────────────────────────────────

test("ghFetch sends If-None-Match and surfaces 304 with etag passthrough", async () => {
  let seenHeaders;
  const fetchImpl = async (url, opts) => {
    seenHeaders = opts.headers;
    assert.equal(url, "https://api.github.com/repos/a/b/issues?state=open&per_page=100");
    return fakeRes({ status: 304, headers: { etag: '"abc123"' } });
  };
  const res = await ghFetch("/repos/a/b/issues?state=open&per_page=100", {
    etag: '"abc123"', token: "tok", fetchImpl,
  });
  assert.equal(seenHeaders["If-None-Match"], '"abc123"');
  assert.equal(seenHeaders.Accept, "application/vnd.github+json");
  assert.equal(seenHeaders.Authorization, "Bearer tok");
  assert.equal(res.status, 304);
  assert.equal(res.json, null);
  assert.equal(res.etag, '"abc123"');
});

test("ghFetch retries once with a fresh token on 401", async () => {
  clearTokenCache();
  let call = 0;
  const execImpl = async () => {
    call += 1;
    return { code: 0, stdout: `token-${call}\n`, stderr: "" };
  };
  const seenAuth = [];
  const fetchImpl = async (url, opts) => {
    seenAuth.push(opts.headers.Authorization);
    if (opts.headers.Authorization === "Bearer token-1") return fakeRes({ status: 401 });
    return fakeRes({ status: 200, json: { ok: true } });
  };
  const res = await ghFetch("/repos/a/b", { fetchImpl, execImpl });
  assert.deepEqual(seenAuth, ["Bearer token-1", "Bearer token-2"]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true });
  clearTokenCache();
});

test("ghFetch returns retryAfterMs on 403 with Retry-After header (never throws)", async () => {
  const fetchImpl = async () => fakeRes({ status: 403, headers: { "retry-after": "30" } });
  const res = await ghFetch("/repos/a/b", { token: "t", fetchImpl });
  assert.equal(res.status, 403);
  assert.equal(res.retryAfterMs, 30000);
});

test("ghFetch returns retryAfterMs on 429 with x-ratelimit-remaining: 0 (no Retry-After)", async () => {
  const resetAt = Math.floor(Date.now() / 1000) + 45;
  const fetchImpl = async () => fakeRes({
    status: 429,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
  });
  const res = await ghFetch("/repos/a/b", { token: "t", fetchImpl });
  assert.equal(res.status, 429);
  assert.ok(res.retryAfterMs > 0);
});

// ── pollRepoIssues ────────────────────────────────────────────────────────────

test("pollRepoIssues drops pull_request entries and returns issues on 200", async () => {
  const fetchImpl = async () => fakeRes({
    status: 200,
    headers: { etag: '"new-etag"' },
    json: [
      { number: 1, title: "real issue" },
      { number: 2, title: "a PR", pull_request: { url: "x" } },
      { number: 3, title: "another issue", labels: [{ name: "ready" }] },
    ],
  });
  const res = await pollRepoIssues({ slug: "a/b", token: "t", fetchImpl });
  assert.equal(res.changed, true);
  assert.equal(res.etag, '"new-etag"');
  assert.equal(res.issues.length, 2);
  assert.deepEqual(res.issues.map((i) => i.number), [1, 3]);
});

test("pollRepoIssues returns changed:false on 304", async () => {
  const fetchImpl = async () => fakeRes({ status: 304, headers: { etag: '"same"' } });
  const res = await pollRepoIssues({ slug: "a/b", etag: '"same"', token: "t", fetchImpl });
  assert.deepEqual(res, { changed: false, etag: '"same"' });
});

// ── label helpers ─────────────────────────────────────────────────────────────

test("issueLabels/filterByLabel work off label objects with .name", () => {
  const issues = [
    { number: 1, labels: [{ name: "ready" }, { name: "engine:codex" }] },
    { number: 2, labels: [{ name: "blocked" }] },
  ];
  assert.deepEqual(issueLabels(issues[0]), ["ready", "engine:codex"]);
  assert.deepEqual(filterByLabel(issues, "ready").map((i) => i.number), [1]);
});

// ── labels (write) ────────────────────────────────────────────────────────────

test("addLabels posts the correct body to /issues/{n}/labels", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, method: opts.method, body: JSON.parse(opts.body) };
    return fakeRes({ status: 200, json: [] });
  };
  await addLabels({ slug: "a/b", issue: 42, labels: ["ready", "engine:codex"], token: "t", fetchImpl });
  assert.equal(seen.url, "https://api.github.com/repos/a/b/issues/42/labels");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, { labels: ["ready", "engine:codex"] });
});

test("removeLabel treats 404 as success", async () => {
  let seenUrl;
  const fetchImpl = async (url) => { seenUrl = url; return fakeRes({ status: 404 }); };
  const res = await removeLabel({ slug: "a/b", issue: 42, label: "needs-grill", token: "t", fetchImpl });
  assert.equal(seenUrl, "https://api.github.com/repos/a/b/issues/42/labels/needs-grill");
  assert.equal(res.status, 200);
});

test("removeLabel URL-encodes the label name", async () => {
  let seenUrl;
  const fetchImpl = async (url) => { seenUrl = url; return fakeRes({ status: 200, json: [] }); };
  await removeLabel({ slug: "a/b", issue: 1, label: "engine:claude", token: "t", fetchImpl });
  assert.equal(seenUrl, "https://api.github.com/repos/a/b/issues/1/labels/engine%3Aclaude");
});

test("addLabels throws on missing-label 422 instead of silently advancing state", async () => {
  const fetchImpl = async () => fakeRes({ status: 422, json: { message: "Validation Failed" } });
  await assert.rejects(
    addLabels({ slug: "a/b", issue: 1, labels: ["missing-label"], token: "t", fetchImpl }),
    /add labels missing-label to a\/b#1 failed: Validation Failed/
  );
});

test("removeLabel throws on a real failure (not 404)", async () => {
  const fetchImpl = async () => fakeRes({ status: 500, json: { message: "boom" } });
  await assert.rejects(
    removeLabel({ slug: "a/b", issue: 1, label: "x", token: "t", fetchImpl }),
    /remove label x from a\/b#1 failed: boom/
  );
});

test("listRepoLabels reads repository labels and createRepoLabel posts the required shape", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === "POST") return fakeRes({ status: 201, json: { name: "needs-grill" } });
    return fakeRes({ status: 200, json: [{ name: "ready" }] });
  };
  const labels = await listRepoLabels({ slug: "a/b", token: "t", fetchImpl });
  await createRepoLabel({
    slug: "a/b",
    name: "needs-grill",
    color: "FBCA04",
    description: "Needs owner/product grilling before dispatch",
    token: "t",
    fetchImpl,
  });
  assert.deepEqual(labels, [{ name: "ready" }]);
  assert.equal(calls[0].url, "https://api.github.com/repos/a/b/labels?per_page=100");
  assert.deepEqual(calls[1].body, {
    name: "needs-grill",
    color: "FBCA04",
    description: "Needs owner/product grilling before dispatch",
  });
});

test("comment and issue mutations throw on unexpected non-2xx responses", async () => {
  const fetchImpl = async () => fakeRes({ status: 422, json: { message: "Validation Failed" } });
  await assert.rejects(
    createComment({ slug: "a/b", issue: 1, body: "hi", token: "t", fetchImpl }),
    /create comment on a\/b#1 failed: Validation Failed/
  );
  await assert.rejects(
    editComment({ slug: "a/b", commentId: 123, body: "hi", token: "t", fetchImpl }),
    /edit comment 123 on a\/b failed: Validation Failed/
  );
  await assert.rejects(
    createIssue({ slug: "a/b", title: "T", body: "B", labels: [], token: "t", fetchImpl }),
    /create issue in a\/b failed: Validation Failed/
  );
});

// ── coalesced editor ──────────────────────────────────────────────────────────

// Fake timer harness: setTimeoutImpl/clearTimeoutImpl capture callbacks against a manual clock.
// advance(ms) moves the clock forward and fires any timers whose deadline has passed.
function makeFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, cb }
  return {
    now: () => now,
    setTimeoutImpl: (cb, delay) => {
      const id = nextId++;
      timers.set(id, { at: now + delay, cb });
      return id;
    },
    clearTimeoutImpl: (id) => { timers.delete(id); },
    advance(ms) {
      now += ms;
      // Fire due timers in schedule order; a fired timer's callback may itself schedule more
      // work synchronously (not in this editor's case, but keep it robust).
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(id)) {
          timers.delete(id);
          t.cb();
        }
      }
    },
  };
}

test("coalesced editor: first schedule for a comment fires immediately", async () => {
  const clock = makeFakeClock();
  const edits = [];
  const editImpl = async (e) => { edits.push(e); };
  const editor = createCoalescedEditor({
    minIntervalMs: 7000, editImpl, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl, now: clock.now,
  });
  editor.schedule({ slug: "a/b", commentId: 1, body: "first" });
  // fire() is async but not awaited by schedule(); let microtasks flush.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(edits, [{ slug: "a/b", commentId: 1, body: "first" }]);
  assert.equal(editor.pendingCount(), 0);
});

test("coalesced editor: second schedule within the window is deferred to the boundary, body overwrites", async () => {
  const clock = makeFakeClock();
  const edits = [];
  const editImpl = async (e) => { edits.push(e); };
  const editor = createCoalescedEditor({
    minIntervalMs: 7000, editImpl, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl, now: clock.now,
  });

  editor.schedule({ slug: "a/b", commentId: 1, body: "v1" });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(edits.length, 1);

  clock.advance(2000); // still within the 7s window
  editor.schedule({ slug: "a/b", commentId: 1, body: "v2" });
  assert.equal(editor.pendingCount(), 1); // a trailing timer is armed, not fired yet
  assert.equal(edits.length, 1);

  clock.advance(1000); // t=3000, within window — schedule again; same-comment body overwrites
  editor.schedule({ slug: "a/b", commentId: 1, body: "v3" });
  assert.equal(editor.pendingCount(), 1); // still one timer, not a second one

  clock.advance(4000); // t=7000 — boundary reached, trailing timer fires
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(edits, [
    { slug: "a/b", commentId: 1, body: "v1" },
    { slug: "a/b", commentId: 1, body: "v3" }, // last write wins — v2 was overwritten, never sent
  ]);
  assert.equal(editor.pendingCount(), 0);
});

test("coalesced editor: flush() fires all pending edits immediately", async () => {
  const clock = makeFakeClock();
  const edits = [];
  const editImpl = async (e) => { edits.push(e); };
  const editor = createCoalescedEditor({
    minIntervalMs: 7000, editImpl, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl, now: clock.now,
  });

  editor.schedule({ slug: "a/b", commentId: 1, body: "v1" });
  await Promise.resolve(); await Promise.resolve();
  editor.schedule({ slug: "a/b", commentId: 1, body: "v2" }); // deferred, timer armed
  assert.equal(editor.pendingCount(), 1);

  await editor.flush();
  assert.deepEqual(edits, [
    { slug: "a/b", commentId: 1, body: "v1" },
    { slug: "a/b", commentId: 1, body: "v2" },
  ]);
  assert.equal(editor.pendingCount(), 0);
});

test("coalesced editor: distinct commentIds are tracked independently", async () => {
  const clock = makeFakeClock();
  const edits = [];
  const editImpl = async (e) => { edits.push(e); };
  const editor = createCoalescedEditor({
    minIntervalMs: 7000, editImpl, setTimeoutImpl: clock.setTimeoutImpl, clearTimeoutImpl: clock.clearTimeoutImpl, now: clock.now,
  });

  editor.schedule({ slug: "a/b", commentId: 1, body: "c1-v1" });
  editor.schedule({ slug: "a/b", commentId: 2, body: "c2-v1" });
  await Promise.resolve(); await Promise.resolve();
  // Both fire immediately — independent comments, each is a "first schedule" for its own id.
  assert.deepEqual(edits.sort((a, b) => a.commentId - b.commentId), [
    { slug: "a/b", commentId: 1, body: "c1-v1" },
    { slug: "a/b", commentId: 2, body: "c2-v1" },
  ]);

  clock.advance(1000);
  editor.schedule({ slug: "a/b", commentId: 1, body: "c1-v2" }); // deferred
  assert.equal(editor.pendingCount(), 1);
  // comment 2 has its own clock — nothing pending for it yet.

  clock.advance(6000); // t=7000 relative to comment 1's last fire
  await Promise.resolve(); await Promise.resolve();
  assert.equal(edits.length, 3);
  assert.deepEqual(edits[2], { slug: "a/b", commentId: 1, body: "c1-v2" });
});

// ── check runs ────────────────────────────────────────────────────────────────

test("getChecksForRef summarizes pending/failed correctly", async () => {
  const fetchImpl = async () => fakeRes({
    status: 200,
    json: {
      check_runs: [
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
        { status: "in_progress", conclusion: null },
        { status: "completed", conclusion: "neutral" },
        { status: "queued", conclusion: null },
        { status: "completed", conclusion: "cancelled" },
      ],
    },
  });
  const res = await getChecksForRef({ slug: "a/b", ref: "deadbeef", token: "t", fetchImpl });
  assert.deepEqual(res, { available: true, total: 6, pending: 2, failed: 2 });
});

test("getChecksForRef returns unavailable on denied checks fetch instead of fake green", async () => {
  const fetchImpl = async () => fakeRes({ status: 403, json: { message: "Resource not accessible" } });
  assert.deepEqual(
    await getChecksForRef({ slug: "a/b", ref: "deadbeef", token: "t", fetchImpl }),
    { available: false, reason: "GitHub denied check reads: Resource not accessible" },
  );
});

test("getChecksForRef returns unavailable on retry-after rate limits", async () => {
  const fetchImpl = async () => fakeRes({ status: 403, headers: { "retry-after": "12" } });
  assert.deepEqual(
    await getChecksForRef({ slug: "a/b", ref: "deadbeef", token: "t", fetchImpl }),
    { available: false, reason: "GitHub rate limited check reads; retry after 12000ms", retryAfterMs: 12000 },
  );
});

test("getChecksForRef returns unavailable on malformed check responses", async () => {
  const fetchImpl = async () => fakeRes({ status: 200, json: { check_runs: null } });
  assert.deepEqual(
    await getChecksForRef({ slug: "a/b", ref: "deadbeef", token: "t", fetchImpl }),
    { available: false, reason: "GitHub check-runs response missing check_runs" },
  );
});

test("mergePr returns expected merge blockers but throws unexpected API failures", async () => {
  let seenBody;
  let fetchImpl = async () => fakeRes({ status: 409, json: { message: "Merge conflict" } });
  assert.deepEqual(
    await mergePr({ slug: "a/b", number: 7, token: "t", fetchImpl }),
    { merged: false, message: "Merge conflict" }
  );

  fetchImpl = async (_url, opts) => {
    seenBody = JSON.parse(opts.body);
    return fakeRes({ status: 200, json: { merged: true, message: "ok" } });
  };
  assert.deepEqual(
    await mergePr({ slug: "a/b", number: 7, expectedHeadSha: "abc123", token: "t", fetchImpl }),
    { merged: true, message: "ok" },
  );
  assert.equal(seenBody.sha, "abc123");

  fetchImpl = async () => fakeRes({ status: 422, json: { message: "Validation Failed" } });
  await assert.rejects(
    mergePr({ slug: "a/b", number: 7, token: "t", fetchImpl }),
    /merge PR a\/b#7 failed: Validation Failed/
  );
});

// ── adaptivePollDelayMs ───────────────────────────────────────────────────────

test("adaptivePollDelayMs returns 30s active / 180s idle defaults", () => {
  assert.equal(adaptivePollDelayMs({ active: true }), 30000);
  assert.equal(adaptivePollDelayMs({ active: false }), 180000);
});

test("adaptivePollDelayMs honors custom cadence config", () => {
  assert.equal(adaptivePollDelayMs({ active: true, cfgActiveSeconds: 10, cfgIdleSeconds: 60 }), 10000);
  assert.equal(adaptivePollDelayMs({ active: false, cfgActiveSeconds: 10, cfgIdleSeconds: 60 }), 60000);
});

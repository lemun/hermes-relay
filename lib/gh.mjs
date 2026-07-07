// GitHub REST v3 client for Hermes (ADR-0002, ADR-0003; see docs/architecture.md "GitHub
// access"). Every network/timer dependency is injectable so tests run with zero real network
// calls and fully controlled fake time.
//
// NEVER `gh issue list` / GraphQL here — see docs/adr/0002-rest-etag-polling-not-gh-issue-list.md.
// GraphQL calls burn shared budget and can never return a free 304 (conditional requests don't
// exist for POST); the poller below does a plain REST GET with If-None-Match instead.

import { exec } from "./proc.mjs";

const API_BASE = "https://api.github.com";
const API_VERSION = "2022-11-28";

// ── Token cache ───────────────────────────────────────────────────────────────

let cachedToken = null;

/** Clear the cached token (tests; also called internally on a 401). */
export function clearTokenCache() {
  cachedToken = null;
}

/**
 * Return a GitHub token via `gh auth token`, cached in module state for the process lifetime.
 * ghFetch clears the cache and calls this again once on a 401.
 */
export async function getToken({ execImpl = exec } = {}) {
  if (cachedToken) return cachedToken;
  const { code, stdout, stderr } = await execImpl("gh", ["auth", "token"]);
  if (code !== 0) throw new Error(`gh auth token failed: ${stderr.trim() || code}`);
  cachedToken = stdout.trim();
  return cachedToken;
}

// ── Low-level REST call ────────────────────────────────────────────────────────

/**
 * One REST v3 call to api.github.com. Returns `{ status, etag, json, headers }` — `json` is
 * null on 304/204. If `etag` is given, sends If-None-Match so the caller can get a free 304.
 * On 401: clears the token cache and retries once with a freshly fetched token (handles a
 * revoked/rotated `gh` token without the caller having to know). On 403/429 that looks like a
 * rate limit (Retry-After header, or x-ratelimit-remaining: 0), NEVER throws — returns
 * `{ status, retryAfterMs }` so callers back off instead of crashing the poll loop.
 */
export async function ghFetch(path, { method = "GET", body, etag, token, fetchImpl = fetch, execImpl = exec, _retried = false } = {}) {
  const authToken = token ?? await getToken({ execImpl });
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    Authorization: `Bearer ${authToken}`,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (etag) headers["If-None-Match"] = etag;

  const res = await fetchImpl(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !_retried) {
    clearTokenCache();
    return ghFetch(path, { method, body, etag, fetchImpl, execImpl, _retried: true });
  }

  if (res.status === 403 || res.status === 429) {
    const retryAfterHeader = res.headers.get("retry-after");
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (retryAfterHeader) return { status: res.status, retryAfterMs: Number(retryAfterHeader) * 1000 };
    if (remaining === "0") {
      const resetHeader = res.headers.get("x-ratelimit-reset");
      const resetMs = resetHeader ? Number(resetHeader) * 1000 - Date.now() : 60000;
      return { status: res.status, retryAfterMs: Math.max(resetMs, 1000) };
    }
  }

  const resEtag = res.headers.get("etag");
  if (res.status === 304 || res.status === 204) {
    return { status: res.status, etag: resEtag, json: null, headers: res.headers };
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, etag: resEtag, json, headers: res.headers };
}

function responseMessage(res) {
  if ("retryAfterMs" in res) return `rate limited; retry after ${res.retryAfterMs}ms`;
  const msg = res.json?.message;
  if (msg) return msg;
  return `HTTP ${res.status}`;
}

function assertGhStatus(res, okStatuses, action) {
  if (okStatuses.includes(res.status)) return res;
  throw new Error(`${action} failed: ${responseMessage(res)}`);
}

function assertJsonField(res, field, action) {
  if (res.json?.[field] !== undefined && res.json?.[field] !== null) return res;
  throw new Error(`${action} failed: response missing ${field}`);
}

// ── Issue polling (ADR-0002: REST + ETag, never gh issue list / GraphQL) ──────

/**
 * Poll open issues for a repo. GET /repos/{slug}/issues?state=open&per_page=100 with
 * If-None-Match. Returns `{ changed: false, etag }` on 304 (zero rate-limit cost), else
 * `{ changed: true, etag, issues }`. The REST issues endpoint also returns PRs (a GitHub
 * quirk), so entries carrying a `pull_request` key are dropped here — this poller is issues-only.
 */
export async function pollRepoIssues({ slug, etag, fetchImpl = fetch, token, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/issues?state=open&per_page=100`, { etag, fetchImpl, token, execImpl });
  if ("retryAfterMs" in res) return res;
  if (res.status === 304) return { changed: false, etag: res.etag ?? etag };
  const issues = (res.json || []).filter((it) => !("pull_request" in it));
  return { changed: true, etag: res.etag, issues };
}

// ── Local label helpers ────────────────────────────────────────────────────────

/** Label names on an issue (labels arrive as objects with `.name`). */
export function issueLabels(issue) {
  return (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
}

/** Filter a list of issues to those carrying `label`. */
export function filterByLabel(issues, label) {
  return issues.filter((issue) => issueLabels(issue).includes(label));
}

// ── Labels (write) ──────────────────────────────────────────────────────────────

/** POST /issues/{n}/labels — add one or more labels to an issue. */
export async function addLabels({ slug, issue, labels, token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/issues/${issue}/labels`, {
    method: "POST",
    body: { labels },
    token,
    fetchImpl,
    execImpl,
  });
  return assertGhStatus(res, [200, 201], `add labels ${labels.join(", ")} to ${slug}#${issue}`);
}

/**
 * DELETE /issues/{n}/labels/{name}. A 404 means the label is already gone — treated as success
 * (removeLabel is idempotent: the caller never has to check whether the label was present).
 */
export async function removeLabel({ slug, issue, label, token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/issues/${issue}/labels/${encodeURIComponent(label)}`, {
    method: "DELETE",
    token,
    fetchImpl,
    execImpl,
  });
  if (res.status === 404) return { status: 200, json: null };
  return assertGhStatus(res, [200, 204], `remove label ${label} from ${slug}#${issue}`);
}

// ── Comments ────────────────────────────────────────────────────────────────────

/** POST /issues/{n}/comments → `{ id }` (the ledger comment's id, for later coalesced edits). */
export async function createComment({ slug, issue, body, token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/issues/${issue}/comments`, {
    method: "POST",
    body: { body },
    token,
    fetchImpl,
    execImpl,
  });
  assertGhStatus(res, [201], `create comment on ${slug}#${issue}`);
  assertJsonField(res, "id", `create comment on ${slug}#${issue}`);
  return { id: res.json?.id };
}

/** PATCH /issues/comments/{id} — edit the ledger comment in place. */
export async function editComment({ slug, commentId, body, token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/issues/comments/${commentId}`, {
    method: "PATCH",
    body: { body },
    token,
    fetchImpl,
    execImpl,
  });
  return assertGhStatus(res, [200], `edit comment ${commentId} on ${slug}`);
}

// ── Coalesced ledger-comment editor (ADR-0002: edits coalesced >=5-10s apart) ──

/**
 * Create a coalescing editor for ledger comment edits. `schedule({ slug, commentId, body })`
 * overwrites any pending body for that commentId (last write wins). Per commentId: if no edit
 * fired in the last `minIntervalMs`, the edit fires immediately; otherwise a single trailing
 * timer is armed for the remainder of the window, and any further schedule() calls before it
 * fires just replace the pending body (the timer is not re-armed). `flush()` fires every pending
 * edit immediately (used at the SIGTERM checkpoint). `pendingCount()` reports outstanding timers,
 * for tests/observability.
 *
 * Pure state machine over injected `editImpl`/`setTimeoutImpl`/`clearTimeoutImpl` + `now`, so
 * tests can drive it with fake timers and a manual clock instead of real wall time.
 */
export function createCoalescedEditor({
  minIntervalMs = 7000,
  editImpl,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  now = () => Date.now(),
} = {}) {
  // Per commentId: { lastFiredAt, timer, pending: { slug, body } | null }
  const state = new Map();

  function entryFor(commentId) {
    let e = state.get(commentId);
    if (!e) {
      e = { lastFiredAt: -Infinity, timer: null, pending: null };
      state.set(commentId, e);
    }
    return e;
  }

  async function fire(commentId) {
    const e = entryFor(commentId);
    const pending = e.pending;
    e.pending = null;
    e.timer = null;
    if (!pending) return;
    e.lastFiredAt = now();
    await editImpl({ slug: pending.slug, commentId, body: pending.body });
  }

  function schedule({ slug, commentId, body }) {
    const e = entryFor(commentId);
    e.pending = { slug, body };

    if (e.timer) return; // a trailing timer is already armed; it will pick up the latest body

    const elapsed = now() - e.lastFiredAt;
    if (elapsed >= minIntervalMs) {
      fire(commentId); // fires immediately; not awaited so schedule() stays sync like a dispatch
      return;
    }

    const delay = minIntervalMs - elapsed;
    e.timer = setTimeoutImpl(() => fire(commentId), delay);
  }

  async function flush() {
    for (const [commentId, e] of state) {
      if (e.timer) {
        clearTimeoutImpl(e.timer);
        e.timer = null;
      }
      if (e.pending) await fire(commentId);
    }
  }

  function pendingCount() {
    let n = 0;
    for (const e of state.values()) if (e.timer) n += 1;
    return n;
  }

  return { schedule, flush, pendingCount };
}

// ── Issue creation ────────────────────────────────────────────────────────────

/** POST /repos/{slug}/issues → `{ number, html_url }`. */
export async function createIssue({ slug, title, body, labels, token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/issues`, {
    method: "POST",
    body: { title, body, labels },
    token,
    fetchImpl,
    execImpl,
  });
  assertGhStatus(res, [201], `create issue in ${slug}`);
  assertJsonField(res, "number", `create issue in ${slug}`);
  return { number: res.json?.number, html_url: res.json?.html_url };
}

// ── Repository labels ───────────────────────────────────────────────────────

/** GET /repos/{slug}/labels?per_page=100 — used by the label bootstrap/check script. */
export async function listRepoLabels({ slug, token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/labels?per_page=100`, { token, fetchImpl, execImpl });
  assertGhStatus(res, [200], `list labels for ${slug}`);
  return res.json || [];
}

/** POST /repos/{slug}/labels — create one repository label. */
export async function createRepoLabel({ slug, name, color, description, token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/labels`, {
    method: "POST",
    body: { name, color, description },
    token,
    fetchImpl,
    execImpl,
  });
  return assertGhStatus(res, [201], `create label ${name} in ${slug}`);
}

// ── Pull requests ────────────────────────────────────────────────────────────

/** GET /repos/{slug}/pulls/{number} — used for mergeable state. */
export async function getPr({ slug, number, token, fetchImpl = fetch, execImpl = exec }) {
  return ghFetch(`/repos/${slug}/pulls/${number}`, { token, fetchImpl, execImpl });
}

/**
 * PUT /pulls/{number}/merge. Never throws on a non-2xx (a failed merge — conflicts, failing
 * checks, etc. — is expected data for the finisher pipeline, not an exceptional condition):
 * returns `{ merged: false, message }` instead.
 */
export async function mergePr({ slug, number, method = "squash", token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/pulls/${number}/merge`, {
    method: "PUT",
    body: { merge_method: method },
    token,
    fetchImpl,
    execImpl,
  });
  if (res.status >= 200 && res.status < 300) {
    return { merged: !!res.json?.merged, message: res.json?.message };
  }
  if (![405, 409].includes(res.status)) {
    throw new Error(`merge PR ${slug}#${number} failed: ${responseMessage(res)}`);
  }
  return { merged: false, message: res.json?.message || `merge failed: HTTP ${res.status}` };
}

/**
 * GET /repos/{slug}/commits/{ref}/check-runs → `{ total, pending, failed }` summary counts
 * derived from each check_run's status/conclusion (pending = status !== "completed"; failed =
 * completed with a conclusion other than "success"/"neutral"/"skipped").
 */
export async function getChecksForRef({ slug, ref, token, fetchImpl = fetch, execImpl = exec }) {
  const res = await ghFetch(`/repos/${slug}/commits/${ref}/check-runs`, { token, fetchImpl, execImpl });
  assertGhStatus(res, [200], `fetch checks for ${slug}@${ref}`);
  const runs = res.json?.check_runs || [];
  let pending = 0;
  let failed = 0;
  const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
  for (const run of runs) {
    if (run.status !== "completed") { pending += 1; continue; }
    if (!OK_CONCLUSIONS.has(run.conclusion)) failed += 1;
  }
  return { total: runs.length, pending, failed };
}

// ── Poll cadence ────────────────────────────────────────────────────────────────

/**
 * Adaptive poll cadence (docs/architecture.md config: pollActiveSeconds/pollIdleSeconds).
 * `active` = true when sessions are in flight or questions are pending.
 */
export function adaptivePollDelayMs({ active, cfgActiveSeconds = 30, cfgIdleSeconds = 180 } = {}) {
  return (active ? cfgActiveSeconds : cfgIdleSeconds) * 1000;
}

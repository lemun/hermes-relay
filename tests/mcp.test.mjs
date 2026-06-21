import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOLS, handle } from "../lib/mcp-tools.mjs";

const CFG = { paperclipBase: "http://127.0.0.1:3100", companyId: "co-1", issuePrefix: "HOM", uiBaseUrl: "http://h:3100" };

// Drive handle() against a fetch mock keyed by URL substring (mirrors paperclip.test.mjs).
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
const parse = (res) => JSON.parse(res.content[0].text);

test("TOOLS manifest exposes exactly the seven read+remember tools", () => {
  assert.deepEqual(
    TOOLS.map((t) => t.name).sort(),
    ["agent_states", "board_status", "get_issue", "list_issues", "recent_activity", "remember", "whats_blocking_me"],
  );
});

test("board_status tallies counts and flags needsBoardTap only for issues with a pending card", async () => {
  await withFakeApi({
    "/companies/co-1/issues": [
      { id: "i1", identifier: "HOM-1", title: "A", status: "in_review", assigneeAgentId: "ag1" },
      { id: "i2", identifier: "HOM-2", title: "B", status: "done" },
      { id: "i3", identifier: "HOM-3", title: "C", status: "in_review" },
    ],
    "/issues/i1/interactions": [{ id: "int1", kind: "request_confirmation", title: "Approve deploy", status: "pending", createdAt: "2026-06-18T10:00:00Z" }],
    "/issues/i3/interactions": [],
    "/companies/co-1/agents": [{ id: "ag1", name: "eng-lead", status: "idle" }],
  }, async () => {
    const out = parse(await handle("board_status", {}, CFG));
    assert.equal(out.issueCounts.in_review, 2);
    assert.equal(out.issueCounts.done, 1);
    const hom1 = out.inReview.find((x) => x.id === "HOM-1");
    const hom3 = out.inReview.find((x) => x.id === "HOM-3");
    assert.equal(hom1.needsBoardTap, true);   // has a pending card
    assert.equal(hom1.assignee, "eng-lead");  // resolved via agents
    assert.equal(hom3.needsBoardTap, false);  // no pending card
    assert.deepEqual(out.pendingBoardCards, ["HOM-1: Approve deploy"]);
  });
});

test("list_issues filters by status and assignee (case-insensitive)", async () => {
  await withFakeApi({
    "/companies/co-1/issues": [
      { id: "i1", identifier: "HOM-1", title: "A", status: "in_review", assigneeAgentId: "ag1" },
      { id: "i2", identifier: "HOM-2", title: "B", status: "done", assigneeAgentId: "ag2" },
    ],
    "/companies/co-1/agents": [{ id: "ag1", name: "Growth-Lead" }, { id: "ag2", name: "eng" }],
  }, async () => {
    const byStatus = parse(await handle("list_issues", { status: "done" }, CFG));
    assert.equal(byStatus.length, 1);
    assert.equal(byStatus[0].id, "HOM-2");
    const byAssignee = parse(await handle("list_issues", { assignee: "growth-lead" }, CFG));
    assert.equal(byAssignee.length, 1);
    assert.equal(byAssignee[0].assignee, "Growth-Lead");
  });
});

test("recent_activity drops NOISE actions, maps actor → name, honors limit, and labels users", async () => {
  await withFakeApi({
    "/companies/co-1/activity": [
      { createdAt: "t5", action: "status_changed", actorType: "agent", agentId: "ag1", entityType: "issue", entityId: "i1" },
      { createdAt: "t4", action: "read_marked", actorType: "agent", agentId: "ag1" },            // NOISE → dropped
      { createdAt: "t3", action: "commented", actorType: "user", entityType: "issue", entityId: "i1" },
      { createdAt: "t2", action: "lease_renewed", actorType: "agent", agentId: "ag1" },          // NOISE → dropped
    ],
    "/companies/co-1/agents": [{ id: "ag1", name: "eng-lead" }],
    "/companies/co-1/issues": [{ id: "i1", identifier: "HOM-1" }],
  }, async () => {
    const out = parse(await handle("recent_activity", {}, CFG));
    assert.equal(out.length, 2); // two NOISE rows filtered out
    assert.equal(out[0].who, "eng-lead");
    assert.equal(out[0].issue, "HOM-1");
    assert.equal(out[1].who, "you"); // actorType user
    // limit caps the result
    const limited = parse(await handle("recent_activity", { limit: 1 }, CFG));
    assert.equal(limited.length, 1);
  });
});

test("get_issue returns 'No issue found' for an unknown id", async () => {
  await withFakeApi({ "/companies/co-1/issues": [] }, async () => {
    const out = await handle("get_issue", { idOrIdentifier: "HOM-999" }, CFG);
    assert.match(out.content[0].text, /No issue found/);
  });
});

test("an unknown tool name is reported, not thrown", async () => {
  const out = await handle("does_not_exist", {}, CFG);
  assert.match(out.content[0].text, /Unknown tool/);
});

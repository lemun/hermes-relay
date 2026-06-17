#!/usr/bin/env node
// paperclip-cockpit — MCP stdio server (READ-ONLY v1).
//
// A thin bridge that exposes the live Paperclip org as MCP tools, proxying
// to the loopback API (http://127.0.0.1:3100). Modeled on the dashboard's
// scripts/cockpit-mcp-server.mjs, but pointed at Paperclip instead of the dead
// dashboard. Driven by Hermes via `claude -p --mcp-config`.
//
// v1 is reads only. Mutating the board (accept/reject a card, comment, create
// issue) needs authenticated POSTs (X-Paperclip-Run-Id + agent/board auth) — left
// as a deliberate, gated fast-follow so the texting agent can't act by accident.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  loadConfig, getAgents, getIssues, getComments, getInteractions,
  getActivity, resolveIssue, gatherBoardSignals, issueUrl,
} from "./lib/paperclip.mjs";

const cfg = loadConfig();

const TOOLS = [
  {
    name: "board_status",
    description: "One-shot snapshot of the Paperclip org: issue counts by status, the open in_review items, which of them have a PENDING board card, and any agent currently in an error state. Use this first for 'how are things' / 'status'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "whats_blocking_me",
    description: "The board-gated queue: every PENDING request_confirmation card waiting on the human (you), in priority order, each with the issue and the card title (the action to take). Use for 'what needs me' / 'what should I do'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_issues",
    description: "List issues, optionally filtered by status and/or assignee name. Returns identifier, title, status, assignee.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "e.g. in_review, done, backlog, blocked, in_progress" },
        assignee: { type: "string", description: "agent name, e.g. growth-lead" },
      },
    },
  },
  {
    name: "get_issue",
    description: "Full detail for one issue (by UUID or identifier like HOM-27): description, status, assignee, pending cards, and the most recent comments.",
    inputSchema: {
      type: "object",
      properties: { idOrIdentifier: { type: "string" } },
      required: ["idOrIdentifier"],
    },
  },
  {
    name: "agent_states",
    description: "All agents with role, run-state (idle/running/error), model, and last heartbeat. Use to answer 'is anything stuck' / 'why did X error'.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "recent_activity",
    description: "Recent org activity, newest first — status changes, comments, runs, errors, hand-offs by agents and the board. Use for 'what's new / recent / what happened while I was away', and to explain WHY an agent errored (event details carry failure reasons). Optional: limit (default 30), agent (filter to one agent's name).",
    inputSchema: { type: "object", properties: { limit: { type: "number" }, agent: { type: "string" } } },
  },
];

const server = new Server(
  { name: "paperclip-cockpit", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

function text(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

async function handle(name, args) {
  if (name === "board_status") {
    const { pending, errors, issues, agents } = await gatherBoardSignals(cfg);
    const counts = {};
    for (const i of issues) counts[i.status] = (counts[i.status] || 0) + 1;
    const nameById = Object.fromEntries(agents.map((a) => [a.id, a.name]));
    return text({
      issueCounts: counts,
      inReview: issues.filter((i) => i.status === "in_review").map((i) => ({
        id: i.identifier, title: i.title, assignee: nameById[i.assigneeAgentId] || "—",
        needsBoardTap: pending.some((p) => p.issueIdentifier === i.identifier),
        tapToOpen: issueUrl(cfg, i.identifier),
      })),
      pendingBoardCards: pending.map((p) => `${p.issueIdentifier}: ${p.title}`),
      agentsInError: errors.map((e) => `${e.name} (last heartbeat ${e.at})`),
    });
  }
  if (name === "whats_blocking_me") {
    const { pending } = await gatherBoardSignals(cfg);
    if (!pending.length) return text("Nothing is waiting on you right now. The board is clear of pending cards.");
    return text({
      needsYou: pending
        .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""))
        .map((p) => ({
          issue: p.issueIdentifier, action: p.title, on: p.issueTitle,
          kind: p.kind, since: p.createdAt, tapToOpen: issueUrl(cfg, p.issueIdentifier),
        })),
    });
  }
  if (name === "list_issues") {
    const issues = await getIssues(cfg);
    const agents = await getAgents(cfg);
    const nameById = Object.fromEntries(agents.map((a) => [a.id, a.name]));
    let out = issues;
    if (args?.status) out = out.filter((i) => i.status === args.status);
    if (args?.assignee) out = out.filter((i) => (nameById[i.assigneeAgentId] || "").toLowerCase() === String(args.assignee).toLowerCase());
    return text(out.map((i) => ({ id: i.identifier, title: i.title, status: i.status, assignee: nameById[i.assigneeAgentId] || "—", updated: i.lastActivityAt || i.updatedAt, url: issueUrl(cfg, i.identifier) })));
  }
  if (name === "get_issue") {
    const issue = await resolveIssue(cfg, args.idOrIdentifier);
    if (!issue) return text(`No issue found for "${args.idOrIdentifier}".`);
    const [comments, interactions] = await Promise.all([
      getComments(cfg, issue.id).catch(() => []),
      getInteractions(cfg, issue.id).catch(() => []),
    ]);
    return text({
      id: issue.identifier, title: issue.title, status: issue.status,
      tapToOpen: issueUrl(cfg, issue.identifier),
      description: (issue.description || "").slice(0, 1200),
      pendingCards: interactions.filter((x) => x.status === "pending").map((x) => x.title || x.kind),
      recentComments: comments.slice(-8).map((c) => ({
        author: c.authorType, at: c.createdAt, body: (c.body || "").slice(0, 600),
      })),
    });
  }
  if (name === "agent_states") {
    const agents = await getAgents(cfg);
    return text(agents.map((a) => ({
      name: a.name, role: a.role, status: a.status,
      model: (a.adapterConfig || {}).model, lastHeartbeat: a.lastHeartbeatAt,
    })));
  }
  if (name === "recent_activity") {
    const [events, agents, issues] = await Promise.all([getActivity(cfg), getAgents(cfg), getIssues(cfg)]);
    const aName = Object.fromEntries(agents.map((a) => [a.id, a.name]));
    const iIdent = Object.fromEntries(issues.map((i) => [i.id, i.identifier || `#${i.issueNumber}`]));
    const NOISE = /read_marked|viewed|lease_/i;
    const want = (args.agent || "").toLowerCase();
    const out = (events || [])
      .filter((e) => !NOISE.test(e.action || ""))
      .filter((e) => !want || (aName[e.agentId || e.actorId] || "").toLowerCase() === want)
      .slice(0, args.limit || 30)
      .map((e) => ({
        at: e.createdAt,
        who: e.actorType === "user" ? "you" : (aName[e.agentId || e.actorId] || e.actorId || "?"),
        action: e.action,
        issue: e.entityType === "issue" ? (iIdent[e.entityId] || e.entityId) : e.entityType,
        details: e.details ? JSON.stringify(e.details).slice(0, 200) : undefined,
      }));
    return text(out.length ? out : "No notable recent activity (the org may be stopped).");
  }
  return text(`Unknown tool: ${name}`);
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await handle(name, args || {});
  } catch (err) {
    return { ...text(`Error in ${name}: ${err.message}`), isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

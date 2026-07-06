#!/usr/bin/env node
// hermes-ask-mcp — the blocking stdio MCP server engine sessions load for the ratification
// relay (docs/architecture.md "ask_owner relay protocol"; docs/adr/0001). One tool, `ask_owner`:
// it relays a decision question to the owner's phone over a unix-socket HTTP connection to the
// bot (lib/ask-server.mjs is the other end) and BLOCKS the tool call until the owner answers or
// the deadline passes.
//
// This must be a PLAIN tool call — never MCP elicitation. codex's `approval_policy=never`
// auto-rejects elicitations outright, so an elicitation-based design would silently break the
// codex engine; a plain tool call that just... takes a long time to return works uniformly for
// both engines (ADR-0001: local stdio has no 5-minute idle timeout, only the per-server
// `timeout`/`tool_timeout_sec` wall-clock cap, which the caller sets to ~8h).
//
// CRITICAL: nothing may write to stdout except the MCP stdio transport itself — stdout IS the
// protocol channel. Any diagnostic output here goes to stderr only.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8h, matches docs/architecture.md askTimeoutHours
const DEFAULT_POLL_MS = 5000;
const ASK_RETRY_ATTEMPTS = 3;
const ASK_RETRY_DELAY_MS = 2000;

function log(line) {
  process.stderr.write(`[hermes-ask-mcp] ${line}\n`);
}

// One HTTP request over a unix domain socket, promisified. Exported for tests so they can drive
// the exact same wire path the tool handler uses. `body` (if given) is JSON-stringified and sent
// with a content-type header; the response body is parsed as JSON unless empty.
export function socketRequest(sockPath, method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: sockPath,
        path: reqPath,
        method,
        // agent:false + Connection:close — this is a one-off request per poll tick, never
        // reused, so pooling via the global keep-alive agent only risks leaving a socket handle
        // referenced past the call (observed hanging test processes when this used the default
        // agent).
        agent: false,
        headers: {
          connection: "close",
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch (err) {
            return reject(new Error(`invalid JSON response from ${reqPath}: ${err.message}`));
          }
          resolve({ status: res.statusCode, body: json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Relay a question to the owner over the ask-server unix socket and block until answered or the
 * deadline passes. POSTs /ask (retrying up to ASK_RETRY_ATTEMPTS times, ASK_RETRY_DELAY_MS
 * apart, before giving up — the bot may be mid-restart), then polls GET /answer/<id> every
 * `pollMs` until `status === "answered"`.
 *
 * Transient errors WHILE POLLING (bot restarting mid-wait) are swallowed and retried — only the
 * overall deadline ends the wait, per ADR-0001's resume-fallback design: a session should keep
 * waiting through a bot blip rather than bailing early. On timeout, the thrown message tells the
 * session exactly what to do next (checkpoint into the ledger, exit; the bot's resume path picks
 * it back up once the owner answers) — this exact guidance matters, see ADR-0001.
 */
export async function askOwnerViaSocket({
  sockPath,
  sessionKey,
  question,
  recommended,
  context,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  sleepImpl = sleepDefault,
} = {}) {
  if (!sockPath) throw new Error("askOwnerViaSocket: sockPath is required");

  let id;
  let lastAskErr;
  for (let attempt = 1; attempt <= ASK_RETRY_ATTEMPTS; attempt++) {
    try {
      const { status, body } = await socketRequest(sockPath, "POST", "/ask", {
        sessionKey,
        question,
        recommended,
        context,
      });
      if (status !== 200 || !body || !body.id) {
        throw new Error(`ask-server returned ${status}: ${body && body.error ? body.error : "no id"}`);
      }
      id = body.id;
      lastAskErr = undefined;
      break;
    } catch (err) {
      lastAskErr = err;
      if (attempt < ASK_RETRY_ATTEMPTS) await sleepImpl(ASK_RETRY_DELAY_MS);
    }
  }
  if (lastAskErr) {
    log(`POST /ask failed after ${ASK_RETRY_ATTEMPTS} attempts: ${lastAskErr.message}`);
    throw new Error("Hermes bot unreachable");
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() >= deadline) {
      const hours = Math.round((timeoutMs / 3600000) * 10) / 10;
      throw new Error(
        `No owner answer within ${hours}h. Write your handoff note to the ledger comment, then end the session; Hermes will resume you with the answer.`,
      );
    }
    await sleepImpl(pollMs);
    let status, body;
    try {
      ({ status, body } = await socketRequest(sockPath, "GET", `/answer/${encodeURIComponent(id)}`));
    } catch (err) {
      // Transient socket error while polling (e.g. bot restarting) — keep polling; only the
      // deadline above ends the wait.
      log(`poll error (continuing): ${err.message}`);
      continue;
    }
    if (status === 200 && body && body.status === "answered") {
      return body.answer;
    }
    // status === "pending" (or a transient non-200) — keep polling.
  }
}

async function main() {
  const server = new Server(
    { name: "hermes", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const TOOLS = [
    {
      name: "ask_owner",
      description:
        "Relay a decision question to the owner's phone and BLOCK until they answer (may take " +
        "hours). Call this ONLY for owner-class decisions — judgment calls that materially change " +
        "scope, risk, spend, or direction — never for things you can reasonably decide yourself. " +
        "ALWAYS provide a `recommended` answer; the owner can one-tap accept it. This is a plain " +
        "blocking tool call, not a notification: your turn does not end, it just waits.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question for the owner, self-contained." },
          recommended: { type: "string", description: "Your recommended answer — always required." },
          context: { type: "string", description: "Optional extra context to show alongside the question." },
        },
        required: ["question", "recommended"],
      },
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name !== "ask_owner") {
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
    const { question, recommended, context } = args || {};
    if (!question || !recommended) {
      return {
        content: [{ type: "text", text: "ask_owner requires both `question` and `recommended`." }],
        isError: true,
      };
    }
    const sockPath = process.env.HERMES_SOCK;
    const sessionKey = process.env.HERMES_SESSION_KEY;
    const timeoutMs = Number(process.env.HERMES_ASK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    if (!sockPath || !sessionKey) {
      return {
        content: [{ type: "text", text: "hermes-ask-mcp misconfigured: HERMES_SOCK/HERMES_SESSION_KEY not set." }],
        isError: true,
      };
    }
    try {
      const answer = await askOwnerViaSocket({
        sockPath,
        sessionKey,
        question,
        recommended,
        context,
        timeoutMs,
      });
      return { content: [{ type: "text", text: answer }] };
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only boot the MCP stdio server when this file is run directly (`node hermes-ask-mcp.mjs`, or
// exec'd by an engine session) — NOT when tests import it for `socketRequest`/`askOwnerViaSocket`.
// Without this guard, importing this module for its exports would also connect a
// StdioServerTransport (which holds process.stdin open), leaking a handle that keeps any
// importing process — including `node --test` — alive indefinitely.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    log(`fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

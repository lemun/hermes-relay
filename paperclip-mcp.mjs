#!/usr/bin/env node
// paperclip-mcp — MCP stdio server (board-READ-ONLY + own-memory write).
//
// A thin bridge that exposes the live Paperclip org as MCP tools, proxying
// to the loopback API (http://127.0.0.1:3100). Driven by Hermes via
// `claude -p --mcp-config`. Mounted under the server key "paperclip", so its tools
// are addressed as mcp__paperclip__* (see mcp-config.json + the allowlist in hermes-bot.mjs).
//
// The ORG is reads only: mutating the board (accept/reject a card, comment, create
// issue) needs authenticated POSTs (X-Paperclip-Run-Id + agent/board auth) — left
// as a deliberate, gated fast-follow so the texting agent can't act by accident.
// The ONE write here is `remember`: an append-only note to Hermes's OWN memory file
// (state/hermes-memory.md). It touches nothing on the board and nowhere else on disk.
//
// This file is JUST the transport bootstrap; the tool manifest + dispatcher live in
// lib/mcp-tools.mjs (so they're unit-testable without a stdio transport).

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "./lib/paperclip.mjs";
import { TOOLS, text, handle } from "./lib/mcp-tools.mjs";

const cfg = loadConfig();

const server = new Server(
  { name: "paperclip", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return await handle(name, args || {}, cfg);
  } catch (err) {
    return { ...text(`Error in ${name}: ${err.message}`), isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

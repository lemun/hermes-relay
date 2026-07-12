// The bot-side unix-socket HTTP server for the ratification relay (docs/architecture.md
// "ask_owner relay protocol"). hermes-ask-mcp.mjs (a local stdio MCP server spawned inside
// engine sessions) is the CLIENT; this is the SERVER the bot runs, listening on
// state/hermes-ask.sock (0600) so only the local user can reach it.
//
// Two routes only:
//   POST /ask          → authenticated onAsk({ sessionKey, question, recommended, context }) → { id }
//   GET  /answer/<id>  → authenticated getAnswer(id) → { status: "pending" } | { status: "answered", answer }
// Everything else is 404. Malformed input is 400; an oversized body is 413; onAsk throwing is
// 500. The server must never crash on a bad request or a socket hiccup — it's the bot's own
// long-lived process, so every handler path is wrapped and logged (stderr-safe via `log`,
// caller-supplied) rather than left to throw past the request handler.

import http from "node:http";
import { existsSync, unlinkSync, chmodSync } from "node:fs";

const MAX_BODY_BYTES = 64 * 1024; // 64KB — a question/recommended/context blob is tiny; anything
                                   // bigger is either a bug or hostile input, reject outright.

// Read a request body up to `maxBytes`, rejecting (for the caller to answer 413) if exceeded.
// Never throws past its own promise — callers await it inside a route handler.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("body too large"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

// Try connecting to an existing socket to see if a live server already owns it. Resolves true if
// something answered (another bot instance is up — the caller must NOT steal the socket), false
// if the connect failed (stale file safe to remove, or nothing there).
function socketIsLive(sockPath) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        socketPath: sockPath, path: "/answer/__probe__", timeout: 500,
        agent: false, headers: { connection: "close" }, // no keep-alive: don't leave the peer's socket open
      },
      (res) => {
        res.resume();
        res.on("end", () => req.destroy());
        req.destroy();
        resolve(true);
      },
    );
    // Always destroy the request on error/timeout too — otherwise the underlying socket can
    // linger as an active libuv handle (observed hanging `node --test` past the run's last
    // test) even though the promise itself has already resolved.
    req.on("error", () => { req.destroy(); resolve(false); });
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

/**
 * Create the ask-server. `onAsk({ sessionKey, question, recommended, context })` persists the
 * Question + notifies the owner (bot wiring lives outside this module); `getAnswer(id)` looks the
 * question up. Both may be async. `log(line)` defaults to a no-op — the bot passes a
 * stderr-safe logger (this module itself never writes to stdout, matching the MCP-side
 * stdout-is-sacred rule even though this half isn't the MCP transport).
 */
export function createAskServer({ sockPath, authenticate = async () => false, onAsk, getAnswer, log = () => {} } = {}) {
  let server = null;

  function bearerToken(req) {
    const value = req.headers.authorization;
    if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
    const token = value.slice("Bearer ".length);
    return token.length > 0 ? token : null;
  }

  async function authenticateRequest(req, scope = {}) {
    const askToken = bearerToken(req);
    if (!askToken) return null;
    try {
      return (await authenticate({ askToken, ...scope })) || null;
    } catch (err) {
      log("ask-server: authentication callback failed");
      return null;
    }
  }

  async function removeStaleSocketIfSafe() {
    if (!existsSync(sockPath)) return;
    const live = await socketIsLive(sockPath);
    if (live) {
      throw new Error(`ask-server socket ${sockPath} is already in use by a live server`);
    }
    try { unlinkSync(sockPath); } catch { /* race: someone else already removed it */ }
  }

  async function handleAsk(req, res) {
    if (!(await authenticateRequest(req))) return sendJson(res, 403, { error: "forbidden" });
    let raw;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if (err && err.code === "TOO_LARGE") return sendJson(res, 413, { error: "request body too large" });
      log(`ask-server: body read error: ${err && err.message}`);
      return sendJson(res, 400, { error: "failed to read request body" });
    }
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return sendJson(res, 400, { error: "malformed JSON body" });
    }
    const { sessionKey, question, recommended, context } = body || {};
    if (!sessionKey || !question || !recommended) {
      return sendJson(res, 400, { error: "missing required field(s): sessionKey, question, recommended" });
    }
    if (!(await authenticateRequest(req, { sessionKey }))) return sendJson(res, 403, { error: "forbidden" });
    try {
      const { id } = await onAsk({ sessionKey, question, recommended, context });
      return sendJson(res, 200, { id });
    } catch (err) {
      log(`ask-server: onAsk threw: ${err && err.message}`);
      return sendJson(res, 500, { error: "onAsk failed" });
    }
  }

  async function handleAnswer(req, res, rawId) {
    const principal = await authenticateRequest(req);
    if (!principal) return sendJson(res, 403, { error: "forbidden" });
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return sendJson(res, 400, { error: "malformed answer id" });
    }
    let result;
    try {
      result = await getAnswer(id, principal);
    } catch (err) {
      log(`ask-server: getAnswer threw: ${err && err.message}`);
      return sendJson(res, 500, { error: "getAnswer failed" });
    }
    if (!result) return sendJson(res, 404, { error: "unknown question" });
    return sendJson(res, 200, result);
  }

  function requestListener(req, res) {
    Promise.resolve()
      .then(() => {
        const url = req.url || "";
        if (req.method === "POST" && url === "/ask") return handleAsk(req, res);
        const m = /^\/answer\/([^/]+)$/.exec(url);
        if (req.method === "GET" && m) return handleAnswer(req, res, m[1]);
        return sendJson(res, 404, { error: "not found" });
      })
      .catch((err) => {
        // Belt-and-suspenders: handleAsk/handleAnswer already catch their own errors, but never
        // let anything escape the request listener and crash the bot process.
        log(`ask-server: unhandled request error: ${err && err.message}`);
        try { sendJson(res, 500, { error: "internal error" }); } catch { /* response already sent/closed */ }
      });
  }

  async function start() {
    if (server) return; // already started
    await removeStaleSocketIfSafe();
    server = http.createServer(requestListener);
    server.on("error", (err) => log(`ask-server: server error: ${err && err.message}`));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    try { chmodSync(sockPath, 0o600); } catch (err) { log(`ask-server: chmod failed: ${err && err.message}`); }
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) return resolve();
      const s = server;
      server = null;
      s.close(() => resolve());
      // server.close() alone only stops accepting NEW connections; it waits for existing
      // (possibly keep-alive-idle) sockets to end on their own, which can hang a caller (e.g. a
      // test process) indefinitely. Force-close anything still open so stop() actually settles.
      if (typeof s.closeAllConnections === "function") s.closeAllConnections();
      // Best-effort: also drop the socket file so a restart's stale-check is trivially satisfied.
      try { unlinkSync(sockPath); } catch { /* already gone */ }
    });
  }

  return { start, stop };
}

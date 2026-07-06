import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createAskServer } from "../lib/ask-server.mjs";
import { askOwnerViaSocket, socketRequest } from "../hermes-ask-mcp.mjs";

// Real unix sockets in a tmp dir per docs/architecture.md's state/hermes-ask.sock pattern.
const sockDir = () => mkdtempSync(path.join(tmpdir(), "hermes-ask-"));
const sockFile = (dir) => path.join(dir, "hermes-ask.sock");

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

// ── End-to-end: real server + real client over a real unix socket ────────────
test("askOwnerViaSocket resolves with the answer after polling pending twice", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const asked = [];
  let pollCount = 0;
  const server = createAskServer({
    sockPath,
    onAsk: async (payload) => {
      asked.push(payload);
      return { id: "q-e2e0001" };
    },
    getAnswer: async (id) => {
      assert.equal(id, "q-e2e0001");
      pollCount += 1;
      if (pollCount < 3) return { status: "pending" };
      return { status: "answered", answer: "yes, ship it" };
    },
  });
  await server.start();

  try {
    const answer = await askOwnerViaSocket({
      sockPath,
      sessionKey: "sess-1",
      question: "Ship now?",
      recommended: "yes, ship it",
      context: "CI green",
      pollMs: 10,
      timeoutMs: 5000,
    });
    assert.equal(answer, "yes, ship it");
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0], {
      sessionKey: "sess-1", question: "Ship now?", recommended: "yes, ship it", context: "CI green",
    });
    assert.ok(pollCount >= 3);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

// ── 400 on missing recommended ────────────────────────────────────────────────
test("POST /ask returns 400 when recommended is missing", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const server = createAskServer({
    sockPath,
    onAsk: async () => ({ id: "should-not-be-called" }),
    getAnswer: async () => ({ status: "pending" }),
  });
  await server.start();
  try {
    const { status, body } = await socketRequest(sockPath, "POST", "/ask", {
      sessionKey: "sess-1", question: "Ship now?",
    });
    assert.equal(status, 400);
    assert.match(body.error, /recommended/);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

test("POST /ask returns 400 when sessionKey is missing", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const server = createAskServer({ sockPath, onAsk: async () => ({ id: "x" }), getAnswer: async () => null });
  await server.start();
  try {
    const { status, body } = await socketRequest(sockPath, "POST", "/ask", {
      question: "Ship now?", recommended: "yes",
    });
    assert.equal(status, 400);
    assert.match(body.error, /sessionKey/);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

test("POST /ask returns 400 on malformed JSON", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const server = createAskServer({ sockPath, onAsk: async () => ({ id: "x" }), getAnswer: async () => null });
  await server.start();
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: sockPath, path: "/ask", method: "POST", agent: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      req.on("error", reject);
      req.write("{not json");
      req.end();
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error, /JSON/i);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

test("onAsk throwing surfaces as 500", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const server = createAskServer({
    sockPath,
    onAsk: async () => { throw new Error("disk full"); },
    getAnswer: async () => null,
  });
  await server.start();
  try {
    const { status } = await socketRequest(sockPath, "POST", "/ask", {
      sessionKey: "s", question: "q", recommended: "r",
    });
    assert.equal(status, 500);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

// ── 404 unknown answer id ──────────────────────────────────────────────────────
test("GET /answer/<id> returns 404 for an unknown id", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const server = createAskServer({ sockPath, onAsk: async () => ({ id: "x" }), getAnswer: async () => null });
  await server.start();
  try {
    const { status, body } = await socketRequest(sockPath, "GET", "/answer/q-unknown1");
    assert.equal(status, 404);
    assert.match(body.error, /q-unknown1/);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

test("unrouted paths return 404", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const server = createAskServer({ sockPath, onAsk: async () => ({ id: "x" }), getAnswer: async () => null });
  await server.start();
  try {
    const { status } = await socketRequest(sockPath, "GET", "/nope");
    assert.equal(status, 404);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

// ── 413 oversized body ─────────────────────────────────────────────────────────
test("POST /ask returns 413 for a body over 64KB", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const server = createAskServer({ sockPath, onAsk: async () => ({ id: "x" }), getAnswer: async () => null });
  await server.start();
  try {
    const huge = "x".repeat(70 * 1024);
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: sockPath, path: "/ask", method: "POST", agent: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* connection may reset before body completes */ }
          resolve({ status: res.statusCode, body });
        });
      });
      req.on("error", () => resolve({ status: null, body: {} })); // a hard reset is also an acceptable rejection
      req.write(JSON.stringify({ sessionKey: "s", question: "q", recommended: "r", context: huge }));
      req.end();
    });
    assert.ok(result.status === 413 || result.status === null);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

// ── Timeout path: exact handoff-note guidance message ─────────────────────────
test("askOwnerViaSocket throws the resume-fallback handoff message on timeout", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const server = createAskServer({
    sockPath,
    onAsk: async () => ({ id: "q-neverans" }),
    getAnswer: async () => ({ status: "pending" }), // never answers
  });
  await server.start();
  try {
    await assert.rejects(
      () => askOwnerViaSocket({
        sockPath, sessionKey: "s", question: "q?", recommended: "r",
        pollMs: 5, timeoutMs: 20,
      }),
      /No owner answer within .*h\. Write your handoff note to the ledger comment, then end the session; Hermes will resume you with the answer\./,
    );
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

// ── Transient polling errors don't fail before the deadline ───────────────────
test("askOwnerViaSocket keeps polling through transient socket errors until answered", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  let calls = 0;
  const server = createAskServer({
    sockPath,
    onAsk: async () => ({ id: "q-flaky001" }),
    getAnswer: async () => {
      calls += 1;
      if (calls <= 2) throw new Error("simulated transient failure"); // becomes a 500 on the wire
      return { status: "answered", answer: "ok" };
    },
  });
  await server.start();
  try {
    const answer = await askOwnerViaSocket({
      sockPath, sessionKey: "s", question: "q?", recommended: "r",
      pollMs: 5, timeoutMs: 5000,
    });
    assert.equal(answer, "ok");
    assert.ok(calls >= 3);
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

// ── Stale socket file cleanup ──────────────────────────────────────────────────
test("start() removes a stale (dead) socket file and succeeds", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  writeFileSync(sockPath, ""); // a dead leftover file, nothing listening
  const server = createAskServer({ sockPath, onAsk: async () => ({ id: "x" }), getAnswer: async () => null });
  await server.start();
  try {
    assert.ok(existsSync(sockPath));
    const { status } = await socketRequest(sockPath, "GET", "/answer/whatever");
    assert.equal(status, 404); // server is genuinely live and answering
  } finally {
    await server.stop();
    cleanup(dir);
  }
});

// ── Second live server on the same socket throws ──────────────────────────────
test("a second server on the same live socket throws instead of stealing it", async () => {
  const dir = sockDir();
  const sockPath = sockFile(dir);
  const first = createAskServer({ sockPath, onAsk: async () => ({ id: "x" }), getAnswer: async () => null });
  await first.start();
  const second = createAskServer({ sockPath, onAsk: async () => ({ id: "y" }), getAnswer: async () => null });
  try {
    await assert.rejects(() => second.start(), /already in use/);
    // The first server must still be alive and answering after the failed steal attempt.
    const { status } = await socketRequest(sockPath, "GET", "/answer/whatever");
    assert.equal(status, 404);
  } finally {
    await first.stop();
    cleanup(dir);
  }
});

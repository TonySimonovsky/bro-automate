/**
 * Standalone tests for extension/lib/file-transfer.js (Wave 2).
 * Mock HTTP server (node:http) + fake native bridge; no real native host.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import test from "node:test";

import * as ft from "../extension/lib/file-transfer.js";

/** @returns {Promise<{ server: http.Server, port: number, baseUrl: string, close: () => Promise<void> }>} */
function startMockFileServer(sessionToken) {
  /** @type {Map<string, { body: Buffer, consumed: boolean }>} */
  const routes = new Map();

  const server = http.createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const hdr = req.headers["x-bro-token"];
    const token = Array.isArray(hdr) ? hdr[0] : hdr;
    if (!token || token !== sessionToken) {
      res.writeHead(401).end();
      return;
    }
    const u = new URL(req.url || "/", "http://127.0.0.1");
    const pathname = u.pathname;
    const entry = routes.get(pathname);
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    if (entry.consumed) {
      res.writeHead(404).end();
      return;
    }
    entry.consumed = true;
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(entry.body.length),
    });
    res.end(entry.body);
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no address"));
        return;
      }
      const port = addr.port;
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        routes,
        close: () =>
          new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

function createFakeBridge(respond) {
  const handlers = [];
  return {
    send(msg) {
      queueMicrotask(() => respond(msg, (m) => handlers.forEach((h) => h(m))));
    },
    onMessage(handler) {
      handlers.push(handler);
    },
    offMessage(handler) {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    },
  };
}

test("fetchToBlob happy path", async () => {
  const session = "session-token-happy";
  const mock = await startMockFileServer(session);
  const bytes = crypto.randomBytes(1024);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const pathname = `/file/${crypto.randomBytes(8).toString("hex")}`;
  mock.routes.set(pathname, { body: bytes, consumed: false });

  const url = `${mock.baseUrl}${pathname}`;
  try {
    const blob = await ft.fetchToBlob(url, session, bytes.length, sha256);
    assert.equal(blob.size, bytes.length);
    const got = Buffer.from(await blob.arrayBuffer());
    assert.deepEqual(got, bytes);
  } finally {
    await mock.close();
  }
});

test("fetchToBlob wrong token → 401", async () => {
  const session = "session-correct";
  const mock = await startMockFileServer(session);
  const bytes = Buffer.alloc(16, 7);
  mock.routes.set("/f1", { body: bytes, consumed: false });
  const url = `${mock.baseUrl}/f1`;
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  try {
    await assert.rejects(
      () => ft.fetchToBlob(url, "wrong-token", bytes.length, sha256),
      (err) =>
        err &&
        typeof err === "object" &&
        err.code === "uploadRejected" &&
        typeof err.message === "string"
    );
  } finally {
    await mock.close();
  }
});

test("fetchToBlob wrong sha256 → throws code internal", async () => {
  const session = "session-sha";
  const mock = await startMockFileServer(session);
  const bytes = crypto.randomBytes(200);
  mock.routes.set("/f2", { body: bytes, consumed: false });
  const url = `${mock.baseUrl}/f2`;
  try {
    await assert.rejects(
      () =>
        ft.fetchToBlob(
          url,
          session,
          bytes.length,
          "0000000000000000000000000000000000000000000000000000000000000000"
        ),
      (err) =>
        err &&
        typeof err === "object" &&
        err.code === "internal" &&
        typeof err.message === "string" &&
        /sha256/i.test(err.message)
    );
  } finally {
    await mock.close();
  }
});

test("fetchToBlob one-time URL: second fetch → 404", async () => {
  const session = "session-once";
  const mock = await startMockFileServer(session);
  const bytes = crypto.randomBytes(64);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  mock.routes.set("/once", { body: bytes, consumed: false });
  const url = `${mock.baseUrl}/once`;
  try {
    const blob = await ft.fetchToBlob(url, session, bytes.length, sha256);
    assert.equal(blob.size, bytes.length);
    await assert.rejects(
      () => ft.fetchToBlob(url, session, bytes.length, sha256),
      (err) =>
        err &&
        typeof err === "object" &&
        err.code === "uploadRejected"
    );
  } finally {
    await mock.close();
  }
});

test("blobToBase64 roundtrip", async () => {
  const bytes = crypto.randomBytes(333);
  const blob = new Blob([bytes]);
  const b64 = await ft.blobToBase64(blob);
  const round = Buffer.from(b64, "base64");
  assert.deepEqual(round, bytes);
});

test("serveFile via fake nativeBridge resolves data", async () => {
  const meta = {
    url: "http://127.0.0.1:9/file/abc",
    size: 42,
    mime: "application/pdf",
    sha256: "aa".repeat(32),
  };
  let n = 0;
  const bridge = createFakeBridge((msg, emit) => {
    assert.equal(msg.action, "serveFile");
    assert.equal(msg.filePath, "/tmp/x.pdf");
    assert.ok(typeof msg.requestId === "string");
    queueMicrotask(() =>
      emit({
        ok: true,
        requestId: msg.requestId,
        data: { ...meta },
      })
    );
  });
  const out = await ft.serveFile("/tmp/x.pdf", {
    nativeBridge: bridge,
    requestIdFactory: () => `rid-${++n}`,
  });
  assert.deepEqual(out, meta);
});

test("serveFile error path rejects with code", async () => {
  const bridge = createFakeBridge((msg, emit) => {
    queueMicrotask(() =>
      emit({
        ok: false,
        requestId: msg.requestId,
        error: "internal",
        errorMessage: "disk melted",
      })
    );
  });
  await assert.rejects(
    () =>
      ft.serveFile("/tmp/y", {
        nativeBridge: bridge,
        requestIdFactory: () => "r-err",
      }),
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "internal" &&
      err.message === "disk melted"
  );
});

test("injectFileIntoInput in Node throws clear error (no chrome)", async () => {
  assert.equal(typeof globalThis.chrome, "undefined");
  await assert.rejects(
    () => ft.injectFileIntoInput(1, "#f", "", "a.txt", "text/plain"),
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "internal" &&
      typeof err.message === "string" &&
      /chrome is undefined/i.test(err.message)
  );
});

#!/usr/bin/env node
// native-host/host.js — Chrome native messaging host (PRD §5.6, §5.7; TDD §6).
// Responsibilities:
//   1. Speak Chrome native messaging on stdin/stdout (length-prefixed JSON).
//   2. Listen on /tmp/aichamp-bro-automate.sock (mode 0700) with multi-client routing.
//   3. Run an HTTP server on a random 127.0.0.1:<port> for binary I/O (token-authenticated).
//   4. Maintain a per-session token (16+ bytes, base64-url) and emit hostReady { httpPort, token }.
//   5. Handle serveFile { filePath } → { url, size, mime, sha256 } with one-time URLs.
//   6. Write logs to ~/.aichamp-bro-automate/logs/host.log with size-based rotation (5 MB × 5).
//   7. Clean shutdown on SIGTERM / extension disconnect.
// Coexists with the existing Upwork host (com.upwork.scraper.cco46) per PRD FR-N3.
// TDD: §6, §8, §12
// Tasks: T-300..T-306
// Wave: 2
// Status: implemented (Wave 2)
//
// Test / dev:
//   BRO_HOST_MAX_LOG_BYTES — log rotation threshold (default 5 MiB).
//   BRO_HOST_LOG_DIR — log directory (default ~/.aichamp-bro-automate/logs).
//   BRO_HOST_SOCKET_PATH — Unix socket path (default /tmp/aichamp-bro-automate.sock).

'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SOCKET_PATH = process.env.BRO_HOST_SOCKET_PATH || '/tmp/aichamp-bro-automate.sock';
const LOG_DIR = process.env.BRO_HOST_LOG_DIR
  ? path.resolve(process.env.BRO_HOST_LOG_DIR)
  : path.join(os.homedir(), '.aichamp-bro-automate', 'logs');
const LOG_BASENAME = 'host.log';
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_FILES = 5;
const FILE_URL_PREFIX = '/bro-file/';
const FILE_REGISTRY_TTL_MS = 60 * 1000;

const MIME_BY_EXT = {
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

function maxLogBytes() {
  const raw = process.env.BRO_HOST_MAX_LOG_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_LOG_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_LOG_BYTES;
}

function base64Url(bytes) {
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function logRecord(level, scope, msg, extra = {}) {
  const rec = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...extra,
  };
  return JSON.stringify(rec) + '\n';
}

let logWriteChain = Promise.resolve();

async function rotateLogsIfNeeded() {
  const logPath = path.join(LOG_DIR, LOG_BASENAME);
  let st;
  try {
    st = await fsp.stat(logPath);
  } catch {
    return;
  }
  if (st.size < maxLogBytes()) return;

  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const from = path.join(LOG_DIR, `${LOG_BASENAME}.${i}`);
    const to = path.join(LOG_DIR, `${LOG_BASENAME}.${i + 1}`);
    try {
      await fsp.rename(from, to);
    } catch {
      /* ok if missing */
    }
  }
  const firstRotated = path.join(LOG_DIR, `${LOG_BASENAME}.1`);
  try {
    await fsp.rename(logPath, firstRotated);
  } catch {
    /* ignore */
  }
}

function appendLogLine(level, scope, msg, extra = {}) {
  const line = logRecord(level, scope, msg, extra);
  logWriteChain = logWriteChain
    .then(() => rotateLogsIfNeeded())
    .then(async () => {
      await fsp.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
      const logPath = path.join(LOG_DIR, LOG_BASENAME);
      await fsp.appendFile(logPath, line, { mode: 0o600 });
    })
    .catch((err) => {
      try {
        console.error('host log failure', err);
      } catch {
        /* ignore */
      }
    });
  return logWriteChain;
}

let nativeWriteChain = Promise.resolve();

function sendNative(msg) {
  const json = JSON.stringify(msg);
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  const packet = Buffer.concat([header, body]);
  nativeWriteChain = nativeWriteChain.then(
    () =>
      new Promise((resolve, reject) => {
        process.stdout.write(packet, (err) => (err ? reject(err) : resolve()));
      }),
  );
  return nativeWriteChain;
}

const clients = new Map();
const inflight = new Map();
let nextClientId = 1;

/** pathToken -> { absPath, mime, size, expiresAt } */
const fileRegistry = new Map();

let sessionToken = '';
let httpPort = 0;
let httpServer = null;
let unixServer = null;
let shuttingDown = false;
let registrySweepTimer = null;

function cleanupFileRegistry() {
  const now = Date.now();
  for (const [tok, ent] of fileRegistry) {
    if (ent.expiresAt <= now) fileRegistry.delete(tok);
  }
}

function routeToClient(msg) {
  const rid = msg && msg.requestId;
  if (rid === undefined || rid === null) return false;
  const clientId = inflight.get(String(rid));
  if (clientId === undefined) return false;
  const sock = clients.get(clientId);
  if (!sock || sock.destroyed) {
    inflight.delete(String(rid));
    return false;
  }
  try {
    sock.write(JSON.stringify(msg) + '\n');
    return true;
  } catch (e) {
    appendLogLine('warn', 'bridge', 'socket write failed', { requestId: String(rid), msg: String(e) });
    return false;
  }
}

function onExtensionMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.event === 'log') {
    const level = msg.level === 'error' || msg.level === 'warn' ? msg.level : 'info';
    const scope = typeof msg.scope === 'string' ? msg.scope : 'bridge';
    const m = typeof msg.msg === 'string' ? msg.msg : JSON.stringify(msg);
    const extra = {};
    if (msg.runId != null) extra.runId = msg.runId;
    if (msg.requestId != null) extra.requestId = msg.requestId;
    void appendLogLine(level, scope, m, extra);
    return;
  }

  if (msg.action === 'serveFile') {
    void handleServeFile(msg);
    return;
  }

  if (routeToClient(msg)) return;

  if (process.env.BRO_HOST_DEBUG === '1' && msg.requestId != null) {
    appendLogLine('info', 'bridge', 'unrouted extension message (no socket client)', {
      requestId: String(msg.requestId),
    });
  }
}

async function handleServeFile(msg) {
  const requestId = msg.requestId != null ? String(msg.requestId) : '';
  const fail = (errorMessage) =>
    sendNative({
      requestId,
      ok: false,
      error: 'internal',
      errorMessage,
    });

  const filePath = msg.filePath;
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    await fail('serveFile: filePath must be an absolute path');
    return;
  }

  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (e) {
    await fail(`serveFile: ${e && e.message ? e.message : 'stat failed'}`);
    return;
  }
  if (!st.isFile()) {
    await fail('serveFile: not a regular file');
    return;
  }

  const mime = guessMime(filePath);
  const hash = crypto.createHash('sha256');
  let size = 0;

  try {
    const rs = fs.createReadStream(filePath);
    for await (const chunk of rs) {
      size += chunk.length;
      hash.update(chunk);
    }
  } catch (e) {
    await fail(`serveFile: read/hash failed: ${e && e.message ? e.message : e}`);
    return;
  }

  if (size !== st.size) {
    await fail('serveFile: size mismatch after read');
    return;
  }

  const sha256Hex = hash.digest('hex');
  const pathToken = base64Url(crypto.randomBytes(16));
  const expiresAt = Date.now() + FILE_REGISTRY_TTL_MS;
  fileRegistry.set(pathToken, { absPath: filePath, mime, size: st.size, expiresAt });

  const url = `http://127.0.0.1:${httpPort}${FILE_URL_PREFIX}${pathToken}`;
  await sendNative({
    requestId,
    ok: true,
    data: { url, size, mime, sha256: sha256Hex },
  });
}

function handleHttpRequest(req, res) {
  const hdr = req.headers['x-bro-token'];
  const tokenVal = Array.isArray(hdr) ? hdr[0] : hdr;
  if (tokenVal === undefined || tokenVal === '') {
    res.writeHead(401);
    res.end();
    return;
  }
  if (tokenVal !== sessionToken) {
    res.writeHead(403);
    res.end();
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`).pathname;
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end();
    return;
  }

  if (!pathname.startsWith(FILE_URL_PREFIX)) {
    res.writeHead(404);
    res.end();
    return;
  }

  const pathToken = pathname.slice(FILE_URL_PREFIX.length);
  const entry = fileRegistry.get(pathToken);
  if (!entry) {
    res.writeHead(404);
    res.end();
    return;
  }

  const stream = fs.createReadStream(entry.absPath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(500);
    }
    res.end();
  });

  res.writeHead(200, {
    'Content-Type': entry.mime,
    'Content-Length': String(entry.size),
  });

  res.on('finish', () => {
    fileRegistry.delete(pathToken);
  });

  stream.pipe(res);
}

let inputBuf = Buffer.alloc(0);

function processStdinBuffer() {
  while (inputBuf.length >= 4) {
    const len = inputBuf.readUInt32LE(0);
    if (inputBuf.length < 4 + len) break;
    const jsonBuf = inputBuf.subarray(4, 4 + len);
    inputBuf = inputBuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(jsonBuf.toString('utf8'));
    } catch {
      appendLogLine('warn', 'host', 'malformed native JSON from extension');
      continue;
    }
    onExtensionMessage(msg);
  }
}

function startUnixServer() {
  return new Promise((resolve, reject) => {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      /* ok */
    }

    const srv = net.createServer((socket) => {
      const clientId = String(nextClientId++);
      clients.set(clientId, socket);
      let buf = '';

      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            socket.write(JSON.stringify({ ok: false, error: 'internal', errorMessage: 'Invalid JSON' }) + '\n');
            continue;
          }
          const rid = obj && obj.requestId != null ? String(obj.requestId) : undefined;
          if (rid !== undefined) inflight.set(rid, clientId);
          sendNative(obj).catch((e) => {
            appendLogLine('error', 'bridge', 'sendNative failed', { msg: String(e) });
          });
        }
      });

      const detach = () => {
        clients.delete(clientId);
        for (const [k, v] of inflight) {
          if (v === clientId) inflight.delete(k);
        }
      };
      socket.on('end', detach);
      socket.on('error', detach);
    });

    srv.on('error', reject);
    srv.listen(SOCKET_PATH, () => {
      try {
        fs.chmodSync(SOCKET_PATH, 0o700);
      } catch {
        /* ok */
      }
      unixServer = srv;
      resolve();
    });
  });
}

function startHttpServer() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer(handleHttpRequest);
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      httpPort = typeof addr === 'object' && addr ? addr.port : 0;
      httpServer = srv;
      resolve();
    });
  });
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (registrySweepTimer) {
    clearInterval(registrySweepTimer);
    registrySweepTimer = null;
  }
  await new Promise((r) => {
    if (httpServer) httpServer.close(() => r());
    else r();
  });
  await new Promise((r) => {
    if (unixServer) unixServer.close(() => r());
    else r();
  });
  for (const s of clients.values()) {
    try {
      s.destroy();
    } catch {
      /* ignore */
    }
  }
  clients.clear();
  inflight.clear();
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    /* ignore */
  }
  await logWriteChain.catch(() => {});
  process.exit(0);
}

async function main() {
  sessionToken = base64Url(crypto.randomBytes(16));
  await fsp.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  await appendLogLine('info', 'host', 'host boot');

  await startHttpServer();
  await startUnixServer();

  registrySweepTimer = setInterval(cleanupFileRegistry, 30 * 1000);
  if (registrySweepTimer.unref) registrySweepTimer.unref();

  await sendNative({
    event: 'hostReady',
    httpPort,
    token: sessionToken,
  });

  process.stdin.on('data', (chunk) => {
    inputBuf = Buffer.concat([inputBuf, chunk]);
    processStdinBuffer();
  });
  process.stdin.on('end', () => {
    void shutdown();
  });

  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}

main().catch((err) => {
  try {
    console.error(err);
  } catch {
    /* ignore */
  }
  process.exit(1);
});

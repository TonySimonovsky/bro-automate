// pm/build/v.0.01/tests/host.test.mjs — Node self-test for native-host/host.js (Wave 2).
// Spawns the host and drives stdin/stdout as the Chrome extension side.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_JS = path.join(REPO_ROOT, 'native-host', 'host.js');

function encodeNative(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

function createNativeReader(stream) {
  let buf = Buffer.alloc(0);
  const queue = [];
  let wait = null;

  function deliver(obj) {
    if (wait) {
      const w = wait;
      wait = null;
      w.resolve(obj);
    } else {
      queue.push(obj);
    }
  }

  function parse() {
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      deliver(JSON.parse(body.toString('utf8')));
    }
  }

  stream.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    parse();
  });

  stream.on('end', () => {
    if (wait) wait.reject(new Error('EOF'));
  });

  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        wait = { resolve, reject };
      });
    },
  };
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (ch) => chunks.push(ch));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function connectSocketLineClient(sockPath) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(sockPath, () => resolve(sock));
    sock.on('error', reject);
  });
}

function readJsonLine(sock) {
  return new Promise((resolve, reject) => {
    let buf = '';
    function onData(chunk) {
      buf += chunk.toString('utf8');
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      sock.off('data', onData);
      const line = buf.slice(0, idx).trim();
      if (!line) {
        reject(new Error('empty line'));
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(e);
      }
    }
    sock.on('data', onData);
    sock.on('error', reject);
  });
}

test(
  'native host: hostReady, HTTP gate, serveFile, routing, logs, shutdown',
  { timeout: 120_000 },
  async () => {
    const tmpBase = await fsp.mkdtemp(path.join(os.tmpdir(), 'bro-host-test-'));
    const logDir = path.join(tmpBase, 'logs');
    const sockPath = path.join(tmpBase, 'test.sock');
    await fsp.mkdir(logDir, { recursive: true });

    const child = spawn(process.execPath, [HOST_JS], {
      env: {
        ...process.env,
        BRO_HOST_LOG_DIR: logDir,
        BRO_HOST_SOCKET_PATH: sockPath,
        BRO_HOST_MAX_LOG_BYTES: '16384',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const reader = createNativeReader(child.stdout);
    let httpPort = 0;
    let token = '';

    try {
      const ready = await reader.next();
      assert.equal(ready.event, 'hostReady');
      assert.equal(typeof ready.httpPort, 'number');
      assert.ok(ready.httpPort > 0);
      assert.equal(typeof ready.token, 'string');
      assert.ok(ready.token.length > 0);
      assert.equal(ready.protocolVersion, undefined);
      httpPort = ready.httpPort;
      token = ready.token;

      const r401 = await httpGet(`http://127.0.0.1:${httpPort}/anything`);
      assert.equal(r401.status, 401);

      const r403 = await httpGet(`http://127.0.0.1:${httpPort}/anything`, { 'X-Bro-Token': 'wrong' });
      assert.equal(r403.status, 403);

      const tmpFile = path.join(tmpBase, 'payload.bin');
      const payload = crypto.randomBytes(1024);
      await fsp.writeFile(tmpFile, payload);
      const expectHash = crypto.createHash('sha256').update(payload).digest('hex');

      child.stdin.write(
        encodeNative({ action: 'serveFile', filePath: tmpFile, requestId: 't1' }),
      );

      const sf = await reader.next();
      assert.equal(sf.requestId, 't1');
      assert.equal(sf.ok, true);
      assert.equal(sf.data.size, 1024);
      assert.equal(sf.data.sha256, expectHash);
      assert.equal(typeof sf.data.url, 'string');
      assert.ok(sf.data.url.includes(`:${httpPort}/bro-file/`));

      const okFetch = await httpGet(sf.data.url, { 'X-Bro-Token': token });
      assert.equal(okFetch.status, 200);
      assert.equal(okFetch.body.length, 1024);
      assert.deepEqual(okFetch.body, payload);

      const gone = await httpGet(sf.data.url, { 'X-Bro-Token': token });
      assert.equal(gone.status, 404);

      await fsp.access(sockPath);

      const c1 = await connectSocketLineClient(sockPath);
      const c2 = await connectSocketLineClient(sockPath);

      c1.write(`${JSON.stringify({ requestId: 'sock-a', action: 'ping' })}\n`);
      const forwardedA = await reader.next();
      assert.equal(forwardedA.requestId, 'sock-a');
      const backAp = readJsonLine(c1);
      child.stdin.write(encodeNative({ requestId: 'sock-a', ok: true, data: { routed: 'a' } }));
      const backA = await backAp;
      assert.equal(backA.requestId, 'sock-a');
      assert.equal(backA.ok, true);
      assert.equal(backA.data.routed, 'a');

      c2.write(`${JSON.stringify({ requestId: 'sock-b', action: 'ping' })}\n`);
      const forwardedB = await reader.next();
      assert.equal(forwardedB.requestId, 'sock-b');
      const backBp = readJsonLine(c2);
      child.stdin.write(encodeNative({ requestId: 'sock-b', ok: true, data: { routed: 'b' } }));
      const backB = await backBp;
      assert.equal(backB.requestId, 'sock-b');
      assert.equal(backB.ok, true);
      assert.equal(backB.data.routed, 'b');

      c1.end();
      c2.end();

      for (let i = 0; i < 80; i++) {
        child.stdin.write(
          encodeNative({
            event: 'log',
            level: 'info',
            scope: 'ext',
            msg: 'x'.repeat(400),
          }),
        );
      }
      await new Promise((r) => setTimeout(r, 600));
      const rotated = path.join(logDir, 'host.log.1');
      await fsp.access(rotated);
      const mainLog = path.join(logDir, 'host.log');
      const st = await fsp.stat(mainLog);
      assert.ok(st.size < 20_000);

      assert.ok(fs.existsSync(sockPath));
    } finally {
      child.kill('SIGTERM');
      const exitPromise = once(child, 'exit');
      const raced = await Promise.race([
        exitPromise.then(([code, sig]) => ({ code, sig })),
        new Promise((_, rej) => setTimeout(() => rej(new Error('host did not exit within 2s')), 2000)),
      ]);
      assert.equal(raced.code, 0);
      assert.equal(raced.sig, null);
    }

    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!fs.existsSync(sockPath));
  },
);

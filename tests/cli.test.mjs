/**
 * CLI tests for cli/bro.js (TDD T-800, T-801).
 * Standalone: mock Unix socket server + subprocess; no native-host dependency.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const broJs = join(__dirname, '../cli/bro.js');

function tempSockPath() {
  return join(tmpdir(), `bro-cli-test-${randomBytes(8).toString('hex')}.sock`);
}

function listenUnix(server, path) {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
  return new Promise((resolve, reject) => {
    server.listen(path, () => resolve());
    server.on('error', reject);
  });
}

function runBro(args, env = {}) {
  return new Promise((resolve, reject) => {
    const chunksOut = [];
    const chunksErr = [];
    const child = spawn(process.execPath, [broJs, ...args], {
      env: { ...process.env, ...env },
    });
    child.stdout.on('data', (d) => chunksOut.push(d));
    child.stderr.on('data', (d) => chunksErr.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(chunksOut).toString('utf8'),
        stderr: Buffer.concat(chunksErr).toString('utf8'),
      });
    });
  });
}

test('happy terminal ok: true', async () => {
  const sockPath = tempSockPath();
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      buf = buf.slice(nl + 1);
      sock.write(
        JSON.stringify({
          requestId: 't1',
          ok: true,
          data: { foo: 'bar' },
        }) + '\n'
      );
      sock.end();
    });
  });
  await listenUnix(server, sockPath);
  try {
    const r = await runBro(
      [JSON.stringify({ requestId: 't1', action: 'runScenario', scenarioId: 'x' })],
      { BRO_SOCKET_PATH: sockPath }
    );
    assert.match(r.stdout, /^\{.*"ok":true.*\}\n$/);
    assert.equal(r.stderr, '');
    assert.equal(r.code, 0);
  } finally {
    server.close();
    try {
      unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  }
});

test('terminal ok: false', async () => {
  const sockPath = tempSockPath();
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      buf = buf.slice(nl + 1);
      sock.write(
        JSON.stringify({
          requestId: 't2',
          ok: false,
          error: 'selectorTimeout',
          errorMessage: 'timed out',
        }) + '\n'
      );
      sock.end();
    });
  });
  await listenUnix(server, sockPath);
  try {
    const r = await runBro(
      [JSON.stringify({ requestId: 't2', action: 'runScenario', scenarioId: 'x' })],
      { BRO_SOCKET_PATH: sockPath }
    );
    assert.match(r.stdout, /\{[^}]*"ok":false[^}]*\}\n/);
    assert.equal(r.stderr, '');
    assert.equal(r.code, 1);
  } finally {
    server.close();
    try {
      unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  }
});

test('progress before terminal', async () => {
  const sockPath = tempSockPath();
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      buf = buf.slice(nl + 1);
      sock.write(
        JSON.stringify({
          requestId: 't3',
          runId: 'r1',
          event: 'runProgress',
          stepIndex: 1,
        }) + '\n'
      );
      sock.write(
        JSON.stringify({
          requestId: 't3',
          runId: 'r1',
          event: 'runProgress',
          stepIndex: 2,
        }) + '\n'
      );
      sock.write(
        JSON.stringify({
          requestId: 't3',
          ok: true,
          data: { done: true },
        }) + '\n'
      );
      sock.end();
    });
  });
  await listenUnix(server, sockPath);
  try {
    const r = await runBro(
      [JSON.stringify({ requestId: 't3', action: 'runScenario', scenarioId: 'x' })],
      { BRO_SOCKET_PATH: sockPath }
    );
    const errLines = r.stderr.trim().split('\n').filter(Boolean);
    assert.equal(errLines.length, 2);
    assert.doesNotThrow(() => JSON.parse(errLines[0]));
    assert.doesNotThrow(() => JSON.parse(errLines[1]));
    assert.match(r.stdout, /"ok":true/);
    assert.equal(r.code, 0);
  } finally {
    server.close();
    try {
      unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  }
});

test('BRO_CLI_LOG writes full terminal response to file and prints compact stdout', async () => {
  const sockPath = tempSockPath();
  const logPath = join(tmpdir(), `bro-cli-log-${randomBytes(8).toString('hex')}.jsonl`);
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      buf = buf.slice(nl + 1);
      sock.write(
        JSON.stringify({
          requestId: 'log1',
          runId: 'r1',
          ok: false,
          action: 'runScenarioResult',
          error: 'selectorTimeout',
          errorMessage: 'timed out',
          phase: 'openComposer',
          debug: { huge: 'payload' },
          partial: [{ huge: 'partial' }],
        }) + '\n'
      );
      sock.end();
    });
  });
  await listenUnix(server, sockPath);
  try {
    const r = await runBro(
      [JSON.stringify({ requestId: 'log1', action: 'runScenario', scenarioId: 'x' })],
      { BRO_SOCKET_PATH: sockPath, BRO_CLI_LOG_PATH: logPath }
    );
    const stdout = JSON.parse(r.stdout);
    assert.equal(stdout.ok, false);
    assert.equal(stdout.phase, 'openComposer');
    assert.equal(stdout.debugOmittedFromTerminal, true);
    assert.equal(stdout.debugLog, logPath);
    assert.equal(Object.hasOwn(stdout, 'debug'), false);
    assert.equal(Object.hasOwn(stdout, 'partial'), false);
    assert.match(readFileSync(logPath, 'utf8'), /"debug":\{"huge":"payload"\}/);
    assert.equal(r.code, 1);
  } finally {
    server.close();
    try {
      unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(logPath);
    } catch {
      /* ignore */
    }
  }
});

test('bad JSON arg', async () => {
  const r = await runBro(['{not json'], { BRO_SOCKET_PATH: tempSockPath() });
  assert.match(r.stderr, /invalid JSON/);
  assert.equal(r.code, 2);
});

test('no arg', async () => {
  const r = await runBro([], { BRO_SOCKET_PATH: tempSockPath() });
  assert.match(r.stderr, /Usage:/);
  assert.equal(r.code, 4);
});

test('--help', async () => {
  const r = await runBro(['--help'], { BRO_SOCKET_PATH: tempSockPath() });
  assert.match(r.stdout, /Usage:/);
  assert.equal(r.code, 0);
});

test('connect failure', async () => {
  const ghostPath = join(
    tmpdir(),
    `bro-cli-ghost-${randomBytes(8).toString('hex')}.sock`
  );
  try {
    unlinkSync(ghostPath);
  } catch {
    /* ignore */
  }
  const r = await runBro(
    [JSON.stringify({ requestId: 'c1', action: 'ping' })],
    { BRO_SOCKET_PATH: ghostPath, BRO_CLI_CONNECT_TIMEOUT_MS: '50' }
  );
  assert.match(r.stderr, /cannot connect/);
  assert.equal(r.code, 3);
});

test('EOF without terminal', async () => {
  const sockPath = tempSockPath();
  const server = createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('\n')) {
        sock.end();
      }
    });
  });
  await listenUnix(server, sockPath);
  try {
    const r = await runBro(
      [JSON.stringify({ requestId: 'e1', action: 'runScenario', scenarioId: 'x' })],
      { BRO_SOCKET_PATH: sockPath }
    );
    assert.match(r.stderr, /socket closed/);
    assert.equal(r.code, 3);
  } finally {
    server.close();
    try {
      unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  }
});

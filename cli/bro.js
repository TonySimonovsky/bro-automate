#!/usr/bin/env node
// cli/bro.js — one-shot CLI for manual testing (PRD §5.14, FR-CLI1..3).
// Connects to /tmp/aichamp-bro-automate.sock (or BRO_SOCKET_PATH), sends one JSON line,
// prints the terminal response as one JSON line on stdout, streams progress events on stderr.
// Terminal = object with boolean `ok` and matching `requestId`; all other JSON lines for this
// request go to stderr. If `requestId` is missing, a UUID is generated and injected (stderr notice).
// Exit: 0 ok:true, 1 ok:false, 2 invalid input, 3 transport, 4 usage.
// TDD: §5.14, §16.8
// Tasks: T-800, T-801
// Wave: 2
// Status: implemented (Wave 2)

'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const process = require('node:process');

const DEFAULT_SOCKET = '/tmp/aichamp-bro-automate.sock';
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const CONNECT_RETRY_MS = 500;

function usageText() {
  return `Usage: bro.js '<json-line>'
       bro.js --log <path> '<json-line>'
       bro.js --help

Connects to the Bro Automate Unix socket (BRO_SOCKET_PATH or ${DEFAULT_SOCKET}),
sends one JSON object as a line, prints the terminal response (matching requestId, with ok:true|false) on stdout,
and prints progress JSON lines on stderr.

Debug logging:
  --log <path>            Write JSONL capture to a specific file.
  BRO_CLI_LOG=1           Write JSONL capture to pm/build/v.0.01/logs/cli/<timestamp>__<requestId>.jsonl.
  BRO_CLI_LOG_DIR=<dir>   Write the auto-named JSONL capture under <dir>.
  BRO_CLI_LOG_PATH=<path> Write JSONL capture to a specific file.
  BRO_CLI_VERBOSE=1       Also print progress JSON lines to stderr when file logging is enabled.

Exit codes: 0 success (ok:true), 1 run error (ok:false), 2 invalid JSON or payload, 3 transport error, 4 usage error.
`;
}

function main() {
  const parsedArgs = parseArgs(process.argv.slice(2));
  const argv = parsedArgs.args;
  const cliLogPath = parsedArgs.logPath;

  if (argv.length === 0) {
    process.stderr.write(usageText());
    process.exit(4);
  }

  if (argv[0] === '--help' || argv[0] === '-h') {
    if (argv.length !== 1) {
      process.stderr.write(usageText());
      process.exit(4);
    }
    process.stdout.write(usageText());
    process.exit(0);
  }

  if (argv.length !== 1) {
    process.stderr.write(usageText());
    process.exit(4);
  }

  const rawArg = argv[0];
  let payload;
  try {
    payload = JSON.parse(rawArg);
  } catch (e) {
    process.stderr.write(`cli error: invalid JSON: ${e.message}\n`);
    process.exit(2);
  }

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    process.stderr.write('cli error: invalid JSON: expected a JSON object\n');
    process.exit(2);
  }

  let requestId = payload.requestId;
  if (requestId == null || requestId === '') {
    requestId = randomUUID();
    payload.requestId = requestId;
    process.stderr.write(`cli: generated requestId=${requestId}\n`);
  } else {
    requestId = String(requestId);
    payload.requestId = requestId;
  }

  const socketPath = process.env.BRO_SOCKET_PATH || DEFAULT_SOCKET;
  const connectTimeoutMs = parsePositiveInt(
    process.env.BRO_CLI_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS
  );
  const outbound = `${JSON.stringify(payload)}\n`;
  const logPath = resolveLogPath({ cliLogPath, payload, requestId });
  const writeLog = createJsonlLogger(logPath);
  const verboseProgress = !logPath || process.env.BRO_CLI_VERBOSE === '1';
  if (logPath) {
    process.stderr.write(`cli: writing debug log to ${logPath}\n`);
  }
  writeLog('cliStart', {
    requestId,
    socketPath,
    payload,
    argv: process.argv.slice(2),
  });

  let completed = false;
  let buf = '';
  let warnedWaitingForSocket = false;

  function failTransport(message) {
    if (completed) return;
    completed = true;
    writeLog('transportError', { requestId, message });
    process.stderr.write(`${message}\n`);
    process.exit(3);
  }

  function finishOk(msg) {
    if (completed) return;
    completed = true;
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    writeLog('terminal', { requestId, message: msg });
    const terminalOut = logPath && !verboseProgress ? compactTerminalMessage(msg, logPath) : msg;
    process.stdout.write(`${JSON.stringify(terminalOut)}\n`);
    process.exit(msg.ok === true ? 0 : 1);
  }

  let socket = null;
  const startedAt = Date.now();

  function connectWithRetry() {
    if (completed) return;
    const s = net.createConnection(socketPath);
    socket = s;

    s.on('connect', () => {
      writeLog('socketConnect', { requestId, socketPath });
      s.write(outbound, 'utf8');
      writeLog('socketWrite', { requestId, line: outbound.trimEnd() });
    });

    s.on('data', onData);
    s.on('end', onEnd);
    s.on('close', onClose);
    s.on('error', (err) => {
      if (completed) return;
      if (
        (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') &&
        Date.now() - startedAt < connectTimeoutMs
      ) {
        if (!warnedWaitingForSocket) {
          warnedWaitingForSocket = true;
          writeLog('socketWaiting', { requestId, socketPath, connectTimeoutMs });
          process.stderr.write(
            `cli: waiting for Bro Automate socket at ${socketPath} (up to ${connectTimeoutMs}ms)\n`
          );
        }
        s.removeListener('close', onClose);
        setTimeout(connectWithRetry, CONNECT_RETRY_MS);
        return;
      }
      completed = true;
      writeLog('transportError', { requestId, socketPath, message: err.message, code: err.code });
      process.stderr.write(
        `cli error: cannot connect to ${socketPath}: ${err.message}\n`
      );
      process.exit(3);
    });
  }

  function onData(chunk) {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length === 0) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        writeLog('rawLine', { requestId, line, parseError: true });
        process.stderr.write(`${line}\n`);
        continue;
      }

      const isTerminal =
        msg &&
        typeof msg === 'object' &&
        typeof msg.ok === 'boolean' &&
        msg.requestId === requestId;

      if (isTerminal) {
        writeLog('rawMessage', { requestId, message: msg, terminal: true });
        finishOk(msg);
        return;
      }

      if (
        msg &&
        typeof msg === 'object' &&
        !Array.isArray(msg) &&
        msg.requestId === requestId
      ) {
        writeLog('rawMessage', { requestId, message: msg, terminal: false });
        if (verboseProgress) {
          process.stderr.write(`${line}\n`);
        }
      }
    }
  }

  function onEnd() {
    if (!completed) {
      failTransport('cli error: socket closed before terminal response');
    }
  }

  function onClose() {
    if (!completed) {
      failTransport('cli error: socket closed before terminal response');
    }
  }

  connectWithRetry();
}

function parseArgs(argv) {
  const args = [];
  let logPath = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--log') {
      if (i + 1 >= argv.length) {
        process.stderr.write(usageText());
        process.exit(4);
      }
      logPath = argv[++i];
      continue;
    }
    args.push(arg);
  }
  return { args, logPath };
}

function resolveLogPath({ cliLogPath, payload, requestId }) {
  const explicit = cliLogPath || process.env.BRO_CLI_LOG_PATH;
  if (explicit) return path.resolve(explicit);

  if (process.env.BRO_CLI_LOG !== '1' && process.env.BRO_CLI_LOG_DIR == null) {
    return null;
  }

  const logDir = process.env.BRO_CLI_LOG_DIR
    ? path.resolve(process.env.BRO_CLI_LOG_DIR)
    : path.resolve(process.cwd(), 'pm/build/v.0.01/logs/cli');
  const scenario = sanitizePathPart(payload.scenarioId || payload.action || 'request');
  const req = sanitizePathPart(requestId);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(logDir, `${ts}__${scenario}__${req}.jsonl`);
}

function createJsonlLogger(logPath) {
  if (!logPath) return () => {};
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return (type, data) => {
    const entry = {
      ts: new Date().toISOString(),
      type,
      ...data,
    };
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
  };
}

function sanitizePathPart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'unknown';
}

function compactTerminalMessage(msg, logPath) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
  const out = {};
  for (const key of ['requestId', 'runId', 'ok', 'action', 'error', 'errorMessage', 'phase']) {
    if (Object.prototype.hasOwnProperty.call(msg, key)) out[key] = msg[key];
  }
  if (Object.prototype.hasOwnProperty.call(msg, 'data')) out.data = msg.data;
  out.debugLog = logPath;
  if (msg.debug || msg.partial) {
    out.debugOmittedFromTerminal = true;
  }
  return out;
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

main();

#!/usr/bin/env node
// RPA CDP bridge v002 — HTTP server connecting Claude (via curl) to the extension (via long-poll).
//
// Step scripts (execute.cdp.js / verify.cdp.js) are evaluated here in Node.js via vm + a chrome
// shim, so the extension never needs eval and MV3 CSP is not violated.
//
// Claude interface (blocking — returns when extension completes the command):
//   POST /command        { type, ...args }             → result JSON
//   POST /run-scenario   { scenarioPath, params?, stopOnFail? } → { steps[], logFile }
//   GET  /last-run                                     → last completed run result
//   GET  /status                                       → in-flight run snapshot (currentStep, phase, command)
// Note: /command is rejected with 409 while a /run-scenario is in flight to keep the queue clean.
//
// Command types (atomic, routed to extension):
//   { type: "tabs", query?: {} }
//   { type: "attach", tabId }
//   { type: "detach", tabId }
//   { type: "cdp", tabId, method, params? }
//   { type: "create-tab", url? }
//   { type: "close-tab", tabId }
//   { type: "group-tab", tabId, title?, color? }
//
// Extension interface (internal):
//   GET  /next      long-polls for next command (30s timeout → 204)
//   POST /done      posts result back

const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PORT = 7823;

let waitingForCommand = null;
let queuedCommand = null;
let waitingForResult = null;
let currentCommand = null; // in-flight command; resent (by id) if extension reconnects mid-execution
let currentCommandSentAt = 0; // wall-clock ms when currentCommand was sent
let lastRunResult = null;
// Start at a process-unique base so cmdIds from this bridge run don't collide
// with the extension's processedResults cache from previous bridge runs.
let nextCommandId = (Date.now() & 0xfffff) * 1000 + 1;
let runInFlight = null; // { startedAt, scenarioPath, tabId, currentStep, currentPhase, currentLogFile, steps }
let runLogFile = null;  // path to current run's log file (written incrementally)
const RING_LIMIT = 50;
const eventRing = []; // last RING_LIMIT log events, for /status
const lastNavigateByTab = new Map(); // tabId → { url, sentAt } so we can flag URL drift

function pushEvent(line) {
  eventRing.push(line);
  if (eventRing.length > RING_LIMIT) eventRing.shift();
  if (runInFlight && runInFlight.currentStep != null) {
    const stepObj = runInFlight.steps.find(s => s.step === runInFlight.currentStep);
    if (stepObj) {
      stepObj.events = stepObj.events || [];
      stepObj.events.push(line);
      if (stepObj.events.length > 200) stepObj.events.shift();
    }
  }
}

function logEvent(...args) {
  const ts = new Date().toISOString();
  const line = `[rpa-cdp-v002 ${ts}] ` + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  console.log(line);
  pushEvent(line);
}

function snippet(obj, max = 160) {
  if (obj == null) return '';
  let s;
  try { s = typeof obj === 'string' ? obj : JSON.stringify(obj); } catch (_) { s = String(obj); }
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}

function extractUrlFromResult(result) {
  if (!result || typeof result !== 'object') return null;
  const r = result.result;
  if (!r) return null;
  if (typeof r.url === 'string') return r.url;
  if (r.value && typeof r.value === 'string') {
    const m = r.value.match(/"url"\s*:\s*"([^"]{1,400})"/);
    if (m) return m[1];
  }
  return null;
}

function writeRunLog() {
  if (!runInFlight || !runLogFile) return;
  try {
    fs.writeFileSync(runLogFile, JSON.stringify(runInFlight, null, 2));
  } catch (e) {
    console.warn('[rpa-cdp-v002] writeRunLog failed:', e.message);
  }
}

function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

// Send one atomic command to the extension and wait for its result.
// If the extension dies mid-execution and reconnects, /next will resend currentCommand.
function sendCommand(cmd) {
  const tagged = { ...cmd, _cmdId: nextCommandId++ };
  currentCommand = tagged;
  currentCommandSentAt = Date.now();
  const briefMethod = cmd.type === 'cdp' ? `cdp ${cmd.method}` : cmd.type;
  let paramSnip = '';
  if (cmd.type === 'cdp' && cmd.params) {
    if (cmd.method === 'Page.navigate' && cmd.params.url) paramSnip = ` url=${cmd.params.url}`;
    else if (cmd.method === 'Runtime.evaluate' && cmd.params.expression) paramSnip = ` expr=${snippet(cmd.params.expression, 80)}`;
    else paramSnip = ` params=${snippet(cmd.params, 80)}`;
  } else if (cmd.url) {
    paramSnip = ` url=${cmd.url}`;
  }
  logEvent(`→ send #${tagged._cmdId} ${briefMethod}` + (cmd.tabId ? ` tab=${cmd.tabId}` : '') + paramSnip);
  if (cmd.type === 'cdp' && cmd.method === 'Page.navigate' && cmd.tabId && cmd.params && cmd.params.url) {
    lastNavigateByTab.set(cmd.tabId, { url: cmd.params.url, sentAt: currentCommandSentAt });
  }
  return new Promise((resolve, reject) => {
    if (waitingForCommand) {
      const wake = waitingForCommand; waitingForCommand = null;
      wake(tagged);
    } else {
      queuedCommand = tagged;
    }
    waitingForResult = (result) => {
      const ms = Date.now() - currentCommandSentAt;
      const ok = result && result.success !== false;
      const errSuffix = ok ? '' : ` error=${JSON.stringify((result && result.error) || '')}`;
      const resultSnip = ok && result && result.result !== undefined ? ` result=${snippet(result.result, 160)}` : '';
      logEvent(`← done #${tagged._cmdId} ${briefMethod} ${ms}ms ok=${!!ok}${errSuffix}${resultSnip}`);
      // URL-drift detection: any cdp result that surfaces a url field gets compared to the last requested navigate on that tab.
      if (cmd.tabId && lastNavigateByTab.has(cmd.tabId)) {
        const observed = extractUrlFromResult(result);
        if (observed) {
          const requested = lastNavigateByTab.get(cmd.tabId).url;
          try {
            const reqHostPath = new URL(requested).host + new URL(requested).pathname;
            const obsHostPath = new URL(observed).host + new URL(observed).pathname;
            if (reqHostPath !== obsHostPath) {
              logEvent(`⚠ navigation_redirected tab=${cmd.tabId} requested=${requested} observed=${observed}`);
              lastNavigateByTab.delete(cmd.tabId);
            }
          } catch (_) {}
        }
      }
      resolve(result);
    };
    setTimeout(() => {
      currentCommand = null;
      logEvent(`✗ timeout #${tagged._cmdId} ${briefMethod} after 300s`);
      reject(new Error('Extension did not respond within 300s'));
    }, 300000);
  }).catch(e => ({ success: false, error: e.message }));
}

// Build a chrome shim for use inside vm context.
// Only chrome.debugger.sendCommand is needed by step scripts; everything else goes through the bridge.
function makeChrome(tabId) {
  return {
    debugger: {
      sendCommand: async (target, method, params = {}) => {
        const r = await sendCommand({ type: 'cdp', tabId: target.tabId, method, params });
        if (!r.success) throw new Error(r.error);
        return r.result;
      },
    },
  };
}

// Evaluate a step script in Node.js and call fnName(tabId, params).
// The script declares execute() or verify() at the top level; vm exposes it on the sandbox.
async function runStepFn(code, fnName, tabId, params = {}) {
  const sandbox = vm.createContext({
    chrome: makeChrome(tabId),
    console,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Array,
    Object,
    Error,
    Math,
    parseInt,
    parseFloat,
    isNaN,
    Number,
    String,
    Boolean,
    Map,
    Set,
  });
  vm.runInContext(code, sandbox);
  if (typeof sandbox[fnName] !== 'function') {
    throw new Error(`Function ${fnName} not found in script`);
  }
  return sandbox[fnName](tabId, params);
}

// Run a full scenario folder: step-1/, step-2/, … each with execute.cdp.js + verify.cdp.js.
// If `tabId` is omitted: creates a dedicated tab + group, closes the tab on success.
// If `tabId` is provided: reuses the caller's tab; the runner only attaches/detaches and
// never closes the tab (caller owns lifecycle and starting/ending DOM state).
async function runScenario({ scenarioPath, stopOnFail = true, params = {}, tabId: callerTabId }) {
  const absPath = path.resolve(scenarioPath);
  const entries = fs.readdirSync(absPath)
    .filter(n => /^step-\d+$/.test(n))
    .sort((a, b) => parseInt(a.replace('step-', ''), 10) - parseInt(b.replace('step-', ''), 10));

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const logDir = path.join(absPath, 'tmp');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `rpa-run-${stamp}.log.json`);
  runLogFile = logFile;
  runInFlight = {
    scenarioPath: absPath,
    tabId: null,
    tabOwned: null,
    startedAt,
    finishedAt: null,
    success: null,
    currentStep: null,
    currentPhase: 'setup',
    steps: [],
    logFile,
  };
  writeRunLog();
  logEvent(`▶ run started ${absPath} (log: ${logFile})`);

  let tabId;
  let tabOwned;
  if (callerTabId != null) {
    // Caller-provided tab: validate it exists, then reuse without creating/grouping/closing.
    // Note: the `tabs` command returns a raw array (not the {success, result} wrapper used by
    // other commands). Handle both shapes defensively in case the extension contract changes.
    const tabsResult = await sendCommand({ type: 'tabs', query: {} });
    const list = Array.isArray(tabsResult) ? tabsResult
               : Array.isArray(tabsResult && tabsResult.result) ? tabsResult.result
               : null;
    if (!list) {
      const detail = tabsResult && tabsResult.error ? tabsResult.error : JSON.stringify(tabsResult);
      throw new Error(`tabs query failed (unexpected shape): ${detail}`);
    }
    const found = list.find(t => t.id === callerTabId);
    if (!found) throw new Error(`tabId ${callerTabId} not found; refusing to create a replacement (caller asked to reuse). Pass a valid tabId or omit it to let the runner create one.`);
    tabId = callerTabId;
    tabOwned = false;
    logEvent(`reusing caller-provided tab ${tabId} (owner=caller; runner will not close it)`);
  } else {
    // Create a dedicated tab for this run.
    const createResult = await sendCommand({ type: 'create-tab', url: 'about:blank' });
    if (!createResult.success) throw new Error(`Failed to create tab: ${createResult.error}`);
    tabId = createResult.tabId;
    tabOwned = true;
    logEvent(`created tab ${tabId}`);

    // Group it — title: last two path segments, e.g. "linkedin · 135244"
    const parts = absPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const groupTitle = parts.slice(-2).join(' · ');
    await sendCommand({ type: 'group-tab', tabId, title: groupTitle, color: 'blue' });
  }
  runInFlight.tabId = tabId;
  runInFlight.tabOwned = tabOwned;
  writeRunLog();

  await sendCommand({ type: 'attach', tabId });

  const steps = runInFlight.steps;
  let failed = false;

  for (const stepDir of entries) {
    const stepNum = parseInt(stepDir.replace('step-', ''), 10);
    const stepPath = path.join(absPath, stepDir);
    const step = { step: stepNum, dir: stepDir, ts: new Date().toISOString() };
    steps.push(step);
    runInFlight.currentStep = stepNum;
    writeRunLog();

    // --- execute ---
    const execFile = path.join(stepPath, 'execute.cdp.js');
    if (!fs.existsSync(execFile)) {
      step.executeSkipped = true;
    } else {
      runInFlight.currentPhase = 'execute';
      writeRunLog();
      const t0 = Date.now();
      logEvent(`▶ step ${stepNum} execute starting`);
      try {
        const code = fs.readFileSync(execFile, 'utf8');
        const result = await runStepFn(code, 'execute', tabId, params);
        const stepFailed = result && (result.success === false || result.ok === false);
        step.execute = { success: !stepFailed, ms: Date.now() - t0, result };
        if (stepFailed) {
          step.aborted = 'execute returned failure';
          logEvent(`✗ step ${stepNum} execute returned failure in ${step.execute.ms}ms: ${snippet(result, 200)}`);
          writeRunLog();
          failed = true;
          if (stopOnFail) break;
          continue;
        }
        logEvent(`✓ step ${stepNum} execute done in ${step.execute.ms}ms`);
      } catch (e) {
        step.execute = { success: false, ms: Date.now() - t0, error: e.message };
        step.aborted = 'execute failed';
        logEvent(`✗ step ${stepNum} execute FAILED in ${step.execute.ms}ms: ${e.message}`);
        writeRunLog();
        failed = true;
        if (stopOnFail) break;
        continue;
      }
      writeRunLog();
    }

    // --- verify ---
    const verifyFile = path.join(stepPath, 'verify.cdp.js');
    if (!fs.existsSync(verifyFile)) {
      step.verifySkipped = true;
    } else {
      runInFlight.currentPhase = 'verify';
      writeRunLog();
      const t0 = Date.now();
      logEvent(`▶ step ${stepNum} verify starting`);
      try {
        const code = fs.readFileSync(verifyFile, 'utf8');
        const result = await runStepFn(code, 'verify', tabId, params);
        const stepFailed = result && (result.success === false || result.ok === false);
        step.verify = { success: !stepFailed, ms: Date.now() - t0, result };
        if (stepFailed) {
          step.aborted = 'verify returned failure';
          logEvent(`✗ step ${stepNum} verify returned failure in ${step.verify.ms}ms: ${snippet(result, 200)}`);
          writeRunLog();
          failed = true;
          if (stopOnFail) break;
          continue;
        }
        logEvent(`✓ step ${stepNum} verify done in ${step.verify.ms}ms`);
      } catch (e) {
        step.verify = { success: false, ms: Date.now() - t0, error: e.message };
        step.aborted = 'verify failed';
        logEvent(`✗ step ${stepNum} verify FAILED in ${step.verify.ms}ms: ${e.message}`);
        writeRunLog();
        failed = true;
        if (stopOnFail) break;
        continue;
      }
      writeRunLog();
    }

    step.done = true;
    writeRunLog();
  }

  // Detach always; close tab only when runner-owned and succeeded. Caller-owned tabs
  // are never closed by the runner (their lifecycle belongs to the caller).
  runInFlight.currentPhase = 'teardown';
  writeRunLog();
  await sendCommand({ type: 'detach', tabId });
  if (!tabOwned) {
    logEvent(`tab ${tabId} left in place (owner=caller, success=${!failed})`);
  } else if (!failed) {
    await sendCommand({ type: 'close-tab', tabId });
    logEvent(`tab ${tabId} closed`);
  } else {
    logEvent(`tab ${tabId} left open for inspection`);
  }

  runInFlight.finishedAt = new Date().toISOString();
  runInFlight.success = !failed;
  runInFlight.currentPhase = 'finished';
  writeRunLog();
  logEvent(`■ run finished success=${!failed} (log: ${logFile})`);

  lastRunResult = { ...runInFlight };
  const finalSnapshot = { ...runInFlight };
  runInFlight = null;
  runLogFile = null;
  return finalSnapshot;
}

http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const body = req.method === 'POST' ? await readBody(req) : '';

  if (req.method === 'POST' && req.url === '/command') {
    if (runInFlight) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'run-scenario in flight; refusing /command to avoid corrupting the queue. Wait for run to finish or call GET /status.' }));
      return;
    }
    const result = await sendCommand(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/status')) {
    const tail = parseInt((new URL(req.url, 'http://x').searchParams.get('tail') || '20'), 10);
    const tailLines = eventRing.slice(-Math.max(0, Math.min(RING_LIMIT, tail)));
    const status = runInFlight
      ? {
          inFlight: true,
          startedAt: runInFlight.startedAt,
          scenarioPath: runInFlight.scenarioPath,
          tabId: runInFlight.tabId,
          currentStep: runInFlight.currentStep,
          currentPhase: runInFlight.currentPhase,
          stepsDone: runInFlight.steps.filter(s => s.done).length,
          totalStepsKnown: runInFlight.steps.length,
          currentCommand: currentCommand ? { _cmdId: currentCommand._cmdId, type: currentCommand.type, method: currentCommand.method, tabId: currentCommand.tabId, sentAt: currentCommandSentAt, ageMs: Date.now() - currentCommandSentAt } : null,
          logFile: runInFlight.logFile,
          recentEvents: tailLines,
        }
      : { inFlight: false, lastRunSuccess: lastRunResult ? lastRunResult.success : null, lastRunLogFile: lastRunResult ? lastRunResult.logFile : null, recentEvents: tailLines };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    return;
  }

  if (req.method === 'POST' && req.url === '/run-scenario') {
    const params = JSON.parse(body);
    if (!params.scenarioPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'scenarioPath is required' }));
      return;
    }
    try {
      const result = await runScenario(params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/last-run') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastRunResult || null));
    return;
  }

  if (req.method === 'GET' && req.url === '/next') {
    // Extension reconnected while a command was in flight — resend it.
    if (currentCommand && waitingForResult) {
      const briefMethod = currentCommand.type === 'cdp' ? `cdp ${currentCommand.method}` : currentCommand.type;
      logEvent(`↻ resend #${currentCommand._cmdId} ${briefMethod} (extension reconnected after ${Date.now() - currentCommandSentAt}ms)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(currentCommand));
      return;
    }
    if (queuedCommand) {
      const cmd = queuedCommand; queuedCommand = null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cmd));
    } else {
      const cmd = await Promise.race([
        new Promise(resolve => { waitingForCommand = resolve; }),
        new Promise(resolve => setTimeout(() => resolve(null), 30000)),
      ]);
      waitingForCommand = null;
      if (!cmd) { res.writeHead(204); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cmd));
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/done') {
    const result = JSON.parse(body);
    currentCommand = null;
    if (waitingForResult) { waitingForResult(result); waitingForResult = null; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }

  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log(`RPA CDP bridge v002 listening on :${PORT}`));

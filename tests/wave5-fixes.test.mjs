// pm/build/v.0.01/tests/wave5-fixes.test.mjs — regression tests for the three Wave-5 release-fix
// items surfaced by the architecture review and red/blue audit:
//   C1: background.js wires step-runner to the native bridge so runScenario actually has
//       a handler in the extension context.
//   C2: cancel-vs-openTab race in navigate.js no longer leaks an orphan tab.
//   C3: navigation that lands on /login throws loginRequired (PRD NFR-S3), not navigationBlocked.
//
// These tests do NOT require Chrome; they exercise the modules in Node by injecting fakes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import navigate from '../extension/lib/steps/navigate.js';
import { bindToChrome as bindStepRunner, createCtx } from '../extension/lib/step-runner.js';
import { makeCtx } from './_step-test-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const backgroundJsPath = path.join(repoRoot, 'extension/background.js');
const manifestJsonPath = path.join(repoRoot, 'extension/manifest.json');
const stepRunnerPath = path.join(repoRoot, 'extension/lib/step-runner.js');

// ─────────────────────────────────────────────────────────────────────────────
// C1: background.js wires the step-runner.
// We can't import background.js (it pulls chrome.* eagerly), so we read it as text and
// assert the wiring instructions are present. Then we exercise the runner's bindToChrome
// directly with a fake native bridge to prove the handlers it registers actually respond
// to the action names from pm/build/v.0.01/protocol.md §3.

test('C1: background.js imports step-runner.bindToChrome', () => {
  const src = readFileSync(backgroundJsPath, 'utf8');
  assert.match(
    src,
    /import\s*\{\s*bindToChrome\s+as\s+bindStepRunner\s*\}\s+from\s+['"]\.\/lib\/step-runner\.js['"]/,
    'background.js must import bindToChrome from step-runner.js',
  );
  assert.match(
    src,
    /bindStepRunner\s*\(\s*\{[\s\S]*?registry[\s\S]*?ownership[\s\S]*?budget[\s\S]*?getScenario[\s\S]*?nativeConnection[\s\S]*?\}\s*\)/,
    'background.js must call bindStepRunner with registry, ownership, budget, getScenario, nativeConnection',
  );
});

test('C1: background.js persists loadAll() scenarios into a getScenario() lookup', () => {
  const src = readFileSync(backgroundJsPath, 'utf8');
  assert.match(
    src,
    /function\s+getScenario\s*\(/,
    'background.js must define a getScenario(id) function',
  );
  assert.match(
    src,
    /result\.scenarios[\s\S]*?forEach[\s\S]*?scenarios\.set/,
    'background.js must populate scenarios from loadAll().scenarios',
  );
});

test('FR-R1 strict: getRunStatus without requestId yields badRequest reply', () => {
  /** @type {Map<string, (msg: object) => void>} */
  const handlers = new Map();
  /** @type {object[]} */
  const sent = [];
  const fakeNative = {
    send(m) {
      sent.push(m);
    },
    onMessage() {},
    onDisconnect() {},
    onAction(action, h) {
      handlers.set(action, h);
    },
    onEvent() {},
  };
  const runRec = {
    runId: 'r_x',
    status: 'running',
    currentStepIndex: 0,
    currentStepType: null,
    startedAt: 1,
  };
  const prevChrome = globalThis.chrome;
  globalThis.chrome = { runtime: {}, tabs: { onRemoved: { addListener() {} } } };
  try {
    bindStepRunner({
      registry: {
        get(id) {
          return id === 'r_x' ? runRec : undefined;
        },
        create() {
          return 'r_new';
        },
        setStatus() {},
        markCancelled() {},
        markError() {},
        markDone() {},
        setStep() {},
      },
      ownership: { claim() {}, release() {} },
      budget: { acquire() { return Promise.resolve({ release() {} }); } },
      getScenario: () => undefined,
      nativeConnection: fakeNative,
    });
    const h = handlers.get('getRunStatus');
    assert.ok(typeof h === 'function');
    h({ runId: 'r_x' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].ok, false);
    assert.equal(sent[0].error, 'badRequest');
  } finally {
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test('FR-R1 strict: getRunStatus with requestId but empty runId yields badRequest', () => {
  /** @type {Map<string, (msg: object) => void>} */
  const handlers = new Map();
  /** @type {object[]} */
  const sent = [];
  const fakeNative = {
    send(m) {
      sent.push(m);
    },
    onMessage() {},
    onDisconnect() {},
    onAction(action, h) {
      handlers.set(action, h);
    },
    onEvent() {},
  };
  const prevChrome = globalThis.chrome;
  globalThis.chrome = { runtime: {}, tabs: { onRemoved: { addListener() {} } } };
  try {
    bindStepRunner({
      registry: {
        get() {
          return undefined;
        },
        create() {
          return 'r_new';
        },
        setStatus() {},
        markCancelled() {},
        markError() {},
        markDone() {},
        setStep() {},
      },
      ownership: { claim() {}, release() {} },
      budget: { acquire() { return Promise.resolve({ release() {} }); } },
      getScenario: () => undefined,
      nativeConnection: fakeNative,
    });
    handlers.get('getRunStatus')({ requestId: 'q1', runId: '   ' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].error, 'badRequest');
    assert.match(sent[0].errorMessage, /runId is required/);
  } finally {
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
});

test('FR-T3: navigate forwards tabSlotTimeoutMs to budget.acquire', async () => {
  /** @type {object[]} */
  const acquireOpts = [];
  const b = makeCtx({
    budget: {
      async acquire(opts) {
        acquireOpts.push(opts);
        return { release() {} };
      },
    },
  });
  const ctx = createCtx({
    run: b.run,
    scenario: b.scenario,
    params: b.params,
    requestId: b.requestId,
    adapters: b.adapters,
  });
  ctx.chrome.tabs.group = (_opts, cb) => {
    cb(1);
  };
  ctx.chrome.tabGroups = {
    update(_gid, _props, cb) {
      cb && cb({});
    },
  };
  ctx.chrome.tabs.get = (id) =>
    Promise.resolve({ id, status: 'complete', url: 'https://example.com/path' });
  await navigate(
    ctx,
    { type: 'navigate', url: 'https://example.com/', tabSlotTimeoutMs: 12_345 },
    {},
  );
  assert.equal(acquireOpts.length, 1);
  assert.equal(acquireOpts[0].timeoutMs, 12_345);
});

test('C1: step-runner.bindToChrome registers all six protocol action handlers on the native bridge', () => {
  // Fake native connection that records every onAction registration.
  /** @type {string[]} */
  const registered = [];
  const fakeNative = {
    send() {},
    onMessage() {},
    onDisconnect() {},
    onAction(action, _h) {
      registered.push(action);
    },
    onEvent() {},
  };
  // Stub chrome so bindToChrome's `typeof chrome === 'undefined'` early-return doesn't fire.
  const prevChrome = globalThis.chrome;
  globalThis.chrome = { runtime: {} };
  try {
    bindStepRunner({
      registry: { create() {}, get() {}, setStatus() {}, markCancelled() {}, markError() {}, markDone() {}, setStep() {} },
      ownership: { claim() {}, release() {} },
      budget: { acquire() { return Promise.resolve({ release() {} }); } },
      getScenario: () => undefined,
      nativeConnection: fakeNative,
    });
  } finally {
    if (prevChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = prevChrome;
  }
  for (const a of ['runScenario', 'startRun', 'runStep', 'getRunStatus', 'cancelRun', 'endRun']) {
    assert.ok(registered.includes(a), 'expected handler for ' + a);
  }
});

test('runScenario native response forwards failure debug payloads', () => {
  const stepRunnerSrc = readFileSync(stepRunnerPath, 'utf8');
  assert.match(
    stepRunnerSrc,
    /if\s*\(\s*terminal\.debug\s*!=\s*null\s*\)\s*out\.debug\s*=\s*terminal\.debug/,
    'runScenarioResult failure envelope must include terminal.debug for Gate-3 diagnostics',
  );
  assert.match(
    stepRunnerSrc,
    /copyFailureFields\s*\(\s*out\s*,\s*terminal\s*\)/,
    'runScenarioResult failure envelope must preserve structured phase/snapshot fields',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Browser-UI-only tab marking: managed tabs are grouped in Chrome's tab strip; no page-
// visible marker is written to DOM/title/favicon/URL.

test('tab visual marker uses tabGroups permission and no page-visible data-bro-run-id marker', () => {
  const manifest = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
  assert.ok(manifest.permissions.includes('tabGroups'), 'manifest must request tabGroups permission');
  const stepRunnerSrc = readFileSync(stepRunnerPath, 'utf8');
  assert.ok(!stepRunnerSrc.includes('data-bro-run-id'), 'step-runner must not write page-visible DOM markers');
});

test('ctx.openTab groups the managed tab in browser UI when tabGroups API is available', async () => {
  const b = makeCtx();
  const grouped = [];
  const updatedGroups = [];
  b.chrome.tabs.group = (opts, cb) => {
    grouped.push(opts);
    cb(123);
  };
  b.chrome.tabGroups = {
    update(groupId, props, cb) {
      updatedGroups.push([groupId, props]);
      cb && cb({});
    },
  };
  const ctx = createCtx({
    run: b.run,
    scenario: b.scenario,
    params: b.params,
    requestId: b.requestId,
    adapters: b.adapters,
  });
  const opened = await ctx.openTab('https://example.com/path', { newTab: true });
  assert.equal(opened.tabId, 1);
  assert.deepEqual(grouped[0].tabIds, [1]);
  assert.equal(updatedGroups[0][0], 123);
  assert.equal(updatedGroups[0][1].color, 'red');
  assert.match(updatedGroups[0][1].title, /^Bro /);
});

// ─────────────────────────────────────────────────────────────────────────────
// C3: login redirect produces loginRequired, not navigationBlocked.

function makeNavCtxBase() {
  // Default tab snapshot (tests override by reassigning ctx._tabSnapshot or ctx.chrome.tabs.get).
  const ctx = {
    runId: 'r_test',
    requestId: 'rq_test',
    scenario: { matches: ['https://example.com/feed/*'] },
    matches: ['https://example.com/feed/*'],
    isUrlAllowed(u) {
      return /^https:\/\/example\.com\/feed\//.test(u);
    },
    cancelToken: new Promise(() => {}), // never resolves by default
    isCancelled: () => false,
    setTabId(t) {
      ctx.tabId = t;
    },
    tabId: null,
    closeTab: async () => {},
    _tabSnapshot: { status: 'complete', url: 'https://example.com/feed/' },
    chrome: {
      tabs: {
        // MV3 promise-returning style — navigate's waitForTabComplete awaits the call directly.
        get() {
          return Promise.resolve(ctx._tabSnapshot);
        },
        update() {
          return Promise.resolve({});
        },
        // navigate's orphan-cleanup path uses callback-style remove.
        remove(_tid, cb) {
          if (cb) cb();
        },
      },
      runtime: {},
    },
  };
  return ctx;
}

test('C3: navigate throws loginRequired when finalUrl is /login', async () => {
  const ctx = makeNavCtxBase();
  ctx.openTab = async () => ({ tabId: 7, release: () => {} });
  ctx._tabSnapshot = { status: 'complete', url: 'https://example.com/login' };
  await assert.rejects(
    navigate(ctx, { type: 'navigate', url: 'https://example.com/feed/' }, {}),
    (e) =>
      e &&
      e.code === 'loginRequired' &&
      typeof e.url === 'string' &&
      e.url.includes('/login'),
  );
});

test('C3: navigate throws loginRequired for /uas/login (LinkedIn-style nested login path)', async () => {
  const ctx = makeNavCtxBase();
  ctx.openTab = async () => ({ tabId: 7, release: () => {} });
  ctx._tabSnapshot = {
    status: 'complete',
    url: 'https://example.com/uas/login?session_redirect=%2Ffeed',
  };
  await assert.rejects(
    navigate(ctx, { type: 'navigate', url: 'https://example.com/feed/' }, {}),
    (e) => e && e.code === 'loginRequired',
  );
});

test('C3: navigate still throws navigationBlocked for non-login outside-matches drift', async () => {
  const ctx = makeNavCtxBase();
  ctx.openTab = async () => ({ tabId: 7, release: () => {} });
  ctx._tabSnapshot = { status: 'complete', url: 'https://example.com/somewhere-else/' };
  await assert.rejects(
    navigate(ctx, { type: 'navigate', url: 'https://example.com/feed/' }, {}),
    (e) => e && e.code === 'navigationBlocked',
  );
});

test('C3: navigate succeeds when finalUrl is in matches and not a login redirect', async () => {
  const ctx = makeNavCtxBase();
  ctx.openTab = async () => ({ tabId: 7, release: () => {} });
  ctx._tabSnapshot = { status: 'complete', url: 'https://example.com/feed/home' };
  const r = await navigate(ctx, { type: 'navigate', url: 'https://example.com/feed/' }, {});
  assert.equal(r.tabId, 7);
  assert.equal(r.finalUrl, 'https://example.com/feed/home');
});

// ─────────────────────────────────────────────────────────────────────────────
// C2: cancel-vs-openTab race no longer leaks an orphan tab.

test('C2: cancel mid-openTab schedules orphan cleanup once openTab eventually resolves', async () => {
  // Build a deferred openTab promise so we control when it settles.
  let resolveOpen;
  const openPromise = new Promise((res) => {
    resolveOpen = res;
  });
  let cancelResolve;
  const cancelToken = new Promise((res) => {
    cancelResolve = res;
  });
  const closedTabs = [];
  const releasedSlots = [];
  const ctx = {
    runId: 'r_test',
    requestId: 'rq',
    scenario: { matches: ['https://example.com/*'] },
    matches: ['https://example.com/*'],
    isUrlAllowed: (u) => u.startsWith('https://example.com/'),
    cancelToken,
    isCancelled: () => false,
    setTabId() {},
    tabId: null,
    closeTab: async (tid) => {
      closedTabs.push(tid);
    },
    openTab: () => openPromise,
    chrome: {
      tabs: {
        get() {
          return Promise.resolve({ status: 'complete', url: 'https://example.com/feed/' });
        },
        update() {
          return Promise.resolve({});
        },
        remove(_t, cb) {
          if (cb) cb();
        },
      },
      runtime: {},
    },
  };
  // Start navigate; it will await the cancel-vs-openTab race.
  const navPromise = navigate(ctx, { type: 'navigate', url: 'https://example.com/page' }, {});
  // Cancel before openTab resolves.
  await new Promise((r) => setImmediate(r));
  cancelResolve({ cancelled: true });
  // navigate should reject with cancelled.
  await assert.rejects(navPromise, (e) => e && e.code === 'cancelled');
  // Now resolve the openTab — the orphan tab arrives AFTER navigate has already thrown.
  resolveOpen({
    tabId: 42,
    release: () => {
      releasedSlots.push(42);
    },
  });
  // Give the scheduled cleanup a tick to run.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // Without the C2 fix, neither closeTab nor release would run for tabId=42.
  assert.deepStrictEqual(releasedSlots, [42], 'orphan tab slot must be released');
  assert.deepStrictEqual(closedTabs, [42], 'orphan tab must be closed');
});

test('C2: when cancel does NOT fire and openTab succeeds, no orphan-cleanup runs', async () => {
  const ctx = makeNavCtxBase();
  let cleanupCalls = 0;
  const _origRemove = ctx.chrome.tabs.remove;
  ctx.chrome.tabs.remove = (_t, cb) => {
    cleanupCalls++;
    if (cb) cb();
  };
  ctx.openTab = async () => ({ tabId: 7, release: () => {} });
  ctx.closeTab = async () => {
    cleanupCalls++;
  };
  void _origRemove;
  const r = await navigate(ctx, { type: 'navigate', url: 'https://example.com/feed/' }, {});
  assert.equal(r.tabId, 7);
  // No orphan cleanup runs because cancel never fired.
  assert.equal(cleanupCalls, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCtx,
  executeRun,
  executeStep,
  matchesAllowed,
  cancelRun,
} from '../extension/lib/step-runner.js';
import { makeCtx, makeFakeChrome } from './_step-test-utils.mjs';

/** Replaces the navigate step: claim tab 1 so subsequent steps see an allowed URL (fake chrome). */
const fakeNavigate = async (ctx) => { ctx.setTabId(1); };

test('sequential execution: 3 steps run in order A, B, C', async () => {
  const order = [];
  const b = makeCtx();
  const steps = {
    navigate: fakeNavigate,
    w: async () => { order.push('A'); return 'a'; },
    x: async () => { order.push('B'); return 'b'; },
    y: async () => { order.push('C'); return 'c'; },
  };
  const terminal = await executeRun({
    scenario: {
      id: 't',
      steps: [
        { type: 'navigate', url: 'https://example.com/' },
        { type: 'w' },
        { type: 'x' },
        { type: 'y' },
      ],
      matches: ['https://example.com/*'],
    },
    requestId: 'r1',
    params: {},
    adapters: { ...b.adapters, steps },
  });
  assert.equal(terminal.ok, true);
  assert.deepEqual(order, ['A', 'B', 'C']);
});

test('per-step result accumulation: appendPartial 3x across 3 steps', async () => {
  const b = makeCtx();
  const steps = {
    navigate: fakeNavigate,
    p0: async (ctx) => { ctx.appendPartial({ foo: 0 }); return 0; },
    p1: async (ctx) => { ctx.appendPartial({ foo: 1 }); return 1; },
    p2: async (ctx) => { ctx.appendPartial({ foo: 2 }); return 2; },
  };
  const terminal = await executeRun({
    scenario: {
      id: 't',
      steps: [
        { type: 'navigate', url: 'https://example.com/' },
        { type: 'p0' },
        { type: 'p1' },
        { type: 'p2' },
      ],
      matches: ['https://example.com/*'],
    },
    requestId: 'r1',
    params: {},
    adapters: { ...b.adapters, steps },
  });
  assert.equal(terminal.ok, true);
  assert.ok(Array.isArray(terminal.data));
  assert.deepEqual(terminal.data, [{ foo: 0 }, { foo: 1 }, { foo: 2 }]);
});

test('failure mid-run: step 2 throws selectorTimeout, partial from step1', async () => {
  const b = makeCtx();
  const steps = {
    navigate: fakeNavigate,
    ok1: async (ctx) => {
      ctx.appendPartial('one');
      return 'first';
    },
    fail: async () => {
      throw { code: 'selectorTimeout', message: 'nope', selector: '.x' };
    },
    ok3: async () => 'should-not',
  };
  const terminal = await executeRun({
    scenario: {
      id: 't',
      steps: [
        { type: 'navigate', url: 'https://example.com/' },
        { type: 'ok1' },
        { type: 'fail' },
        { type: 'ok3' },
      ],
      matches: ['https://example.com/*'],
    },
    requestId: 'r1',
    params: {},
    adapters: { ...b.adapters, steps },
  });
  assert.equal(terminal.ok, false);
  assert.equal(terminal.error, 'selectorTimeout');
  assert.deepEqual(terminal.partial, ['one']);
});

test('Error instance: terminal internal + errorMessage', async () => {
  const b = makeCtx();
  const steps = { navigate: fakeNavigate, boom: async () => { throw new Error('boom'); } };
  const terminal = await executeRun({
    scenario: { id: 't', steps: [{ type: 'navigate', url: 'https://example.com/' }, { type: 'boom' }], matches: ['https://example.com/*'] },
    requestId: 'r1',
    params: {},
    adapters: { ...b.adapters, steps },
  });
  assert.equal(terminal.ok, false);
  assert.equal(terminal.error, 'internal');
  assert.equal(terminal.errorMessage, 'boom');
});

test('cancellation between steps: cancel after step1', async () => {
  const b = makeCtx();
  const runId = b.run.runId;
  const steps = {
    navigate: fakeNavigate,
    s1: async (ctx) => {
      ctx.appendPartial({ s: 1 });
      cancelRun(ctx.runId);
      return 1;
    },
    s2: async () => 2,
  };
  const terminal = await executeRun({
    run: b.run,
    scenario: {
      id: 't',
      steps: [
        { type: 'navigate', url: 'https://example.com/' },
        { type: 's1' },
        { type: 's2' },
      ],
      matches: ['https://example.com/*'],
    },
    requestId: b.requestId,
    params: {},
    adapters: { ...b.adapters, steps },
  });
  assert.equal(terminal.ok, false);
  assert.equal(terminal.error, 'cancelled');
  assert.ok(Array.isArray(terminal.partial));
  assert.equal(terminal.partial.length, 1);
});

test('cancellation mid-step: long sleep vs cancel', async () => {
  const b = makeCtx();
  const runId = b.run.runId;
  const steps = {
    navigate: fakeNavigate,
    long: async (ctx) => {
      const slow = new Promise((r) => setTimeout(r, 60_000));
      return Promise.race([
        slow,
        ctx.cancelToken.then(() => { throw { code: 'cancelled', message: 'c' }; }),
      ]);
    },
  };
  const p = executeRun({
    run: b.run,
    scenario: {
      id: 't',
      steps: [
        { type: 'navigate', url: 'https://example.com/' },
        { type: 'long' },
      ],
      matches: ['https://example.com/*'],
    },
    requestId: b.requestId,
    params: {},
    adapters: { ...b.adapters, steps },
  });
  setTimeout(() => { cancelRun(runId); }, 5);
  const terminal = await p;
  assert.equal(terminal.ok, false);
  assert.equal(terminal.error, 'cancelled');
});

test('per-run isolation: one fails selectorTimeout, other succeeds, no cross-contamination', async () => {
  const r1 = makeCtx();
  const r2 = makeCtx();
  const steps1 = { navigate: fakeNavigate, a: async () => 1, b: async () => { throw { code: 'selectorTimeout', message: 'x' }; } };
  const steps2 = { navigate: fakeNavigate, a: async () => 10, b: async () => 20 };
  const p1 = executeRun({
    run: r1.run,
    scenario: {
      id: 't1',
      steps: [{ type: 'navigate', url: 'https://example.com/' }, { type: 'a' }, { type: 'b' }],
      matches: ['https://example.com/*'],
    },
    requestId: r1.requestId,
    params: {},
    adapters: { ...r1.adapters, steps: steps1 },
  });
  const p2 = executeRun({
    run: r2.run,
    scenario: {
      id: 't2',
      steps: [{ type: 'navigate', url: 'https://example.com/' }, { type: 'a' }, { type: 'b' }],
      matches: ['https://example.com/*'],
    },
    requestId: r2.requestId,
    params: {},
    adapters: { ...r2.adapters, steps: steps2 },
  });
  const [t1, t2] = await Promise.all([p1, p2]);
  assert.equal(t1.ok, false);
  assert.equal(t1.error, 'selectorTimeout');
  assert.equal(t2.ok, true);
  assert.equal(t2.data, 20);
});

test('matchesRefused: non-navigate step, tab URL outside matches', async () => {
  const ch = makeFakeChrome();
  ch.tabs.get = (id, cb) => { setTimeout(() => cb({ id, url: 'https://other.example.net/bad' }), 0); };
  const b = makeCtx({ chrome: ch });
  const ctx = createCtx({
    run: b.run,
    scenario: { id: 't', matches: ['https://example.com/*'], steps: [] },
    params: {},
    requestId: 'x',
    adapters: b.adapters,
  });
  ctx.setTabId(1);
  ctx._adapters = { ...b.adapters, steps: { x: async () => 'n' } };
  const r = await executeStep(ctx, { type: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'matchesRefused');
});

test('unknown step type: internal and message', async () => {
  const b = makeCtx();
  const ctx = createCtx({
    run: b.run,
    scenario: b.scenario,
    params: b.params,
    requestId: 'x',
    adapters: b.adapters,
  });
  const r = await executeStep(ctx, { type: '_nope_' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'internal');
  assert.match(r.errorMessage, /unknown step type/);
});

test('matchesAllowed: parameterised', async (t) => {
  for (const [url, patterns, want] of [
    ['https://a.com/p', ['*'], true],
    ['https://a.com/p?q=1', ['https://a.com/p'], true],
    ['http://a.com/p', ['https://a.com/p'], false],
    ['https://a.com/x', ['https://a.com/*'], true],
    ['http://127.0.0.1:8766/', ['http://127.0.0.1/*'], true],
    ['http://localhost:8766/', ['http://localhost/*'], true],
  ]) {
    await t.test(`${url} / ${JSON.stringify(patterns)} -> ${want}`, () => {
      assert.equal(matchesAllowed(url, patterns), want);
    });
  }
});

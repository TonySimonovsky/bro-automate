import assert from 'node:assert/strict';
import test from 'node:test';

import extract from '../extension/lib/steps/extract.js';
import scroll from '../extension/lib/steps/scroll.js';
import waitForSelector from '../extension/lib/steps/wait-for-selector.js';
import waitForState from '../extension/lib/steps/wait-for-state.js';
import waitForText from '../extension/lib/steps/wait-for-text.js';

/** @param {Record<string, unknown>} overrides */
function baseCtx(overrides = {}) {
  const partial = [];
  const never = new Promise(() => {});
  return {
    tabId: 7,
    runId: 'r_test',
    requestId: 'req_test',
    scenarioId: 'demo',
    scenario: {
      schemaVersion: '1',
      id: 'demo',
      name: 'Demo',
      matches: ['https://example.com/*'],
      module: 'scenario.js',
      steps: [],
    },
    params: {},
    cancelToken: never,
    isCancelled: () => false,
    appendPartial: (v) => {
      partial.push(v);
    },
    getPartial: () => partial,
    partial,
    injectMain: async () => {
      throw new Error('injectMain not stubbed');
    },
    ...overrides,
  };
}

test('waitForSelector: happy path', async () => {
  const ctx = baseCtx({
    injectMain: async () => ({ found: true }),
  });
  const out = await waitForSelector(
    ctx,
    { type: 'waitForSelector', selector: '.x' },
    {},
  );
  assert.deepEqual(out, { found: true, selector: '.x' });
});

test('waitForSelector: timeout from injectMain', async () => {
  const ctx = baseCtx({
    injectMain: async () => {
      throw {
        code: 'selectorTimeout',
        message: 'Timed out waiting for selector .x (5000ms)',
        selector: '.x',
        timeoutMs: 5000,
      };
    },
  });
  await assert.rejects(
    waitForSelector(ctx, { type: 'waitForSelector', selector: '.x' }, {}),
    (e) => e.code === 'selectorTimeout',
  );
});

test('waitForSelector: cancelled', async () => {
  let resolveCancel;
  const cancelToken = new Promise((r) => {
    resolveCancel = r;
  });
  const ctx = baseCtx({
    cancelToken,
    injectMain: () => new Promise(() => {}),
  });
  const p = waitForSelector(ctx, { type: 'waitForSelector', selector: '.x' }, {});
  queueMicrotask(() => resolveCancel({ cancelled: true }));
  await assert.rejects(p, (e) => e.code === 'cancelled');
});

test('waitForSelector: tab required', async () => {
  const ctx = baseCtx({ tabId: null, injectMain: async () => ({}) });
  await assert.rejects(
    waitForSelector(ctx, { type: 'waitForSelector', selector: '.x' }, {}),
    (e) => e.code === 'internal' && e.message.includes('tab'),
  );
});

test('waitForText: happy path', async () => {
  const ctx = baseCtx({
    injectMain: async () => ({ found: true }),
  });
  const out = await waitForText(
    ctx,
    { type: 'waitForText', text: 'hello' },
    {},
  );
  assert.deepEqual(out, { found: true, text: 'hello' });
});

test('waitForText: timeout', async () => {
  const ctx = baseCtx({
    injectMain: async () => {
      throw {
        code: 'selectorTimeout',
        message: 'Timed out waiting for text (100ms)',
        text: 'nope',
        timeoutMs: 100,
      };
    },
  });
  await assert.rejects(
    waitForText(ctx, { type: 'waitForText', text: 'nope' }, {}),
    (e) => e.code === 'selectorTimeout',
  );
});

test('waitForText: cancelled', async () => {
  let resolveCancel;
  const cancelToken = new Promise((r) => {
    resolveCancel = r;
  });
  const ctx = baseCtx({
    cancelToken,
    injectMain: () => new Promise(() => {}),
  });
  const p = waitForText(ctx, { type: 'waitForText', text: 'a' }, {});
  queueMicrotask(() => resolveCancel({ cancelled: true }));
  await assert.rejects(p, (e) => e.code === 'cancelled');
});

test('waitForText: tab required', async () => {
  const ctx = baseCtx({ tabId: null });
  await assert.rejects(
    waitForText(ctx, { type: 'waitForText', text: 'a' }, {}),
    (e) => e.code === 'internal',
  );
});

test('waitForState: scenario without module', async () => {
  const ctx = baseCtx({
    scenario: {
      schemaVersion: '1',
      id: 'demo',
      name: 'Demo',
      matches: ['*'],
      steps: [],
    },
  });
  await assert.rejects(
    waitForState(ctx, { type: 'waitForState', fn: 'ready' }, {}),
    (e) =>
      e.code === 'internal' && e.message.includes('scenario.module'),
  );
});

test('waitForState: happy path', async () => {
  let phase = 0;
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => {
      if (target.files) {
        phase = 1;
        return undefined;
      }
      assert.equal(phase, 1);
      return true;
    },
  });
  const out = await waitForState(
    ctx,
    { type: 'waitForState', fn: 'isReady', args: { k: 1 } },
    {},
  );
  assert.deepEqual(out, { done: true, fn: 'isReady' });
});

test('waitForState: timeout when predicate stays false', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => {
      if (target.files) {
        return undefined;
      }
      return false;
    },
  });
  await assert.rejects(
    waitForState(
      ctx,
      { type: 'waitForState', fn: 'nope', timeoutMs: 5 },
      {},
    ),
    (e) => e.code === 'selectorTimeout' && e.fn === 'nope',
  );
});

test('waitForState: cancelled during poll', async () => {
  let resolveCancel;
  const cancelToken = new Promise((r) => {
    resolveCancel = r;
  });
  let filesDone = false;
  const ctx = baseCtx({
    cancelToken,
    injectMain: async (_tabId, target) => {
      if (target.files) {
        filesDone = true;
        return undefined;
      }
      assert.ok(filesDone);
      return false;
    },
  });
  const p = waitForState(
    ctx,
    { type: 'waitForState', fn: 'x', timeoutMs: 60_000 },
    {},
  );
  queueMicrotask(() => resolveCancel({ cancelled: true }));
  await assert.rejects(p, (e) => e.code === 'cancelled');
});

test('waitForState: tab required', async () => {
  const ctx = baseCtx({ tabId: null });
  await assert.rejects(
    waitForState(ctx, { type: 'waitForState', fn: 'x' }, {}),
    (e) => e.code === 'internal' && e.message.includes('tab'),
  );
});

test('extract: happy path and appendPartial', async () => {
  const ctx = baseCtx({
    injectMain: async () => ({ title: 'Hello' }),
  });
  const out = await extract(
    ctx,
    {
      type: 'extract',
      fields: [{ name: 'title', selector: 'h1' }],
    },
    {},
  );
  assert.deepEqual(out, { title: 'Hello' });
  assert.deepEqual(ctx.getPartial(), [{ title: 'Hello' }]);
});

test('extract: timeout', async () => {
  const ctx = baseCtx({
    injectMain: () => new Promise(() => {}),
  });
  await assert.rejects(
    extract(
      ctx,
      {
        type: 'extract',
        fields: [{ name: 'a', selector: 'x' }],
        timeoutMs: 20,
      },
      {},
    ),
    (e) => e.code === 'selectorTimeout',
  );
});

test('extract: cancelled', async () => {
  let resolveCancel;
  const cancelToken = new Promise((r) => {
    resolveCancel = r;
  });
  const ctx = baseCtx({
    cancelToken,
    injectMain: () => new Promise(() => {}),
  });
  const p = extract(
    ctx,
    { type: 'extract', fields: [{ name: 'a', selector: 'x' }] },
    {},
  );
  queueMicrotask(() => resolveCancel({ cancelled: true }));
  await assert.rejects(p, (e) => e.code === 'cancelled');
});

test('extract: tab required', async () => {
  const ctx = baseCtx({ tabId: null });
  await assert.rejects(
    extract(ctx, { type: 'extract', fields: [{ name: 'a', selector: 'x' }] }, {}),
    (e) => e.code === 'internal',
  );
});

test('extract: multiple:true returns array from injectMain', async () => {
  const ctx = baseCtx({
    injectMain: async () => [
      { a: '1', b: null },
      { a: '2', b: null },
    ],
  });
  const out = await extract(
    ctx,
    {
      type: 'extract',
      selector: '.row',
      multiple: true,
      fields: [
        { name: 'a', selector: '.a' },
        { name: 'b', selector: '.missing' },
      ],
    },
    {},
  );
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2);
});

test('extract: attr href via injectMain result', async () => {
  const ctx = baseCtx({
    injectMain: async () => ({ link: 'https://example.com/p' }),
  });
  const out = await extract(
    ctx,
    {
      type: 'extract',
      fields: [{ name: 'link', selector: 'a', attr: 'href' }],
    },
    {},
  );
  assert.equal(out.link, 'https://example.com/p');
});

test('extract: multiple:true without selector propagates throw from injected func', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => {
      if (typeof target.func === 'function') {
        return target.func(...(target.args ?? []));
      }
    },
  });
  await assert.rejects(
    extract(
      ctx,
      {
        type: 'extract',
        multiple: true,
        fields: [{ name: 'a', selector: 'x' }],
      },
      {},
    ),
    (e) =>
      e.code === 'internal' &&
      e.message.includes('multiple:true requires a rootSelector'),
  );
});

test('scroll: happy path', async () => {
  const ctx = baseCtx({
    injectMain: async () => ({ scrolled: true }),
  });
  const out = await scroll(ctx, { type: 'scroll', deltaY: 10 }, {});
  assert.deepEqual(out, { scrolled: true });
});

test('scroll: timeout', async () => {
  const ctx = baseCtx({
    injectMain: () => new Promise(() => {}),
  });
  await assert.rejects(
    scroll(ctx, { type: 'scroll', deltaY: 1, timeoutMs: 15 }, {}),
    (e) => e.code === 'selectorTimeout',
  );
});

test('scroll: cancelled', async () => {
  let resolveCancel;
  const cancelToken = new Promise((r) => {
    resolveCancel = r;
  });
  const ctx = baseCtx({
    cancelToken,
    injectMain: () => new Promise(() => {}),
  });
  const p = scroll(ctx, { type: 'scroll' }, {});
  queueMicrotask(() => resolveCancel({ cancelled: true }));
  await assert.rejects(p, (e) => e.code === 'cancelled');
});

test('scroll: tab required', async () => {
  const ctx = baseCtx({ tabId: null });
  await assert.rejects(
    scroll(ctx, { type: 'scroll' }, {}),
    (e) => e.code === 'internal',
  );
});

test('scroll: intoView + selector passes args to injectMain', async () => {
  let captured = null;
  const ctx = baseCtx({
    injectMain: async (tabId, target) => {
      captured = { tabId, target };
      return { scrolled: true };
    },
  });
  await scroll(
    ctx,
    { type: 'scroll', selector: '#pane', intoView: true, deltaY: 5 },
    {},
  );
  assert.equal(captured.tabId, 7);
  assert.equal(typeof captured.target.func, 'function');
  assert.deepEqual(captured.target.args, ['#pane', true, undefined, 5]);
});

test('scroll: deltaY window scroll args', async () => {
  let captured = null;
  const ctx = baseCtx({
    injectMain: async (tabId, target) => {
      captured = { tabId, target };
      return { scrolled: true };
    },
  });
  await scroll(ctx, { type: 'scroll', deltaY: 100 }, {});
  assert.deepEqual(captured.target.args, [undefined, undefined, undefined, 100]);
});

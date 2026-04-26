import { test } from 'node:test';
import assert from 'node:assert/strict';
import runNavigate from '../extension/lib/steps/navigate.js';
import runSleep from '../extension/lib/steps/sleep.js';
import runScreenshot from '../extension/lib/steps/screenshot.js';

// Single shared non-settling token so cancel never wins in “no cancel” tests.
const neverCancel = new Promise(() => {});

test('navigate: happy path — openTab, setTabId, finalUrl', async () => {
  const calls = { openTab: [], set: [] };
  const ctx = {
    tabId: null,
    setTabId(id) {
      this.tabId = id;
    },
    isUrlAllowed(url) {
      return url.startsWith('https://allowed.test/');
    },
    openTab(url, opts) {
      calls.openTab.push([url, opts]);
      return Promise.resolve({ tabId: 42, release: () => {} });
    },
    chrome: {
      tabs: {
        get: async (id) => {
          assert.equal(id, 42);
          return { id, status: 'complete', url: 'https://allowed.test/ok' };
        },
        update: async () => {
          assert.fail('tabs.update should not be used in newTab path');
        },
      },
    },
    cancelToken: neverCancel,
  };
  const step = { type: 'navigate', url: 'https://allowed.test/start' };
  const out = await runNavigate(ctx, step, {});
  assert.deepEqual(calls.openTab, [['https://allowed.test/start', { newTab: true }]]);
  assert.equal(ctx.tabId, 42);
  assert.deepEqual(out, { tabId: 42, finalUrl: 'https://allowed.test/ok' });
});

test('navigate: navigationBlocked when step.url outside matches', async () => {
  const ctx = {
    tabId: null,
    setTabId() {
      assert.fail();
    },
    isUrlAllowed() {
      return false;
    },
    openTab: async () => ({ tabId: 1, release: () => {} }),
    chrome: { tabs: { get: async () => ({ id: 1, status: 'complete', url: 'x' }) } },
    cancelToken: neverCancel,
  };
  await assert.rejects(
    runNavigate(ctx, { type: 'navigate', url: 'https://evil/' }, {}),
    (e) => e.code === 'navigationBlocked' && e.url === 'https://evil/',
  );
});

test('navigate: tabSlotTimeout from openTab', async () => {
  const ctx = {
    tabId: null,
    setTabId() {
      assert.fail();
    },
    isUrlAllowed: () => true,
    openTab: async () => {
      throw { code: 'tabSlotTimeout', message: 'no slot' };
    },
    chrome: { tabs: { get: async () => ({ id: 1, status: 'complete' }) } },
    cancelToken: neverCancel,
  };
  await assert.rejects(
    runNavigate(ctx, { type: 'navigate', url: 'https://allowed.test/a' }, {}),
    (e) => e.code === 'tabSlotTimeout' && e.message === 'no slot',
  );
});

test('navigate: tabClosedDuringStep when tabs.get throws', async () => {
  const ctx = {
    tabId: null,
    setTabId() {},
    isUrlAllowed: () => true,
    openTab: async () => ({ tabId: 99, release: () => {} }),
    chrome: {
      tabs: {
        get: async () => {
          throw new Error('No tab with id: 99');
        },
      },
    },
    cancelToken: neverCancel,
  };
  await assert.rejects(
    runNavigate(ctx, { type: 'navigate', url: 'https://allowed.test/a' }, {}),
    (e) => e.code === 'tabClosedDuringStep',
  );
});

test('navigate: newTab:false without tab is internal', async () => {
  const ctx = {
    tabId: null,
    setTabId: () => assert.fail(),
    isUrlAllowed: () => true,
    openTab: async () => assert.fail(),
    chrome: { tabs: { get: async () => assert.fail() } },
    cancelToken: neverCancel,
  };
  await assert.rejects(
    runNavigate(ctx, { type: 'navigate', url: 'https://allowed.test/a', newTab: false }, {}),
    (e) => e.code === 'internal' && /existing tab/.test(e.message),
  );
});

test('navigate: cancel during openTab', async () => {
  const quicklyCancelled = Promise.resolve({ cancelled: true });
  const ctx = {
    tabId: null,
    setTabId: () => assert.fail(),
    isUrlAllowed: () => true,
    openTab: () =>
      new Promise((resolve) => {
        setImmediate(() => resolve({ tabId: 1, release: () => {} }));
      }),
    chrome: { tabs: { get: async () => assert.fail() } },
    cancelToken: quicklyCancelled,
  };
  await assert.rejects(
    runNavigate(ctx, { type: 'navigate', url: 'https://allowed.test/a' }, {}),
    (e) => e.code === 'cancelled' && /navigate/.test(e.message),
  );
});

test('navigate: final URL outside matches after load', async () => {
  const ctx = {
    tabId: null,
    setTabId() {},
    isUrlAllowed(url) {
      return !url.includes('badsite');
    },
    openTab: async () => ({ tabId: 1, release: () => {} }),
    chrome: {
      tabs: {
        get: async (id) => ({ id, status: 'complete', url: 'https://badsite.com/redirect' }),
      },
    },
    cancelToken: neverCancel,
  };
  try {
    await runNavigate(
      ctx,
      { type: 'navigate', url: 'https://good.test/entry' },
      {},
    );
    assert.fail();
  } catch (e) {
    assert.equal(e.code, 'navigationBlocked');
    assert.equal(e.url, 'https://badsite.com/redirect');
  }
});

test('navigate: newTab:false uses tabs.update and waits for complete', async () => {
  const updated = [];
  const ctx = {
    tabId: 5,
    setTabId: () => assert.fail('setTabId should not be required'),
    isUrlAllowed: (url) => url.startsWith('https://allowed.test/'),
    openTab: async () => assert.fail(),
    chrome: {
      tabs: {
        update: async (id, props) => {
          updated.push([id, props]);
        },
        get: async (id) => {
          assert.equal(id, 5);
          return { id, status: 'complete', url: 'https://allowed.test/after' };
        },
      },
    },
    cancelToken: neverCancel,
  };
  const out = await runNavigate(
    ctx,
    { type: 'navigate', url: 'https://allowed.test/after', newTab: false },
    {},
  );
  assert.deepEqual(updated, [[5, { url: 'https://allowed.test/after' }]]);
  assert.deepEqual(out, { tabId: 5, finalUrl: 'https://allowed.test/after' });
});

test('sleep: sleeps requested ms and returns slept', async () => {
  const t0 = Date.now();
  const ctx = { cancelToken: neverCancel };
  const out = await runSleep(ctx, { type: 'sleep', ms: 10 }, {});
  const dt = Date.now() - t0;
  assert.equal(out.slept, 10);
  assert.ok(dt >= 8, 'should wait roughly 10ms');
});

test('sleep: cancel during sleep', async () => {
  const ctx = { cancelToken: Promise.resolve({ cancelled: true }) };
  await assert.rejects(
    runSleep(ctx, { type: 'sleep', ms: 10_000 }, {}),
    (e) => e.code === 'cancelled' && e.message === 'cancelled during sleep',
  );
});

test('sleep: ms=0 returns immediately', async () => {
  const t0 = Date.now();
  const out = await runSleep({ cancelToken: neverCancel }, { type: 'sleep', ms: 0 }, {});
  assert.ok(Date.now() - t0 < 5);
  assert.deepEqual(out, { slept: 0 });
});

test('screenshot: happy path — png dataUrl from captureVisibleTab', async () => {
  const dataUrl = 'data:image/png;base64,QUJD';
  const ctx = {
    tabId: 1,
    chrome: {
      tabs: {
        get: async (id) => {
          assert.equal(id, 1);
          return { id: 1, windowId: 100, url: 'https://example.com' };
        },
        captureVisibleTab: async (windowId, opts) => {
          assert.equal(windowId, 100);
          assert.equal(opts.format, 'png');
          return dataUrl;
        },
      },
    },
    cancelToken: neverCancel,
  };
  const out = await runScreenshot(ctx, { type: 'screenshot' }, {});
  assert.deepEqual(out, { format: 'png', dataUrl });
});

test('screenshot: requires tab', async () => {
  const ctx = {
    tabId: null,
    chrome: {
      tabs: { get: async () => assert.fail(), captureVisibleTab: async () => assert.fail() },
    },
    cancelToken: neverCancel,
  };
  await assert.rejects(
    runScreenshot(ctx, { type: 'screenshot' }, {}),
    (e) => e.code === 'internal' && e.message === 'screenshot requires a tab',
  );
});

test('screenshot: selector adds note, still succeeds', async () => {
  const dataUrl = 'data:image/png;base64,AA';
  const ctx = {
    tabId: 2,
    chrome: {
      tabs: {
        get: async () => ({ id: 2, windowId: 2, url: 'https://a.com' }),
        captureVisibleTab: async () => dataUrl,
      },
    },
    cancelToken: neverCancel,
  };
  const out = await runScreenshot(
    ctx,
    { type: 'screenshot', selector: '#x' },
    {},
  );
  assert.equal(out.note, 'element-bounds capture not implemented in v0.01');
  assert.equal(out.dataUrl, dataUrl);
});

test('screenshot: tabClosedDuringStep when tabs.get throws', async () => {
  const ctx = {
    tabId: 3,
    chrome: {
      tabs: {
        get: async () => {
          throw new Error('gone');
        },
        captureVisibleTab: async () => assert.fail(),
      },
    },
    cancelToken: neverCancel,
  };
  await assert.rejects(
    runScreenshot(ctx, { type: 'screenshot' }, {}),
    (e) => e.code === 'tabClosedDuringStep',
  );
});

test('screenshot: cancel mid-capture', async () => {
  const ctx = {
    tabId: 1,
    chrome: {
      tabs: {
        get: async () => ({ id: 1, windowId: 1, url: 'https://a.com' }),
        captureVisibleTab: () =>
          new Promise((resolve) => {
            setImmediate(() => resolve('data:image/png;base64,AA'));
          }),
      },
    },
    cancelToken: Promise.resolve({ cancelled: true }),
  };
  await assert.rejects(
    runScreenshot(ctx, { type: 'screenshot' }, {}),
    (e) => e.code === 'cancelled' && e.message === 'cancelled during screenshot',
  );
});

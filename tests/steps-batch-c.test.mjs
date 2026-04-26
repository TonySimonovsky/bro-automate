import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const stepsUrl = new URL('extension/lib/steps/', root.href);

const runClick = (await import(pathToFileURL(new URL('click.js', stepsUrl).pathname).href)).default;
const runClickByCoordinates = (
  await import(pathToFileURL(new URL('click-by-coordinates.js', stepsUrl).pathname).href)
).default;
const runType = (await import(pathToFileURL(new URL('type.js', stepsUrl).pathname).href)).default;
const runSetContenteditable = (
  await import(pathToFileURL(new URL('set-contenteditable.js', stepsUrl).pathname).href)
).default;
const runEvaluate = (await import(pathToFileURL(new URL('evaluate.js', stepsUrl).pathname).href)).default;

/** @param {Record<string, unknown>} overrides */
function baseCtx(overrides = {}) {
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
    injectMain: async () => {
      throw new Error('injectMain not stubbed');
    },
    ...overrides,
  };
}

function ensureInputEvent() {
  if (typeof globalThis.InputEvent !== 'undefined') return () => {};
  const Prev = globalThis.InputEvent;
  globalThis.InputEvent = class InputEvent extends Event {
    /**
     * @param {string} type
     * @param {{ bubbles?: boolean, inputType?: string }} [init]
     */
    constructor(type, init) {
      super(type, init);
      this.inputType = init?.inputType;
    }
  };
  return () => {
    if (Prev === undefined) delete globalThis.InputEvent;
    else globalThis.InputEvent = Prev;
  };
}

test('click: by selector happy path', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  globalThis.document = {
    querySelector(sel) {
      assert.equal(sel, '#go');
      return { click() {}, offsetParent: {} };
    },
  };
  try {
    const out = await runClick(ctx, { type: 'click', selector: '#go' }, {});
    assert.deepEqual(out, { clicked: true, by: 'selector' });
  } finally {
    delete globalThis.document;
  }
});

test('click: by text happy path', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  const btn = {
    textContent: '  Schedule post  ',
    offsetParent: {},
    clicked: false,
    click() {
      this.clicked = true;
    },
  };
  globalThis.document = {
    querySelector() {
      assert.fail('selector branch should not run');
    },
    querySelectorAll() {
      return [btn];
    },
  };
  try {
    const out = await runClick(ctx, { type: 'click', text: 'Schedule post' }, {});
    assert.equal(btn.clicked, true);
    assert.deepEqual(out, { clicked: true, by: 'text' });
  } finally {
    delete globalThis.document;
  }
});

test('click: neither selector nor text → internal', async () => {
  const ctx = baseCtx({ injectMain: async () => assert.fail('no inject') });
  await assert.rejects(
    runClick(ctx, { type: 'click' }, {}),
    (e) => e.code === 'internal' && e.message === 'click requires selector or text',
  );
});

test('click: selector not found → selectorTimeout', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  globalThis.document = {
    querySelector() {
      return null;
    },
  };
  try {
    await assert.rejects(
      runClick(ctx, { type: 'click', selector: '.missing', timeoutMs: 30 }, {}),
      (e) =>
        e.code === 'selectorTimeout' &&
        e.message === 'click target not found within 30ms',
    );
  } finally {
    delete globalThis.document;
  }
});

test('click: tab missing → internal', async () => {
  const ctx = baseCtx({ tabId: null, injectMain: async () => ({}) });
  await assert.rejects(
    runClick(ctx, { type: 'click', selector: 'a' }, {}),
    (e) => e.code === 'internal' && /tab/.test(e.message),
  );
});

test('clickByCoordinates: happy path', async () => {
  const ctx = baseCtx({
    injectMain: async () => ({
      clicked: true,
      target: { tag: 'DIV', x: 10, y: 20 },
    }),
  });
  const out = await runClickByCoordinates(ctx, { type: 'clickByCoordinates', x: 10, y: 20 }, {});
  assert.deepEqual(out, { clicked: true, target: { tag: 'DIV', x: 10, y: 20 } });
});

test('clickByCoordinates: no element at point', async () => {
  const ctx = baseCtx({
    injectMain: async () => ({ clicked: false, reason: 'noElementAtPoint' }),
  });
  const out = await runClickByCoordinates(ctx, { type: 'clickByCoordinates', x: 0, y: 0 }, {});
  assert.deepEqual(out, { clicked: false, reason: 'noElementAtPoint' });
});

test('clickByCoordinates: tab missing → internal', async () => {
  const ctx = baseCtx({ tabId: null, injectMain: async () => ({}) });
  await assert.rejects(
    runClickByCoordinates(ctx, { type: 'clickByCoordinates', x: 1, y: 2 }, {}),
    (e) => e.code === 'internal' && /tab/.test(e.message),
  );
});

test('type: happy clear:false appends', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  function MockInput() {
    this._v = 'a';
  }
  Object.defineProperty(MockInput.prototype, 'value', {
    get() {
      return this._v;
    },
    set(v) {
      this._v = v;
    },
  });
  const el = new MockInput();
  el.focus = () => {};
  el.dispatchEvent = () => {};
  globalThis.document = {
    querySelector() {
      return el;
    },
  };
  try {
    const out = await runType(ctx, { type: 'type', selector: '#q', text: 'bc' }, {});
    assert.deepEqual(out, { typed: 'bc', cleared: false, intoSelector: '#q' });
    assert.equal(el._v, 'abc');
  } finally {
    delete globalThis.document;
  }
});

test('type: happy clear:true', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  function MockInput() {
    this._v = 'old';
  }
  Object.defineProperty(MockInput.prototype, 'value', {
    get() {
      return this._v;
    },
    set(v) {
      this._v = v;
    },
  });
  const el = new MockInput();
  el.focus = () => {};
  el.dispatchEvent = () => {};
  globalThis.document = {
    querySelector() {
      return el;
    },
  };
  try {
    const out = await runType(ctx, { type: 'type', selector: 'input', text: 'new', clear: true }, {});
    assert.deepEqual(out, { typed: 'new', cleared: true, intoSelector: 'input' });
    assert.equal(el._v, 'new');
  } finally {
    delete globalThis.document;
  }
});

test('type: selector not found → selectorTimeout', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  globalThis.document = { querySelector: () => null };
  try {
    await assert.rejects(
      runType(ctx, { type: 'type', selector: '.x', text: 'a' }, {}),
      (e) => e.code === 'selectorTimeout' && e.message === 'selector not found',
    );
  } finally {
    delete globalThis.document;
  }
});

test('setContenteditable: execCommand path', async () => {
  const restore = ensureInputEvent();
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  const el = {
    textContent: '',
    focus() {},
    dispatchEvent() {},
  };
  globalThis.document = {
    querySelector() {
      return el;
    },
    execCommand(cmd, _ui, val) {
      assert.equal(cmd, 'insertText');
      el.textContent = val;
      return true;
    },
  };
  try {
    const out = await runSetContenteditable(
      ctx,
      { type: 'setContenteditable', selector: '.editor', text: 'hello' },
      {},
    );
    assert.deepEqual(out, { inserted: 'hello', intoSelector: '.editor' });
    assert.equal(el.textContent, 'hello');
  } finally {
    delete globalThis.document;
    restore();
  }
});

test('setContenteditable: fallback when execCommand returns false', async () => {
  const restore = ensureInputEvent();
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  const el = {
    textContent: '',
    focus() {},
    dispatchEvent() {},
  };
  globalThis.document = {
    querySelector() {
      return el;
    },
    execCommand() {
      return false;
    },
  };
  try {
    const out = await runSetContenteditable(
      ctx,
      { type: 'setContenteditable', selector: '#ce', text: 'fallback' },
      {},
    );
    assert.deepEqual(out, { inserted: 'fallback', intoSelector: '#ce' });
    assert.equal(el.textContent, 'fallback');
  } finally {
    delete globalThis.document;
    restore();
  }
});

test('setContenteditable: selector not found', async () => {
  const restore = ensureInputEvent();
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => target.func(...(target.args ?? [])),
  });
  globalThis.document = { querySelector: () => null, execCommand: () => true };
  try {
    await assert.rejects(
      runSetContenteditable(ctx, { type: 'setContenteditable', selector: 'x', text: 'a' }, {}),
      (e) => e.code === 'selectorTimeout',
    );
  } finally {
    delete globalThis.document;
    restore();
  }
});

test('evaluate: two-stage injectMain sequence and happy result', async () => {
  /** @type {Array<{ tabId: number, target: object }>} */
  const calls = [];
  const ctx = baseCtx({
    scenarioId: 'my-scen',
    injectMain: async (tabId, target) => {
      calls.push({ tabId, target });
      if (target.files) {
        assert.deepEqual(target.files, ['scenarios/my-scen/scenario.js']);
        return undefined;
      }
      globalThis['__broScenario_my-scen'] = {
        doWork: (args) => ({ echo: args }),
      };
      return target.func(...(target.args ?? []));
    },
  });
  const out = await runEvaluate(
    ctx,
    { type: 'evaluate', fn: 'doWork', args: { n: 1 } },
    {},
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tabId, 7);
  assert.ok(Array.isArray(calls[0].target.files));
  assert.equal(calls[1].tabId, 7);
  assert.equal(typeof calls[1].target.func, 'function');
  assert.deepEqual(calls[1].target.args, ['my-scen', 'doWork', { n: 1 }]);
  assert.deepEqual(out, { echo: { n: 1 } });
  delete globalThis['__broScenario_my-scen'];
});

test('evaluate: scenario.module undefined → internal', async () => {
  const ctx = baseCtx({
    scenario: {
      schemaVersion: '1',
      id: 'demo',
      name: 'Demo',
      matches: ['*'],
      steps: [],
    },
    injectMain: async () => assert.fail(),
  });
  await assert.rejects(
    runEvaluate(ctx, { type: 'evaluate', fn: 'x' }, {}),
    (e) => e.code === 'internal' && e.message === 'evaluate requires scenario.module',
  );
});

test('evaluate: stage 1 failure → internal failed to install', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => {
      if (target.files) {
        throw new Error('ENOENT');
      }
      assert.fail('stage 2 should not run');
    },
  });
  await assert.rejects(
    runEvaluate(ctx, { type: 'evaluate', fn: 'go' }, {}),
    (e) => e.code === 'internal' && /failed to install scenario\.js/.test(e.message) && /ENOENT/.test(e.message),
  );
});

test('evaluate: stage 2 throws { code: loginRequired } passes through', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => {
      if (target.files) return undefined;
      globalThis.__broScenario_demo = {
        go: () => {
          throw { code: 'loginRequired', message: 'need login' };
        },
      };
      return target.func(...(target.args ?? []));
    },
  });
  await assert.rejects(
    runEvaluate(ctx, { type: 'evaluate', fn: 'go' }, {}),
    (e) => e.code === 'loginRequired' && e.message === 'need login',
  );
  delete globalThis.__broScenario_demo;
});

test('evaluate: stage 2 throws Error → internal', async () => {
  const ctx = baseCtx({
    injectMain: async (_tabId, target) => {
      if (target.files) return undefined;
      globalThis.__broScenario_demo = {
        go: () => {
          throw new Error('boom');
        },
      };
      return target.func(...(target.args ?? []));
    },
  });
  await assert.rejects(
    runEvaluate(ctx, { type: 'evaluate', fn: 'go' }, {}),
    (e) => e.code === 'internal' && e.message === 'boom',
  );
  delete globalThis.__broScenario_demo;
});

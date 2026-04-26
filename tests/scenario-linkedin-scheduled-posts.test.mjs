import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../extension/lib/schema-validator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const schemaPath = path.join(repoRoot, 'schema/scenario.schema.json');
const scenarioJsonPath = path.join(repoRoot, 'extension/scenarios/linkedin-scheduled-posts/scenario.json');
const scenarioJsPath = path.join(repoRoot, 'extension/scenarios/linkedin-scheduled-posts/scenario.js');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const scenario = JSON.parse(readFileSync(scenarioJsonPath, 'utf8'));
const scenarioJsSource = readFileSync(scenarioJsPath, 'utf8');

const SCENARIO_KEY = '__broScenario_linkedin-scheduled-posts';
const EXPORT_NAMES = [
  'findInShadow',
  'clickByAccessibleName',
  'openComposer',
  'openSchedulePanel',
  'openScheduledList',
  'isScheduledListReady',
  'extractScheduledPosts',
  'runScheduledPostsFlow',
  'loginRequired',
];

function makeCtx(overrides) {
  const g = {
    location: { pathname: '/feed/', href: 'https://www.linkedin.com/feed/' },
    // vm.runInNewContext sandboxes don't inherit host globals; provide the timer +
    // Promise primitives that scenario.js's asyncSleep relies on.
    setTimeout,
    clearTimeout,
    Promise,
  };
  g.globalThis = g;
  g.window = g;
  Object.assign(g, overrides);
  if (g.document && g.document.defaultView == null) {
    g.document.defaultView = g;
  }
  return g;
}

function runScenarioScript(ctx) {
  vm.runInNewContext(scenarioJsSource, ctx, { filename: 'scenario.js' });
}

test('scenario.json validates against schema', () => {
  const r = validate(schema, scenario);
  assert.equal(r.valid, true, r.valid === false ? JSON.stringify(r.errors) : '');
  assert.equal(scenario.steps.length, 2);
  assert.deepEqual(
    scenario.steps.map((s) => s.type),
    ['navigate', 'evaluate'],
  );
  assert.equal(scenario.steps[1].fn, 'runScheduledPostsFlow');
});

test('scenario.js installs exports and is idempotent on re-injection', () => {
  const document = { documentElement: null, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } };
  const ctx = makeCtx({ document });
  runScenarioScript(ctx);
  const api = ctx[SCENARIO_KEY];
  assert.ok(api, 'exports object exists');
  for (const name of EXPORT_NAMES) {
    assert.equal(typeof api[name], 'function', name);
  }
  const firstRef = ctx[SCENARIO_KEY];
  runScenarioScript(ctx);
  assert.equal(ctx[SCENARIO_KEY], firstRef, 'second inject must not replace exports');
});

test('findInShadow traverses shadow roots', () => {
  const target = { tagName: 'P', className: 'deep' };
  const shadowRoot = {
    querySelector(sel) {
      return sel === 'p.deep' ? target : null;
    },
    querySelectorAll() {
      return [];
    },
  };
  const host = { tagName: 'DIV', shadowRoot, children: [] };
  const document = {
    documentElement: host,
    querySelector() {
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '*') return [host];
      return [];
    },
    getElementById() {
      return null;
    },
  };
  const ctx = makeCtx({ document });
  runScenarioScript(ctx);
  const found = ctx[SCENARIO_KEY].findInShadow({ selector: 'p.deep' });
  assert.equal(found, target);
});

test('loginRequired throws on /login and returns { ok: true } on feed', () => {
  const document = { documentElement: null, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } };
  const ctxLogin = makeCtx({
    document,
    location: { pathname: '/login', href: 'https://www.linkedin.com/login' },
  });
  runScenarioScript(ctxLogin);
  assert.throws(
    () => ctxLogin[SCENARIO_KEY].loginRequired({}),
    (err) => err && err.code === 'loginRequired' && err.message === 'redirected to login',
  );

  const ctxFeed = makeCtx({
    document,
    location: { pathname: '/feed/', href: 'https://www.linkedin.com/feed/' },
  });
  runScenarioScript(ctxFeed);
  const okFeed = ctxFeed[SCENARIO_KEY].loginRequired({});
  assert.equal(okFeed.ok, true);
});

test('isScheduledListReady and extractScheduledPosts parse scheduled rows', async () => {
  const viewAria1 =
    'Preview of the scheduled post that will be published on Mon Jan 1, 2025 at 3:00 PM, click to edit';
  const viewAria2 =
    'Preview of the scheduled post that will be published on Tue Jan 2, 2025 at 4:15 PM, click to edit';

  const text1 = { innerText: 'First post body' };
  const text2 = { innerText: 'Second post only text' };

  const showMore1 = {
    click() {},
  };
  Object.defineProperty(showMore1, 'outerHTML', { get() { return '<button aria-label="Show more text">'; } });
  showMore1.getAttribute = function (name) {
    if (name === 'aria-label') return 'Show more text';
    return null;
  };

  const viewBtn1 = {
    getAttribute(name) {
      if (name === 'aria-label') return viewAria1;
      return null;
    },
  };
  const viewBtn2 = {
    getAttribute(name) {
      if (name === 'aria-label') return viewAria2;
      return null;
    },
  };

  const img1 = { src: 'https://media.licdn.com/dms/image/test' };

  const li1 = {
    querySelector(sel) {
      if (sel === 'button[aria-label*="Show more"]') return showMore1;
      if (sel === '.inline-show-more-text') return text1;
      if (sel === 'img') return img1;
      if (sel === 'button[aria-label*="Preview of the scheduled post"]') return viewBtn1;
      return null;
    },
  };

  const li2 = {
    textContent: 'Posting Tue Jan 2 at 4:15 PM Second post only text',
    querySelector(sel) {
      if (sel === 'button[aria-label*="Show more"]') return null;
      if (sel === '.inline-show-more-text') return { textContent: '' };
      if (sel === 'img') return null;
      if (sel === 'button[aria-label*="Preview of the scheduled post"]') return viewBtn2;
      return null;
    },
  };

  const list = {
    querySelectorAll(sel) {
      if (sel === 'li.artdeco-list__item.share-post-list-view__item') return [li1, li2];
      return [];
    },
  };

  const document = {
    documentElement: null,
    querySelector(sel) {
      if (sel === 'ul.artdeco-list') return list;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };

  const ctx = makeCtx({ document });
  runScenarioScript(ctx);
  assert.equal(ctx[SCENARIO_KEY].isScheduledListReady({}), true);
  const out = await ctx[SCENARIO_KEY].extractScheduledPosts({});

  assert.equal(out.posts.length, 2);
  assert.equal(out.posts[0].publishTime, 'Mon Jan 1, 2025 at 3:00 PM');
  assert.equal(out.posts[0].text, 'First post body');
  assert.equal(out.posts[0].mediaSrc, 'https://media.licdn.com/dms/image/test');
  assert.equal(out.posts[1].publishTime, 'Tue Jan 2, 2025 at 4:15 PM');
  assert.equal(out.posts[1].text, 'Second post only text');
  assert.equal(out.posts[1].mediaSrc, null);
});

test('isScheduledListReady is false while list is present but rows are not populated yet', () => {
  const emptyList = {
    querySelectorAll() {
      return [];
    },
    textContent: '',
  };
  const document = {
    documentElement: null,
    querySelector(sel) {
      if (sel === 'ul.artdeco-list') return emptyList;
      if (sel === '.artdeco-modal.share-box-v2__modal') return { textContent: 'Scheduled posts' };
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };
  document.documentElement = document;
  const ctx = makeCtx({ document });
  runScenarioScript(ctx);
  assert.equal(ctx[SCENARIO_KEY].isScheduledListReady({}), false);
});

test('openComposer uses an actionable Start a post candidate and robust event sequence', async () => {
  let modalOpen = false;
  const events = [];
  function el(tagName, attrs = {}, textContent = '') {
    const node = {
      nodeType: 1,
      tagName,
      textContent,
      children: [],
      disabled: false,
      offsetParent: {},
      getAttribute(name) {
        return attrs[name] || null;
      },
      querySelector(sel) {
        if (modalOpen && sel === '.artdeco-modal.share-box-v2__modal') return modal;
        if (modalOpen && sel === '[aria-label="Text editor for creating content"]') return editor;
        if (modalOpen && sel === '[aria-label="Schedule post"]') return scheduleButton;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === '*') return this.children;
        return [];
      },
      getBoundingClientRect() {
        return { left: 10, top: 20, width: 120, height: 40, x: 10, y: 20 };
      },
      scrollIntoView() {
        events.push('scroll:' + textContent);
      },
      dispatchEvent(evt) {
        events.push(evt.type + ':' + textContent);
        return true;
      },
      click() {
        events.push('clickMethod:' + textContent);
      },
      contains(target) {
        return target === this;
      },
    };
    return node;
  }
  const hidden = el('DIV', { role: 'button' }, 'Start a post');
  hidden.offsetParent = null;
  hidden.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, x: 0, y: 0 });
  hidden.click = () => {
    throw new Error('hidden candidate should not be clicked');
  };
  const visible = el('DIV', { role: 'button' }, 'Start a post');
  visible.click = () => {
    events.push('clickMethod:visible');
    modalOpen = true;
  };
  const editor = el('DIV', { 'aria-label': 'Text editor for creating content' }, '');
  const scheduleButton = el('BUTTON', { 'aria-label': 'Schedule post' }, '');
  const modal = el('DIV', {}, 'Create post modal');
  const root = el('DIV', {}, '');
  root.children = [hidden, visible];
  const document = {
    documentElement: root,
    readyState: 'complete',
    querySelector(sel) {
      if (modalOpen && sel === '.artdeco-modal.share-box-v2__modal') return modal;
      if (modalOpen && sel === '[aria-label="Text editor for creating content"]') return editor;
      if (modalOpen && sel === '[aria-label="Schedule post"]') return scheduleButton;
      return root.querySelector(sel);
    },
    querySelectorAll(sel) {
      if (sel === '*') return root.children;
      return [];
    },
    getElementById() {
      return null;
    },
    elementFromPoint() {
      return visible;
    },
  };
  const ctx = makeCtx({
    document,
    PointerEvent: class PointerEvent {
      constructor(type) { this.type = type; }
    },
    MouseEvent: class MouseEvent {
      constructor(type) { this.type = type; }
    },
    Event: class Event {
      constructor(type) { this.type = type; }
    },
  });
  runScenarioScript(ctx);
  const result = await ctx[SCENARIO_KEY].openComposer({});
  assert.equal(result.opened, true);
  assert.ok(events.includes('pointerdown:Start a post'));
  assert.ok(events.includes('clickMethod:visible'));
});

test('scenario.js has no import/export/chrome', () => {
  assert.ok(!/\bimport\b/.test(scenarioJsSource));
  assert.ok(!/\bexport\b/.test(scenarioJsSource));
  assert.ok(!/\bchrome\s*\./.test(scenarioJsSource));
});

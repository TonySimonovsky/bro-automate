// step-runner.js — sequential step execution with cancel-aware awaits and partial accumulation.
// Per-run isolation per PRD NFR-R1: try/catch around every step, caught executeScript rejections.
// TDD: §7.3
// Tasks: T-406
// Wave: 3
// Status: implemented (Wave 3)

import { connect } from './native-bridge.js';
import * as log from './log.js';
import * as fileTransfer from './file-transfer.js';

import * as navigateM from './steps/navigate.js';
import * as waitForSelectorM from './steps/wait-for-selector.js';
import * as waitForTextM from './steps/wait-for-text.js';
import * as waitForStateM from './steps/wait-for-state.js';
import * as clickM from './steps/click.js';
import * as clickByCoordinatesM from './steps/click-by-coordinates.js';
import * as typeM from './steps/type.js';
import * as setContenteditableM from './steps/set-contenteditable.js';
import * as scrollM from './steps/scroll.js';
import * as extractM from './steps/extract.js';
import * as evaluateM from './steps/evaluate.js';
import * as sleepM from './steps/sleep.js';
import * as uploadFileM from './steps/upload-file.js';
import * as screenshotM from './steps/screenshot.js';

/** v0.01 upwork-collect: `source:notifications` has no `navigate` in scenario.json; open this tab first. */
const UPWORK_NOTIFICATIONS_DEFAULT_URL = 'https://www.upwork.com/ab/notifications/';
const UPWORK_JOB_URL_PREFIX = 'https://www.upwork.com/jobs/~';

const REQUIRED_TYPES = [
  'navigate',
  'waitForSelector',
  'waitForText',
  'waitForState',
  'click',
  'clickByCoordinates',
  'type',
  'setContenteditable',
  'scroll',
  'extract',
  'evaluate',
  'sleep',
  'uploadFile',
  'screenshot',
];

/**
 * @param {Record<string, unknown>} mod
 * @param {string} name
 * @param {string} file
 */
function stepDefault(mod, name, file) {
  if (mod && typeof mod.default === 'function') return mod.default;
  return async function stepNotImplemented() {
    throw { code: 'internal', message: `step not implemented: ${name} (see ${file})` };
  };
}

/**
 * Eager step registry — import all 14 step modules.
 * @type {Record<string, (ctx: any, step: any, params: any) => Promise<unknown>>}
 */
export const STEPS = {
  navigate: stepDefault(navigateM, 'navigate', 'steps/navigate.js'),
  waitForSelector: stepDefault(waitForSelectorM, 'waitForSelector', 'steps/wait-for-selector.js'),
  waitForText: stepDefault(waitForTextM, 'waitForText', 'steps/wait-for-text.js'),
  waitForState: stepDefault(waitForStateM, 'waitForState', 'steps/wait-for-state.js'),
  click: stepDefault(clickM, 'click', 'steps/click.js'),
  clickByCoordinates: stepDefault(clickByCoordinatesM, 'clickByCoordinates', 'steps/click-by-coordinates.js'),
  type: stepDefault(typeM, 'type', 'steps/type.js'),
  setContenteditable: stepDefault(setContenteditableM, 'setContenteditable', 'steps/set-contenteditable.js'),
  scroll: stepDefault(scrollM, 'scroll', 'steps/scroll.js'),
  extract: stepDefault(extractM, 'extract', 'steps/extract.js'),
  evaluate: stepDefault(evaluateM, 'evaluate', 'steps/evaluate.js'),
  sleep: stepDefault(sleepM, 'sleep', 'steps/sleep.js'),
  uploadFile: stepDefault(uploadFileM, 'uploadFile', 'steps/upload-file.js'),
  screenshot: stepDefault(screenshotM, 'screenshot', 'steps/screenshot.js'),
};

/** Tab ids whose budget slot must be released when the user closes the tab (PRD FR-T4, NFR-R3). */
const globalTabSlotReleasers = new Map();

export function getStepRunnerDiag() {
  const evaluateSource = typeof evaluateM.default === 'function' ? String(evaluateM.default) : '';
  return {
    evaluateDiagBuild: evaluateM.EVALUATE_DIAG_BUILD || null,
    evaluateSourceHasProgressDebug: evaluateSource.includes("subEvent: 'evaluateDebug'"),
    evaluateSourceHasLinkedInBranch: evaluateSource.includes("scenarioId === 'linkedin-scheduled-posts'"),
    pinnedTabSlotCount: globalTabSlotReleasers.size,
  };
}

for (const t of REQUIRED_TYPES) {
  if (typeof STEPS[t] !== 'function') {
    throw new Error(`[step-runner] missing step in STEPS: ${t}`);
  }
}

export const DEFAULT_TIMEOUTS = {
  navigate: 30_000,
  waitForSelector: 15_000,
  waitForText: 15_000,
  waitForState: 15_000,
  extract: 5_000,
  click: 10_000,
  clickByCoordinates: 10_000,
  type: 10_000,
  setContenteditable: 10_000,
  scroll: 10_000,
  evaluate: 30_000,
  sleep: 0,
  uploadFile: 60_000,
  screenshot: 10_000,
};

/**
 * @param {string} url
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesAllowed(url, patterns) {
  if (!url || !Array.isArray(patterns) || patterns.length === 0) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const noQuery = (href) => {
    try {
      const x = new URL(href);
      return `${x.protocol}//${x.host}${x.pathname}`;
    } catch {
      return href;
    }
  };
  const c = noQuery(String(u));
  const cNoPort = `${u.protocol}//${u.hostname}${u.pathname}`;
  const hostMatches = (actual, pattern) => {
    if (actual.host === pattern.host) return true;
    // Chrome host permission patterns like http://127.0.0.1/* match all ports on that
    // host. Our scenario matches use the same shape, so a pattern with no explicit port
    // should allow localhost dev servers such as http://127.0.0.1:8766/.
    if (
      pattern.port === '' &&
      actual.hostname === pattern.hostname &&
      /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(actual.hostname)
    ) {
      return true;
    }
    return false;
  };
  for (const raw of patterns) {
    const s = String(raw);
    if (s === '*') return true;
    if (!s.includes('*')) {
      let p;
      try {
        p = new URL(s);
      } catch {
        continue;
      }
      if (u.protocol !== p.protocol) continue;
      if (!hostMatches(u, p)) continue;
      if (u.pathname === p.pathname) return true;
      continue;
    }
    const firstSeg = s.split('*')[0];
    let p0;
    try {
      p0 = new URL(firstSeg);
    } catch {
      try {
        p0 = new URL(s);
      } catch {
        continue;
      }
    }
    if (u.protocol !== p0.protocol) continue;
    if (!hostMatches(u, p0)) continue;
    if (s.startsWith('https:') && u.protocol === 'http:') continue;
    if (s.startsWith('http:') && u.protocol === 'https:') continue;
    const reParts = s.split('*').map((seg) => seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp('^' + reParts.join('.*') + '$');
    if (re.test(String(u)) || re.test(c) || re.test(cNoPort) || re.test(u.origin + u.pathname + u.search)) {
      if (s.startsWith('https:') && u.protocol === 'http:') continue;
      if (s.startsWith('http:') && u.protocol === 'https:') continue;
      return true;
    }
  }
  return false;
}

/**
 * @param {object} p
 * @param {import('./run-registry.js').RunRecord} p.run
 * @param {object} p.scenario
 * @param {object} p.params
 * @param {string} p.requestId
 * @param {object} p.adapters
 */
export function createCtx(p) {
  const { run, scenario, params, requestId, adapters } = p;
  if (!adapters) throw new Error('createCtx: adapters required');

  const { ownership, budget, chrome: chromeOverride, registry: _registry } = adapters;
  if (!ownership || !budget) {
    void _registry;
    throw new Error('createCtx: adapters.ownership and adapters.budget are required');
  }
  const chrome = chromeOverride ?? globalThis.chrome;
  if (!chrome) throw new Error('createCtx: chrome (or adapter) required');

  const budgetAc = new AbortController();
  /** @type {Map<number, { release: () => void }>} */
  const tabSlotReleases = new Map();
  /** @type {number | null} Browser-only tab group id used as a visual marker. */
  let tabGroupId = null;

  const nativeBridge = adapters.nativeConnection
    ? { send: (msg) => adapters.nativeConnection?.send?.(msg), onMessage: (h) => adapters.nativeConnection?.onMessage?.(h) }
    : { send: () => {}, onMessage: () => {} };

  const ft = adapters.fileTransfer ?? {
    ...fileTransfer,
    serveFile: (path, o) => fileTransfer.serveFile(path, { ...o, nativeBridge: adapters.nativeConnection ?? nativeBridge }),
  };

  let partialArr = null;
  let partialValue = null;
  let tabId = null;
  let cancelled = false;
  /** @type {((v?: { cancelled: boolean }) => void) | null} */
  let resolveCancel = null;
  const cancelToken = new Promise((res) => {
    resolveCancel = (v) => {
      if (cancelled) return;
      cancelled = true;
      res(v || { cancelled: true });
    };
  });

  const ctx = {
    runId: run.runId,
    requestId,
    scenarioId: run.scenarioId,
    scenario,
    params: params && typeof params === 'object' ? params : {},

    /** @type {number | null} */
    get tabId() {
      return tabId;
    },
    set tabId(_v) {
      throw new Error('set ctx.tabId only via setTabId()');
    },
    setTabId(t) {
      tabId = typeof t === 'number' ? t : null;
    },

    chrome,
    fileTransfer: ft,
    // Wire/host adapters needed by upload-file (TDD §8): X-Bro-Token from hostReady,
    // and the native-messaging bridge for the serveFile RPC. See pm/build/v.0.01/step-contract.md §2.
    nativeBridge,
    hostToken: adapters.hostToken ?? null,
    matches: Array.isArray(scenario.matches) ? scenario.matches : [],
    isUrlAllowed(u) {
      return matchesAllowed(u, ctx.matches);
    },

    log: {
      info: (scope, fields, msg) => log.info(scope, { ...fields, runId: run.runId, requestId }, msg),
      warn: (scope, fields, msg) => log.warn(scope, { ...fields, runId: run.runId, requestId }, msg),
      error: (scope, fields, msg) => log.error(scope, { ...fields, runId: run.runId, requestId }, msg),
    },

    openTab: async (url, opts) => {
      if (ctx.isCancelled()) throw { code: 'cancelled', message: 'cancelled before openTab' };
      const newTab = opts?.newTab !== false;
      const runId = run.runId;
      const slotWaitRaw = opts && opts.tabSlotTimeoutMs;
      const slotWaitMs =
        slotWaitRaw != null && Number.isFinite(Number(slotWaitRaw))
          ? Math.max(1, Math.floor(Number(slotWaitRaw)))
          : undefined;
      let handle;
      try {
        handle = await budget.acquire({
          runId,
          requestId,
          cancelToken: budgetAc.signal,
          ...(slotWaitMs != null ? { timeoutMs: slotWaitMs } : {}),
        });
      } catch (e) {
        if (e && /** @type {any} */ (e).name === 'AbortError') {
          throw { code: 'cancelled', message: 'cancelled while waiting for tab slot' };
        }
        throw e;
      }
      const releaseAll = (h) => {
        try {
          if (h && typeof h.release === 'function') h.release();
        } catch {
          // ignore
        }
      };
      /** Idempotent: budget slot, maps, run tab set, and ctx primary tab (PRD FR-T4 / NFR-R3). */
      const pinSlotForTab = (tid, h) => {
        let done = false;
        const releaseOnce = () => {
          if (done) return;
          done = true;
          releaseAll(h);
          tabSlotReleases.delete(tid);
          globalTabSlotReleasers.delete(tid);
          try {
            run.ownedTabs.delete(tid);
          } catch {
            // ignore
          }
          if (ctx.tabId === tid) {
            ctx.setTabId(null);
          }
        };
        tabSlotReleases.set(tid, { release: releaseOnce });
        globalTabSlotReleasers.set(tid, releaseOnce);
        return releaseOnce;
      };
      try {
        if (!newTab && tabId != null) {
          await new Promise((res, rej) => {
            chrome.tabs.update(
              tabId,
              { url },
              (t) => {
                const le = chrome.runtime && chrome.runtime.lastError;
                if (le) rej(new Error(le.message));
                else res(t);
              },
            );
          });
          if (ownership.ownerOf(tabId) !== runId) ownership.claim(tabId, runId);
          run.ownedTabs.add(tabId);
          const releaseOnce = pinSlotForTab(tabId, handle);
          tabGroupId = await markTabInBrowserUi(chrome, tabId, runId, tabGroupId);
          return { tabId, release: releaseOnce };
        }
        const created = await new Promise((res, rej) => {
          chrome.tabs.create({ url, active: false }, (t) => {
            const le = chrome.runtime && chrome.runtime.lastError;
            if (le) rej(new Error(le.message));
            else res(t);
          });
        });
        const tid = created && created.id;
        if (typeof tid !== 'number') {
          releaseAll(handle);
          throw { code: 'internal', message: 'tabs.create: no id' };
        }
        tabId = tid;
        ctx.setTabId(tid);
        ownership.claim(tid, runId);
        run.ownedTabs.add(tid);
        const releaseOnce = pinSlotForTab(tid, handle);
        tabGroupId = await markTabInBrowserUi(chrome, tid, runId, tabGroupId);
        return { tabId: tid, release: releaseOnce };
      } catch (e) {
        releaseAll(handle);
        throw e;
      }
    },

    closeTab: async (tid) => {
      if (run.ownedTabs && run.ownedTabs.has(tid)) {
        const slot = tabSlotReleases.get(tid);
        if (slot) {
          try {
            slot.release();
          } catch {
            // ignore
          }
        }
        tabSlotReleases.delete(tid);
        globalTabSlotReleasers.delete(tid);
        run.ownedTabs.delete(tid);
        if (ctx.tabId === tid) {
          tabId = null;
        }
        ownership.release(tid);
        await new Promise((res) => {
          try {
            chrome.tabs.remove(tid, res);
          } catch {
            res();
          }
        });
      }
    },

    async injectMain(t, target) {
      return doInject(this, t, target, 'MAIN');
    },
    async injectIso(t, target) {
      return doInject(this, t, target, 'ISOLATED');
    },

    appendPartial(v) {
      if (!Array.isArray(partialArr)) {
        partialArr = [];
        partialValue = null;
      }
      partialArr.push(v);
    },
    setPartial(v) {
      partialValue = v;
      partialArr = null;
    },
    getPartial() {
      if (Array.isArray(partialArr)) return partialArr;
      return partialValue;
    },

    sendProgress(payload) {
      if (adapters && typeof adapters.sendToNative === 'function') {
        try {
          adapters.sendToNative({
            event: 'runProgress',
            requestId: ctx.requestId,
            runId: run.runId,
            scenarioId: run.scenarioId,
            ...payload,
          });
        } catch {
          // isolate
        }
      }
    },

    cancelToken,
    isCancelled: () => cancelled,
    releaseQueuedAcquires: () => {
      try {
        budgetAc.abort();
      } catch {
        // ignore
      }
    },
    _internalResolveCancel: () => (resolveCancel ? resolveCancel({ cancelled: true }) : undefined),
  };
  return ctx;
}

/**
 * Browser-UI-only marker for the current run's tabs. This uses Chrome tab groups, which are
 * visible in the tab strip but are NOT exposed to page JavaScript (unlike changing title,
 * favicon, URL, or DOM attributes). If the API is unavailable (tests, older Chrome, missing
 * permission), this no-ops.
 *
 * @param {import('chrome').chrome} chrome
 * @param {number} tabId
 * @param {string} runId
 * @param {number | null} groupId
 * @returns {Promise<number | null>}
 */
async function markTabInBrowserUi(chrome, tabId, runId, groupId) {
  if (!chrome || !chrome.tabs || typeof chrome.tabs.group !== 'function') return groupId ?? null;
  const shortRun = String(runId || '').replace(/^r_/u, '').slice(0, 6);
  const title = shortRun ? `Bro ${shortRun}` : 'Bro';

  const newGroupId = await new Promise((res) => {
    const opts = groupId != null
      ? { tabIds: [tabId], groupId }
      : { tabIds: [tabId], createProperties: { windowId: undefined } };
    // Avoid createProperties.windowId: undefined for Chrome's strict argument validator.
    if (opts.createProperties && opts.createProperties.windowId === undefined) {
      delete opts.createProperties.windowId;
    }
    try {
      chrome.tabs.group(opts, (gid) => {
        const le = chrome.runtime && chrome.runtime.lastError;
        if (le || typeof gid !== 'number') res(groupId ?? null);
        else res(gid);
      });
    } catch {
      res(groupId ?? null);
    }
  });

  if (newGroupId != null && chrome.tabGroups && typeof chrome.tabGroups.update === 'function') {
    await new Promise((res) => {
      try {
        chrome.tabGroups.update(
          newGroupId,
          { title, color: 'red' },
          () => res(),
        );
      } catch {
        res();
      }
    });
  }
  return newGroupId;
}

/**
 * @param {object} ctx
 * @param {number} t
 * @param {{ func: Function, args?: any[] } | { files: string[] }} target
 * @param {'MAIN' | 'ISOLATED'} world
 */
function doInject(ctx, t, target, world) {
  if (ctx.isCancelled()) {
    return Promise.reject({ code: 'cancelled', message: 'cancelled before inject' });
  }
  const ch = ctx.chrome;
  if (!ch || !ch.scripting || !ch.scripting.executeScript) {
    return Promise.reject({ code: 'internal', message: 'chrome.scripting not available' });
  }
  return new Promise((res, rej) => {
    /** @type {object} */
    const opt = { target: { tabId: t }, world: world || 'ISOLATED' };
    if ('func' in target) {
      opt.func = target.func;
      if (Array.isArray(target.args)) opt.args = target.args;
    } else {
      opt.files = target.files;
    }
    ch.scripting.executeScript(/** @type {any} */ (opt), (r) => {
      const le = ch.runtime && ch.runtime.lastError;
      if (le) {
        if (/no tab/iu.test(le.message) || /tab.*not.*found/iu.test(le.message) || /cannot access.*tab/iu.test(le.message)) {
          rej({ code: 'tabClosedDuringStep', message: le.message, tabId: t });
        } else {
          rej(new Error(le.message));
        }
        return;
      }
      const first = r && r[0];
      res(first && first.result);
    });
  });
}

/**
 * @param {object} ctx
 */
function stepMapFor(ctx) {
  const o = ctx && ctx._adapters && ctx._adapters.steps;
  if (o && typeof o === 'object') {
    return { ...STEPS, ...o };
  }
  return STEPS;
}

/**
 * @param {object} ctx
 * @param {object} step
 * @param {object} [params]
 */
export async function executeStep(ctx, step, params) {
  const p = params !== undefined ? params : ctx.params;
  const map = stepMapFor(ctx);
  if (!step || typeof step.type !== 'string' || !map[step.type]) {
    return { ok: false, error: 'internal', errorMessage: 'unknown step type: ' + (step && step.type) };
  }

  if (step.type !== 'navigate' && step.type !== 'sleep') {
    if (ctx.tabId == null) {
      return { ok: false, error: 'internal', errorMessage: 'step requires a tab; run navigate first' };
    }
    try {
      const tab = await new Promise((res, rej) => {
        ctx.chrome.tabs.get(ctx.tabId, (t) => {
          const le = ctx.chrome.runtime && ctx.chrome.runtime.lastError;
          if (le) rej(new Error(le.message));
          else res(t);
        });
      });
      const currentUrl = tab && (tab.url || tab.pendingUrl);
      if (currentUrl && !ctx.isUrlAllowed(currentUrl)) {
        return {
          ok: false,
          error: 'matchesRefused',
          errorMessage: 'current tab URL is outside scenario matches: ' + String(currentUrl),
        };
      }
    } catch (e) {
      if (e && /no tab/iu.test(String(e)))
        return { ok: false, error: 'tabClosedDuringStep', errorMessage: 'tab not found' };
      return { ok: false, error: 'internal', errorMessage: e && e.message ? String(e.message) : String(e) };
    }
  }

  try {
    const result = await map[step.type](ctx, step, p);
    return { ok: true, data: result };
  } catch (thrown) {
    if (thrown && typeof thrown === 'object' && typeof /** @type {any} */ (thrown).code === 'string') {
      const { code, message, ...rest } = /** @type {any} */ (thrown);
      return { ok: false, error: code, errorMessage: String(message || code), ...rest };
    }
    return {
      ok: false,
      error: 'internal',
      errorMessage: thrown && /** @type {any} */ (thrown).message != null ? String(/** @type {any} */ (thrown).message) : String(thrown),
      stack: thrown && typeof thrown === 'object' && /** @type {any} */ (thrown).stack ? String(/** @type {any} */ (thrown).stack) : undefined,
    };
  }
}

/**
 * `upwork-collect` has no leading `navigate` in scenario.json; the first step is `evaluate`.
 * If the run has no tab yet, open a managed tab to the page implied by `params` (same as a first
 * `navigate` step) so `resolveJobUrls` / `scrapeAll` can use `chrome.scripting`.
 *
 * - `source: "notifications"` → notifications list
 * - `jobIds: ["…"]` → first id → `https://www.upwork.com/jobs/~<id>`
 * - `jobUrls: ["https://…"]` → first URL
 *
 * @param {object} ctx
 * @param {object} [params]
 * @returns {Promise<{ ok: true, data?: any } | { ok: false, error: string, errorMessage?: string }>}
 */
async function ensureUpworkCollectFirstTabIfNeeded(ctx, params) {
  if (ctx == null || ctx.tabId != null) {
    return { ok: true };
  }
  if (ctx.scenarioId !== 'upwork-collect') {
    return { ok: true };
  }
  const p = params && typeof params === 'object' ? params : {};
  let url = null;
  if (p.source === 'notifications') {
    url = UPWORK_NOTIFICATIONS_DEFAULT_URL;
  } else if (Array.isArray(p.jobIds) && p.jobIds.length > 0) {
    const id = String(p.jobIds[0]).replace(/^\~+/, '');
    url = UPWORK_JOB_URL_PREFIX + id;
  } else if (Array.isArray(p.jobUrls) && p.jobUrls.length > 0) {
    url = String(p.jobUrls[0]);
  } else {
    return { ok: true };
  }
  if (typeof ctx.isUrlAllowed === 'function' && !ctx.isUrlAllowed(url)) {
    return {
      ok: false,
      error: 'matchesRefused',
      errorMessage: 'initial navigation URL is outside scenario matches: ' + String(url),
    };
  }
  return executeStep(ctx, { type: 'navigate', url, newTab: true }, params);
}

/**
 * `hostReady` stores `broHttpToken` in `chrome.storage.session` (see background.js). Merge it
 * into adapters for `uploadFile` / `file-transfer` (X-Bro-Token) when not already set.
 * Retries briefly: right after a SW / extension reload, the native host can emit `hostReady`
 * a few ms after the first `runScenario`.
 * @param {object} adapters
 * @returns {Promise<object>}
 */
async function mergeAdaptersWithSessionHostToken(adapters) {
  if (!adapters) return adapters;
  if (adapters.hostToken != null && adapters.hostToken !== '') return adapters;
  const c = globalThis.chrome;
  if (!c || !c.storage || !c.storage.session) return adapters;
  const deadline = Date.now() + 5000;
  let tok;
  do {
    const got = await new Promise(
      /** @param {(o: { broHttpToken?: string } | void) => void} res */ (res) => {
        try {
          c.storage.session.get(['broHttpToken'], (o) => res(o && typeof o === 'object' ? o : {}));
        } catch {
          res({});
        }
      },
    );
    tok = got && got.broHttpToken;
    if (tok != null && tok !== '') {
      return { ...adapters, hostToken: String(tok) };
    }
    if (Date.now() >= deadline) {
      return adapters;
    }
    await new Promise((r) => setTimeout(r, 100));
  } while (true);
}

/**
 * @param {object} opts
 * @param {object} opts.scenario
 * @param {object} [opts.params]
 * @param {string} opts.requestId
 * @param {object} opts.adapters
 * @param {import('./run-registry.js').RunRecord} [opts.run]
 */
export async function executeRun(opts) {
  const { scenario, params = {}, requestId, adapters } = opts;
  if (!adapters || !adapters.registry) {
    return { runId: '', ok: false, error: 'internal', errorMessage: 'adapters.registry required' };
  }
  const registry = adapters.registry;
  let run = opts.run;
  let runId;
  if (run) {
    runId = run.runId;
  } else {
    runId = registry.create({ scenarioId: scenario && scenario.id, requestId: requestId || '' });
    run = registry.get(runId);
  }
  if (!run) {
    return { runId, ok: false, error: 'internal', errorMessage: 'run record missing' };
  }
  if (Array.isArray(scenario && scenario.steps) === false) {
    return { runId, ok: false, error: 'internal', errorMessage: 'scenario has no steps' };
  }

  const ad = await mergeAdaptersWithSessionHostToken(adapters);
  const ctx = createCtx({ run, scenario, params, requestId, adapters: ad });
  if (ad) ctx._adapters = ad;
  registerRunCancel(runId, ctx);

  const steps = scenario.steps;
  let lastData;
  /** `resolveJobUrls` return shape `{ urls: string[] }` — kept so terminal `data` can show URLs when the next step is `scrapeAll` on a non–job-detail tab (Architecture A; last step is `skipped` only). */
  let lastResolveJobUrls;
  /** @type {{ runId: string, ok: boolean, data?: any, error?: string, errorMessage?: string, partial?: any } | null} */
  let failed = null;

  try {
    try {
      registry.setStatus(runId, 'running');
    } catch {
      // ignore
    }
    const rPreamble = await ensureUpworkCollectFirstTabIfNeeded(ctx, params);
    if (!rPreamble.ok) {
      if (rPreamble.error === 'cancelled') {
        failed = { runId, ok: false, error: 'cancelled', partial: ctx.getPartial() };
        try {
          registry.markCancelled(runId);
        } catch {
          // ignore
        }
      } else {
        const { ok: _op, data: _dp, ...errPreamble } = rPreamble;
        failed = { runId, ok: false, error: rPreamble.error, errorMessage: rPreamble.errorMessage, partial: ctx.getPartial(), ...errPreamble };
        try {
          failed.debug = await captureFailureDebug(ctx, { type: 'navigate' }, rPreamble);
        } catch {
          // ignore
        }
        try {
          registry.markError(runId, rPreamble.error, rPreamble.errorMessage || 'step failed');
        } catch {
          // ignore
        }
      }
    }
    for (let i = 0; i < steps.length; i++) {
      if (failed) {
        break;
      }
      if (ctx.isCancelled()) {
        failed = { runId, ok: false, error: 'cancelled', partial: ctx.getPartial() };
        break;
      }
      const st = steps[i];
      if (st && st.type) {
        try {
          ctx.sendProgress({ stepIndex: i, stepType: st.type });
        } catch {
          // ignore
        }
        try {
          registry.setStep(runId, i, st.type);
        } catch {
          // ignore
        }
      }
      let r;
      try {
        r = await executeStep(ctx, st, params);
      } catch (e) {
        failed = {
          runId,
          ok: false,
          error: 'internal',
          errorMessage: e && e.message ? String(e.message) : String(e),
          partial: ctx.getPartial(),
        };
        break;
      }
      if (!r.ok) {
        if (r.error === 'cancelled') {
          failed = { runId, ok: false, error: 'cancelled', partial: ctx.getPartial() };
        } else {
          const { ok: _o, data: _d, ...errRest } = r;
          failed = { runId, ok: false, error: r.error, errorMessage: r.errorMessage, partial: ctx.getPartial(), ...errRest };
          failed.debug = await captureFailureDebug(ctx, st, r);
        }
        try {
          if (r.error === 'cancelled') {
            registry.markCancelled(runId);
          } else {
            registry.markError(runId, r.error, r.errorMessage || 'step failed');
          }
        } catch {
          // ignore
        }
        break;
      }
      if (
        r.data &&
        st &&
        st.type === 'evaluate' &&
        st.fn === 'resolveJobUrls' &&
        Array.isArray(/** @type {any} */ (r.data).urls)
      ) {
        lastResolveJobUrls = r.data;
      }
      lastData = r.data;
    }
  } catch (outer) {
    failed = {
      runId,
      ok: false,
      error: 'internal',
      errorMessage: outer && outer.message ? String(outer.message) : String(outer),
      partial: ctx.getPartial(),
    };
    try {
      failed.debug = await captureFailureDebug(ctx, null, outer);
      registry.markError(runId, 'internal', failed.errorMessage);
    } catch {
      // ignore
    }
  } finally {
    try {
      ctx.releaseQueuedAcquires();
    } catch {
      // ignore
    }
    if (run && run.ownedTabs) {
      const tabs = [...run.ownedTabs];
      for (const tid of tabs) {
        try {
          await ctx.closeTab(tid);
        } catch {
          // isolate
        }
      }
    }
    unregisterRunCancel(runId);
  }

  if (failed) {
    if (failed.error === 'cancelled') {
      try {
        registry.markCancelled(runId);
      } catch {
        // ignore
      }
    }
    return failed;
  }
  if (ctx.isCancelled()) {
    try {
      registry.markCancelled(runId);
    } catch {
      // ignore
    }
    return { runId, ok: false, error: 'cancelled', partial: ctx.getPartial() };
  }
  const pVal = ctx.getPartial();
  let data = pVal !== undefined && pVal !== null ? pVal : lastData;
  if (
    (pVal === undefined || pVal === null) &&
    lastData &&
    typeof lastData === 'object' &&
    lastData.skipped === true &&
    lastData.reason === 'notJobDetail' &&
    lastResolveJobUrls &&
    typeof lastResolveJobUrls === 'object' &&
    Array.isArray(/** @type {any} */ (lastResolveJobUrls).urls)
  ) {
    data = { ...lastResolveJobUrls, scrapeAll: lastData };
  }
  if (
    (data === undefined || data === null) &&
    scenario &&
    scenario.id === 'upwork-collect' &&
    lastResolveJobUrls &&
    typeof lastResolveJobUrls === 'object' &&
    Array.isArray(/** @type {any} */ (lastResolveJobUrls).urls)
  ) {
    data = {
      ...lastResolveJobUrls,
      scrapeAll: {
        skipped: true,
        reason: 'noEvaluateResult',
        message:
          'Terminal data was empty after both steps; retry runScenario (scripting-boundary flake — KI-001 fallback).',
        currentUrl: null,
      },
    };
  }
  const terminal = { runId, ok: true, data };
  try {
    registry.markDone(runId, data);
  } catch {
    // ignore
  }
  return terminal;
}

/**
 * Capture a small, generic, page-visible snapshot from the managed tab before cleanup closes it.
 * This is intentionally not site-specific. It exists for Gate-3 debugging: a failure like
 * `waitForState did not become truthy` is otherwise opaque because the runner closes the tab
 * in `finally`.
 *
 * @param {object} ctx
 * @param {object | null} step
 * @param {unknown} err
 * @returns {Promise<object | undefined>}
 */
async function captureFailureDebug(ctx, step, err) {
  if (!ctx || ctx.tabId == null || !ctx.chrome || !ctx.chrome.tabs) return undefined;
  const debug = {
    stepType: step && step.type,
    stepFn: step && step.fn,
    error: err && typeof err === 'object' ? {
      code: err.code || err.error,
      message: err.errorMessage || err.message,
      phase: err.phase,
    } : { message: String(err) },
  };

  try {
    const tab = await ctx.chrome.tabs.get(ctx.tabId);
    debug.tab = {
      id: tab && tab.id,
      url: tab && tab.url,
      title: tab && tab.title,
      status: tab && tab.status,
    };
  } catch (e) {
    debug.tabError = e && e.message ? String(e.message) : String(e);
  }

  try {
    debug.page = await ctx.injectMain(ctx.tabId, {
      func: () => {
        function textOf(el) {
          return el && el.textContent ? el.textContent.trim().replace(/\s+/g, ' ') : '';
        }
        function findInShadow(root, selector) {
          if (!root || !selector) return null;
          const own = root.querySelector && root.querySelector(selector);
          if (own) return own;
          const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (let i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) {
              const found = findInShadow(all[i].shadowRoot, selector);
              if (found) return found;
            }
          }
          return null;
        }
        function allInShadow(root, selector, out) {
          out = out || [];
          if (!root || !selector) return out;
          if (root.querySelectorAll) out.push(...Array.from(root.querySelectorAll(selector)));
          const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
          for (let i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) allInShadow(all[i].shadowRoot, selector, out);
          }
          return out;
        }

        const modal = findInShadow(document, '.artdeco-modal.share-box-v2__modal');
        const list = findInShadow(document, 'ul.artdeco-list');
        const rows = list
          ? list.querySelectorAll('li.artdeco-list__item.share-post-list-view__item')
          : [];
        const h2s = allInShadow(document, 'h2').map(textOf).filter(Boolean).slice(0, 20);
        const buttons = allInShadow(document, 'button')
          .map((b) => ({
            text: textOf(b).slice(0, 120),
            aria: (b.getAttribute && b.getAttribute('aria-label') || '').slice(0, 160),
            disabled: !!b.disabled,
          }))
          .filter((b) => b.text || b.aria)
          .slice(0, 40);
        const roleButtons = allInShadow(document, '[role="button"]')
          .map((b) => ({
            tag: b.tagName || '',
            text: textOf(b).slice(0, 120),
            aria: (b.getAttribute && b.getAttribute('aria-label') || '').slice(0, 160),
            disabled: !!b.disabled,
          }))
          .filter((b) => b.text || b.aria)
          .slice(0, 40);
        const inputs = allInShadow(document, 'input')
          .map((i) => ({
            id: i.id || '',
            name: i.name || '',
            type: i.type || '',
            placeholder: i.placeholder || '',
            aria: (i.getAttribute && i.getAttribute('aria-label') || ''),
          }))
          .slice(0, 40);
        const broScenarioDiag = globalThis.__broScenarioDiag
          ? JSON.parse(JSON.stringify(globalThis.__broScenarioDiag))
          : null;

        return {
          url: location.href,
          pathname: location.pathname,
          title: document.title,
          readyState: document.readyState,
          bodyTextFirst1000: textOf(document.body).slice(0, 1000),
          modalFound: !!modal,
          modalTextFirst1000: modal ? textOf(modal).slice(0, 1000) : null,
          modalHtmlFirst1000: modal && modal.outerHTML ? modal.outerHTML.slice(0, 1000) : null,
          listFound: !!list,
          listChildren: list ? list.children.length : 0,
          scheduledRowCount: rows.length,
          firstRowHtmlFirst1000: rows[0] && rows[0].outerHTML ? rows[0].outerHTML.slice(0, 1000) : null,
          h2s,
          buttons,
          roleButtons,
          inputs,
          broScenarioDiag,
        };
      },
    });
  } catch (e) {
    debug.pageError = e && e.message ? String(e.message) : String(e);
  }

  return debug;
}

function copyFailureFields(out, terminal) {
  for (const key of ['phase', 'snapshot', 'diag', 'timeoutMs', 'fn', 'url']) {
    if (terminal && terminal[key] != null) out[key] = terminal[key];
  }
  return out;
}

/**
 * @type {Map<string, { ctx: any, resolve: () => void }>}
 */
const _cancelByRun = new Map();
function registerRunCancel(runId, ctx) {
  _cancelByRun.set(runId, {
    ctx,
    resolve: () => {
      if (ctx && ctx._internalResolveCancel) ctx._internalResolveCancel();
    },
  });
}
function unregisterRunCancel(runId) {
  _cancelByRun.delete(runId);
}

/**
 * @param {string} runId
 */
export function cancelRunInProcess(runId) {
  const x = _cancelByRun.get(runId);
  if (x) {
    if (x.ctx) x.ctx.releaseQueuedAcquires();
    x.resolve();
  }
}

export { cancelRunInProcess as cancelRun };

const multiRunState = new Map();

/**
 * @param {object} opts
 * @param {import('./run-registry.js').RunRegistry} opts.registry
 * @param {import('./tab-ownership.js').TabOwnership} opts.ownership
 * @param {import('./tab-budget.js').TabBudget} opts.budget
 * @param {(id: string) => object | undefined} opts.getScenario
 * @param {ReturnType<typeof connect>} [opts.nativeConnection]
 */
export function bindToChrome(opts = {}) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  const registry = opts.registry;
  const ownership = opts.ownership;
  const budget = opts.budget;
  const getScenario = typeof opts.getScenario === 'function' ? opts.getScenario : () => undefined;
  if (!registry || typeof registry.create !== 'function' || !ownership || !budget) return;

  let native;
  try {
    native = opts.nativeConnection ?? connect();
  } catch {
    return;
  }

  function sendToNative(m) {
    try {
      native.send(m);
    } catch {
      // ignore
    }
  }

  /** PRD FR-R1 strict: every agent-originated action gets a reply echoing the same requestId. */
  function requireAgentRequestId(msg) {
    const raw = msg && msg.requestId;
    const rid = typeof raw === 'string' ? raw.trim() : '';
    if (!rid) {
      sendToNative({
        requestId: typeof raw === 'string' ? raw : '',
        ok: false,
        error: 'badRequest',
        errorMessage:
          'requestId is required (non-empty string); set a unique id per agent command (protocol §2.1).',
      });
      return null;
    }
    return rid;
  }

  /**
   * @param {any} msg
   * @param {string} requestId
   * @returns {string | null} trimmed runId
   */
  function requireRunIdString(msg, requestId) {
    const raw = msg && msg.runId;
    const r = typeof raw === 'string' ? raw.trim() : '';
    if (!r) {
      sendToNative({
        requestId,
        ok: false,
        error: 'badRequest',
        errorMessage: 'runId is required (non-empty string) for this action.',
      });
      return null;
    }
    return r;
  }

  const bChrome = typeof globalThis !== 'undefined' && globalThis.chrome && globalThis.chrome.runtime ? globalThis.chrome : null;
  const baseAdapters = { registry, ownership, budget, sendToNative, nativeConnection: native, fileTransfer, chrome: bChrome };

  if (bChrome && bChrome.tabs && bChrome.tabs.onRemoved && typeof bChrome.tabs.onRemoved.addListener === 'function') {
    bChrome.tabs.onRemoved.addListener((tabId) => {
      const fn = globalTabSlotReleasers.get(tabId);
      if (typeof fn === 'function') {
        try {
          fn();
        } catch {
          // ignore
        }
      }
    });
  }

  /** Pick up on-disk `KNOWN_SCENARIO_IDS` + scenario file changes (operator T-6 rig, dev). */
  native.onAction('devReloadExtension', (msg) => {
    if (!requireAgentRequestId(msg)) return;
    sendToNative({ requestId: msg.requestId, ok: true, action: 'devReloadExtensionResult' });
    if (bChrome && bChrome.runtime && typeof bChrome.runtime.reload === 'function') {
      setTimeout(() => bChrome.runtime.reload(), 100);
    }
  });

  /** Gate 3 T-8: set `chrome.storage.local.maxAutomationTabs` without opening SW DevTools. */
  native.onAction('devSetMaxAutomationTabs', (msg) => {
    if (!requireAgentRequestId(msg)) return;
    const v = /** @type {{ value?: number }} */ (msg).value != null ? Number(/** @type {{ value?: number }} */ (msg).value) : 2;
    if (!Number.isFinite(v) || v < 1) {
      sendToNative({ requestId: msg.requestId, ok: false, error: 'internal', errorMessage: 'value must be >= 1' });
      return;
    }
    if (!bChrome || !bChrome.storage || !bChrome.storage.local) {
      sendToNative({ requestId: msg.requestId, ok: false, error: 'internal', errorMessage: 'storage unavailable' });
      return;
    }
    bChrome.storage.local.set({ maxAutomationTabs: Math.floor(v) }, () => {
      const le = bChrome.runtime && bChrome.runtime.lastError;
      if (le) {
        sendToNative({ requestId: msg.requestId, ok: false, error: 'internal', errorMessage: String(le.message) });
        return;
      }
      sendToNative({ requestId: msg.requestId, ok: true, action: 'devSetMaxAutomationTabsResult' });
    });
  });

  native.onAction('runScenario', async (msg) => {
    if (!requireAgentRequestId(msg)) return;
    const scenario = getScenario(msg.scenarioId);
    if (!scenario) {
      sendToNative({ requestId: msg.requestId, ok: false, error: 'scenarioNotFound', errorMessage: 'Unknown scenario' });
      return;
    }
    const terminal = await executeRun({
      scenario,
      params: msg.params || {},
      requestId: msg.requestId,
      adapters: { ...baseAdapters, chrome: bChrome },
    });
    const out = { requestId: msg.requestId, runId: terminal.runId, ok: terminal.ok, action: 'runScenarioResult' };
    if (terminal.ok) {
      out.data = terminal.data;
    } else {
      out.error = terminal.error;
      out.errorMessage = terminal.errorMessage;
      if (terminal.partial != null) out.partial = terminal.partial;
      if (terminal.debug != null) out.debug = terminal.debug;
      copyFailureFields(out, terminal);
    }
    sendToNative(out);
  });

  native.onAction('startRun', async (msg) => {
    if (!requireAgentRequestId(msg)) return;
    const scenario = getScenario(msg.scenarioId);
    if (!scenario) {
      sendToNative({ requestId: msg.requestId, ok: false, error: 'scenarioNotFound' });
      return;
    }
    const runId = registry.create({ scenarioId: msg.scenarioId, requestId: msg.requestId });
    multiRunState.set(runId, { scenario, params: msg.params || {}, requestId: msg.requestId, ctx: null, stepIndex: 0 });
    try {
      registry.setStatus(runId, 'queued');
    } catch {
      // ignore
    }
    sendToNative({ requestId: msg.requestId, ok: true, runId });
  });

  native.onAction('runStep', async (msg) => {
    const rq = requireAgentRequestId(msg);
    if (!rq) return;
    const runId = requireRunIdString(msg, rq);
    if (!runId) return;
    const run = registry.get(runId);
    if (!run) {
      sendToNative({ requestId: rq, runId, ok: false, error: 'runNotFound' });
      return;
    }
    if (run.status === 'done' || run.status === 'cancelled' || run.status === 'error') {
      sendToNative({ requestId: rq, runId, ok: false, error: 'runNotFound' });
      return;
    }
    const state = multiRunState.get(runId);
    if (!state) {
      sendToNative({ requestId: rq, runId, ok: false, error: 'runNotFound' });
      return;
    }
    if (!state.ctx) {
      const ad0 = { ...baseAdapters, chrome: bChrome };
      const ad = await mergeAdaptersWithSessionHostToken(ad0);
      state.ctx = createCtx({
        run,
        scenario: state.scenario,
        params: state.params,
        requestId: state.requestId,
        adapters: ad,
      });
      state.ctx._adapters = ad;
      registerRunCancel(runId, state.ctx);
    }
    const c = state.ctx;
    try {
      registry.setStatus(runId, 'running');
    } catch {
      // ignore
    }
    if (c.isCancelled()) {
      const partial = c.getPartial();
      sendToNative({ requestId: rq, runId, ok: false, error: 'cancelled', errorMessage: 'cancelled', partial });
      return;
    }
    const rPre = await ensureUpworkCollectFirstTabIfNeeded(c, state.params);
    if (!rPre.ok) {
      const out = { requestId: rq, runId, ok: false, error: rPre.error, errorMessage: rPre.errorMessage };
      copyFailureFields(out, rPre);
      sendToNative(out);
      return;
    }
    const r = await executeStep(c, msg.step, state.params);
    if (r && r.ok) {
      try {
        registry.setStep(runId, state.stepIndex, msg.step && msg.step.type);
        state.stepIndex = (state.stepIndex || 0) + 1;
      } catch {
        // ignore
      }
    }
    const out = { requestId: rq, runId, ok: r.ok };
    if (r.ok) out.data = r.data;
    else {
      out.error = r.error;
      out.errorMessage = r.errorMessage;
      copyFailureFields(out, r);
    }
    sendToNative(out);
  });

  native.onAction('getRunStatus', (msg) => {
    const rq = requireAgentRequestId(msg);
    if (!rq) return;
    const runId = requireRunIdString(msg, rq);
    if (!runId) return;
    const run = registry.get(runId);
    if (!run) {
      sendToNative({ requestId: rq, runId, ok: false, error: 'runNotFound' });
      return;
    }
    sendToNative({
      requestId: rq,
      runId,
      ok: true,
      status: run.status,
      currentStepIndex: run.currentStepIndex,
      currentStepType: run.currentStepType,
      startedAt: run.startedAt,
    });
  });

  /**
   * @param {import('./run-registry.js').RunRecord} run
   */
  async function cleanupRunTabs(run) {
    if (!run) return;
    const fromCancel = _cancelByRun.get(run.runId);
    const c = (fromCancel && fromCancel.ctx) || (multiRunState.get(run.runId) && multiRunState.get(run.runId).ctx);
    if (c) {
      c.releaseQueuedAcquires();
    }
    cancelRunInProcess(run.runId);
    if (c && run.ownedTabs) {
      const tids = [...run.ownedTabs];
      for (const tid of tids) {
        try {
          await c.closeTab(tid);
        } catch {
          // ignore
        }
      }
    }
  }

  native.onAction('cancelRun', async (msg) => {
    const rq = requireAgentRequestId(msg);
    if (!rq) return;
    const runId = requireRunIdString(msg, rq);
    if (!runId) return;
    const run = registry.get(runId);
    if (!run) {
      sendToNative({ requestId: rq, runId, ok: false, error: 'runNotFound' });
      return;
    }
    const st = multiRunState.get(runId);
    const x = _cancelByRun.get(runId);
    const c = (x && x.ctx) || (st && st.ctx);
    if (c) c.releaseQueuedAcquires();
    cancelRunInProcess(runId);
    const partial = c ? c.getPartial() : run.partial;
    try {
      await cleanupRunTabs(run);
    } catch {
      // ignore
    }
    try {
      registry.markCancelled(runId);
    } catch {
      // ignore
    }
    multiRunState.delete(runId);
    sendToNative({
      requestId: rq,
      runId,
      ok: false,
      error: 'cancelled',
      errorMessage: 'cancelled',
      partial: partial == null ? undefined : partial,
    });
  });

  native.onAction('endRun', async (msg) => {
    const rq = requireAgentRequestId(msg);
    if (!rq) return;
    const runId = requireRunIdString(msg, rq);
    if (!runId) return;
    const run = registry.get(runId);
    if (!run) {
      sendToNative({ requestId: rq, runId, ok: false, error: 'runNotFound' });
      return;
    }
    if (['running', 'queued', 'cancelling'].includes(run.status)) {
      const st = multiRunState.get(runId);
      const y = _cancelByRun.get(runId);
      const c = (y && y.ctx) || (st && st.ctx);
      if (c) c.releaseQueuedAcquires();
      cancelRunInProcess(runId);
      try {
        await cleanupRunTabs(run);
      } catch {
        // ignore
      }
      try {
        registry.markCancelled(runId);
      } catch {
        // ignore
      }
      multiRunState.delete(runId);
      sendToNative({ requestId: rq, runId, ok: true });
      return;
    }
    if (['done', 'cancelled', 'error'].includes(run.status)) {
      const out = { requestId: rq, runId, ok: true };
      if (run.status === 'error' && run.partial) out.partial = run.partial;
      sendToNative(out);
      return;
    }
    sendToNative({
      requestId: rq,
      runId,
      ok: false,
      error: 'internal',
      errorMessage: `unexpected run status: ${String(run.status)}`,
    });
  });
}

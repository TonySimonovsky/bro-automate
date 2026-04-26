// Shared test helpers for step-runner and step module tests.
// v0.01 — Wave 3

/**
 * @returns {object} Minimal chrome API fake with call log arrays.
 */
export function makeFakeChrome() {
  const calls = {
    tabs: { create: [], update: [], get: [], remove: [] },
    scripting: { executeScript: [] },
    storage: { local: { get: [] }, session: { set: [] } },
    alarms: { create: [], clear: [] },
  };
  return {
    _calls: calls,
    runtime: {
      id: 'test-ext',
      lastError: null,
    },
    tabs: {
      create(props, cb) {
        calls.tabs.create.push([props, cb]);
        const tab = { id: 1, url: (props && props.url) || 'about:blank' };
        if (cb) {
          setTimeout(() => cb(tab), 0);
        }
        return tab;
      },
      update(id, props, cb) {
        calls.tabs.update.push([id, props, cb]);
        if (cb) {
          setTimeout(() => cb({ id, url: props && props.url }), 0);
        }
      },
      get(id, cb) {
        calls.tabs.get.push([id, cb]);
        if (cb) {
          setTimeout(
            () =>
              cb({
                id,
                url: 'https://example.com/path',
              }),
            0,
          );
        }
      },
      remove(id, cb) {
        calls.tabs.remove.push([id, cb]);
        if (cb) {
          setTimeout(() => cb(), 0);
        }
      },
    },
    scripting: {
      executeScript(inj, cb) {
        calls.scripting.executeScript.push([inj, cb]);
        if (cb) {
          setTimeout(() => cb([{ result: undefined }]), 0);
        }
      },
    },
    storage: {
      local: { get: (_k, cb) => cb && cb({}) },
      session: { set: (o) => calls.storage.session.set.push(o) },
    },
    alarms: {
      create: (n, o) => calls.alarms.create.push([n, o]),
      clear: (n) => calls.alarms.clear.push(n),
    },
  };
}

import { RunRegistry } from '../extension/lib/run-registry.js';
import { TabBudget } from '../extension/lib/tab-budget.js';
import { TabOwnership } from '../extension/lib/tab-ownership.js';

/**
 * @param {object} [overrides]
 * @returns {object} { run, scenario, params, requestId, adapters, registry, budget, ownership, chrome } for createCtx(…)
 */
export function makeCtx(overrides = {}) {
  const ch = overrides.chrome || makeFakeChrome();
  const registry = overrides.registry || new RunRegistry();
  const budget = overrides.budget || new TabBudget();
  const ownership = overrides.ownership || new TabOwnership();
  const requestId = overrides.requestId || 't-req';
  const run = overrides.run;
  if (run) {
    const scenario = overrides.scenario || { id: 't', matches: ['https://example.com/*'], steps: [] };
    return {
      run,
      scenario,
      params: overrides.params || {},
      requestId,
      registry,
      budget,
      ownership,
      chrome: ch,
      adapters: {
        registry,
        budget,
        ownership,
        chrome: ch,
        sendToNative: overrides.sendToNative,
        fileTransfer: overrides.fileTransfer,
        ...overrides.adapters,
      },
    };
  }
  const runId = registry.create({ scenarioId: 't', requestId });
  const r = registry.get(runId);
  if (!r) {
    throw new Error('makeCtx: registry create failed');
  }
  const scenario = overrides.scenario || {
    id: 't',
    matches: [overrides.matchPattern || 'https://example.com/*'],
    steps: [],
  };
  return {
    run: r,
    scenario,
    params: overrides.params || {},
    requestId,
    registry,
    budget,
    ownership,
    chrome: ch,
    adapters: {
      registry,
      budget,
      ownership,
      chrome: ch,
      sendToNative: overrides.sendToNative,
      fileTransfer: overrides.fileTransfer,
      ...overrides.adapters,
    },
  };
}

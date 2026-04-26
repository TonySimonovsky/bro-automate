// background.js — MV3 service-worker entry; thin glue.
// TDD: §3, §7 (service worker), §7.1 (startup sequence)
// Tasks: T-401 + Wave-5 fix (C1: wire step-runner to native bridge so runScenario / startRun /
//        runStep / getRunStatus / cancelRun / endRun actions actually have handlers in real
//        Chrome, and persist the loadAll() scenarios map so getScenario(id) can resolve).
// Wave: 2 (impl) + 5 (wiring)
// Status: implemented (Wave 2); patched (Wave 5)

import { connect } from './lib/native-bridge.js';
import { bindToChrome as bindNativeBridge } from './lib/native-bridge.js';
import { RunRegistry, bindToChrome as bindRunRegistry } from './lib/run-registry.js';
import { TabBudget, bindToChrome as bindTabBudget } from './lib/tab-budget.js';
import { TabOwnership, bindToChrome as bindTabOwnership } from './lib/tab-ownership.js';
import { bindToChrome as bindBadge, setBadge } from './lib/badge.js';
import * as log from './lib/log.js';
import { bindToChrome as bindLog, setMirror } from './lib/log.js';
import { bindToChrome as bindSchemaValidator } from './lib/schema-validator.js';
import { loadAll, bindToChrome as bindScenarioLoader } from './lib/scenario-loader.js';
import { bindToChrome as bindStepRunner } from './lib/step-runner.js';
import { getStepRunnerDiag, matchesAllowed } from './lib/step-runner.js';

const BRO_DIAG_BUILD = 'gate3-linkedin-text-fallback-2026-04-25-k';

bindNativeBridge();
bindSchemaValidator();
bindLog();
bindScenarioLoader();

const runRegistry = new RunRegistry();
const tabBudget = new TabBudget();
const tabOwnership = new TabOwnership();

bindRunRegistry({ registry: runRegistry });
bindTabOwnership({ ownership: tabOwnership });
bindBadge({ registry: runRegistry });

/** @type {ReturnType<typeof connect> | null} */
let nativeConn = null;

try {
  nativeConn = connect();
} catch (e) {
  log.error('native-bridge', {}, String(e));
}

setMirror((envelope) => {
  try {
    nativeConn?.send(envelope);
  } catch {
    // ignore
  }
});

if (nativeConn) {
  nativeConn.onEvent('hostReady', (msg) => {
    if (msg.httpPort != null && msg.token != null) {
      chrome.storage.session.set({
        broHttpPort: msg.httpPort,
        broHttpToken: msg.token,
      });
    }
  });
}

bindTabBudget({
  budget: tabBudget,
  onWaiting: ({ runId, requestId }) => {
    const rec = runId ? runRegistry.get(runId) : undefined;
    nativeConn?.send({
      event: 'runProgress',
      requestId,
      runId,
      scenarioId: rec && rec.scenarioId,
      data: { subEvent: 'waitingForTabSlot' },
    });
  },
});

setBadge({ active: false, count: 0 });

// C1: persist the scenarios map across initScenarios + provide getScenario(id) to step-runner.
// Without this, runScenario / startRun receive scenarioId but cannot resolve it because
// scenario-loader's result was previously dropped on the floor.
/** @type {Map<string, object>} */
const scenarios = new Map();
function getScenario(id) {
  return scenarios.get(id);
}

globalThis.__BRO_DIAG = {
  build: BRO_DIAG_BUILD,
  extensionId: chrome.runtime.id,
  backgroundUrl: chrome.runtime.getURL('background.js'),
  manifestVersion: chrome.runtime.getManifest?.().version,
  loadedAt: new Date().toISOString(),
  matchesAllowedProbe() {
    return {
      url: 'http://127.0.0.1:8766/',
      patterns: ['http://127.0.0.1/*'],
      allowed: matchesAllowed('http://127.0.0.1:8766/', ['http://127.0.0.1/*']),
      sourceHasPortlessLocalhostBranch: String(matchesAllowed).includes('pattern.port === \'\''),
    };
  },
  scenarioProbe(id = 'local-smoke') {
    const scenario = scenarios.get(id);
    return {
      id,
      loaded: Boolean(scenario),
      scenarioCount: scenarios.size,
      matches: Array.isArray(scenario?.matches) ? scenario.matches : null,
      firstNavigateUrl: scenario?.steps?.find?.((step) => step?.type === 'navigate')?.url ?? null,
      allowed: scenario
        ? matchesAllowed(
            scenario.steps?.find?.((step) => step?.type === 'navigate')?.url,
            Array.isArray(scenario.matches) ? scenario.matches : [],
          )
        : null,
    };
  },
  stepRunnerProbe() {
    return getStepRunnerDiag();
  },
};
console.info('[bro-diag] loaded', globalThis.__BRO_DIAG.build, globalThis.__BRO_DIAG.matchesAllowedProbe());

// C1: wire the step-runner action handlers to the live native connection. Per
// pm/build/v.0.01/protocol.md §3.2-§3.7 the handlers cover runScenario, startRun, runStep,
// getRunStatus, cancelRun, endRun. The runner also reads `chrome` and `fileTransfer`
// from the adapters constructed inside its bindToChrome.
if (nativeConn) {
  bindStepRunner({
    registry: runRegistry,
    ownership: tabOwnership,
    budget: tabBudget,
    getScenario,
    nativeConnection: nativeConn,
  });
}

async function initScenarios() {
  try {
    const schemaUrl = chrome.runtime.getURL('scenario.schema.json');
    const schema = await (await fetch(schemaUrl)).json();
    const result = await loadAll({
      fetchScenarioJson: async (id) => {
        const u = chrome.runtime.getURL(`scenarios/${id}/scenario.json`);
        return (await fetch(u)).json();
      },
      schema,
    });
    // C1: persist the loaded scenarios so getScenario() can serve them to the runner.
    if (result && result.scenarios && typeof result.scenarios.forEach === 'function') {
      result.scenarios.forEach((sc, id) => scenarios.set(id, sc));
    }
    if (result && Array.isArray(result.skipped) && result.skipped.length > 0) {
      log.warn('scenario-loader', { skipped: result.skipped.length }, 'some scenarios were skipped');
    }
    log.info(
      'scenario-loader',
      { loaded: scenarios.size },
      'scenario layer initialized',
    );
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
    log.error('scenario-loader', { code }, String(e));
    if (code === 'duplicateScenarioId') {
      setBadge({ active: true, count: 1 });
    }
  }
}

initScenarios();

// Keep the MV3 service worker warm enough for local CLI users. Without this, Chrome may
// idle the service worker, close the native-messaging port, terminate the host, and remove
// /tmp/aichamp-bro-automate.sock between operator CLI commands. The offscreen document sends
// a tiny runtime message every 20s; page JS cannot observe it.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.event === 'broOffscreenKeepalive') {
    return false;
  }
  return false;
});

async function ensureOffscreenKeepalive() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) return;
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  try {
    let hasDocument = false;
    if (typeof chrome.offscreen.hasDocument === 'function') {
      hasDocument = await chrome.offscreen.hasDocument();
    } else if (self.clients && typeof self.clients.matchAll === 'function') {
      const clients = await self.clients.matchAll();
      hasDocument = clients.some((client) => client.url === offscreenUrl);
    }
    if (hasDocument) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      // Chrome validates this enum. `WORKERS` is not accepted on stable Chrome; use a
      // broadly supported reason. The document's practical purpose is still just to
      // keep the service worker warm for local native-messaging CLI calls.
      reasons: ['BLOBS'],
      justification: 'Keep the local native-messaging bridge available for CLI clients.',
    });
  } catch (e) {
    // If Chrome rejects offscreen creation (older version / duplicate race), keep the extension
    // usable; the CLI has its own retry and will report a clear socket error if the host is down.
    log.warn('offscreen', {}, String(e));
  }
}

ensureOffscreenKeepalive();

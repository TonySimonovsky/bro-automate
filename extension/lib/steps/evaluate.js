// steps/evaluate.js — call a named function exported by the scenario's scenario.js via the
// two-stage MAIN-world install + invoke protocol (TDD §7.6). Threads args + returns JSON.
// Errors: matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6
// Tasks: T-510
// Wave: 3
// Status: implemented (Wave 3)

export const EVALUATE_DIAG_BUILD = 'evaluate-progress-debug-2026-04-25-e';

/**
 * @param {object} ctx
 * @param {{ type: 'evaluate', fn: string, args?: object }} step
 * @param {object} _params run params (`runScenario` / `startRun`); merged into `step.args` for the scenario `fn` call
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'evaluate requires a tab',
    };
  }
  if (ctx.scenario.module === undefined) {
    throw {
      code: 'internal',
      message: 'evaluate requires scenario.module',
    };
  }
  const tabId = ctx.tabId;
  const scenarioId = ctx.scenarioId;
  const filePath = 'scenarios/' + scenarioId + '/scenario.js';

  try {
    await raceWithCancel(
      ctx.cancelToken,
      'cancelled during evaluate',
      ctx.injectMain(tabId, { files: [filePath] }),
    );
  } catch (err) {
    if (isPassThroughStepError(err)) throw err;
    const msg = err instanceof Error ? err.message : err && err.message != null ? err.message : String(err);
    throw {
      code: 'internal',
      message: 'failed to install scenario.js: ' + msg,
    };
  }

  const runParams = _params && typeof _params === 'object' ? _params : {};
  const stepArgs = step.args && typeof step.args === 'object' ? step.args : {};
  /** Run params (e.g. `source`, `jobIds`, `limit`) + per-step overrides from scenario.json (step wins on key clash). */
  const evalArgs = { ...runParams, ...stepArgs };

  let result;
  let evalDebug = null;
  try {
    const invoked = await raceWithCancel(
      ctx.cancelToken,
      'cancelled during evaluate',
      ctx.injectMain(tabId, {
        // Explicitly await async scenario helpers and JSON-clone the result before it
        // crosses the chrome.scripting boundary. Without this, helpers that return a
        // Promise can arrive as null/undefined in the service worker on some Chrome
        // versions, which made LinkedIn's async row-waiting extractor return data:null.
        func: async (id, name, args) => {
          function cloneJson(value) {
            if (value === undefined) return null;
            return JSON.parse(JSON.stringify(value));
          }
          function normalizeThrown(err) {
            if (err && typeof err === 'object') {
              const out = {
                code: typeof err.code === 'string' ? err.code : 'internal',
                message: err.message != null ? String(err.message) : String(err.code || 'scenario function failed'),
              };
              for (const key of Object.keys(err)) {
                if (key !== 'code' && key !== 'message') out[key] = err[key];
              }
              return cloneJson(out);
            }
            return { code: 'internal', message: String(err) };
          }
          const mod = globalThis['__broScenario_' + id];
          if (!mod || typeof mod[name] !== 'function') {
            throw new Error('scenario function not found: ' + name);
          }
          let value;
          try {
            value = await mod[name](args);
          } catch (err) {
            const diag = globalThis.__broScenarioDiag && globalThis.__broScenarioDiag[id]
              ? cloneJson(globalThis.__broScenarioDiag[id])
              : null;
            return {
              broEvaluateThrown: true,
              error: normalizeThrown(err),
              debug: {
                fn: name,
                thrown: normalizeThrown(err),
                sourceHasRecordDiag: String(mod[name]).indexOf('recordDiag') !== -1,
                diag,
              },
            };
          }
          const normalized = cloneJson(value);
          if (id !== 'linkedin-scheduled-posts') return normalized;
          const diag = globalThis.__broScenarioDiag && globalThis.__broScenarioDiag[id]
            ? cloneJson(globalThis.__broScenarioDiag[id])
            : null;
          return {
            broEvaluateDebug: true,
            value: normalized,
            debug: {
              fn: name,
              result: normalized,
              sourceHasRecordDiag: String(mod[name]).indexOf('recordDiag') !== -1,
              diag,
            },
          };
        },
        args: [scenarioId, step.fn, evalArgs],
      }),
    );
    if (invoked && invoked.broEvaluateThrown) {
      evalDebug = invoked.debug || null;
      if (scenarioId === 'linkedin-scheduled-posts' && evalDebug && typeof ctx.appendPartial === 'function') {
        ctx.appendPartial({ type: 'evaluateDebug', ...evalDebug });
      }
      if (scenarioId === 'linkedin-scheduled-posts' && evalDebug && typeof ctx.sendProgress === 'function') {
        ctx.sendProgress({ subEvent: 'evaluateDebug', ...evalDebug });
      }
      throw invoked.error || { code: 'internal', message: 'scenario function failed' };
    }
    if (invoked && invoked.broEvaluateDebug) {
      evalDebug = invoked.debug || null;
      result = invoked.value;
    } else {
      result = invoked;
    }
    // Lost MAIN-world results used to surface as { ok: true, data: undefined } → terminal `data: null`
    // (same class as LinkedIn async; see KI-001). `null` may still be a deliberate JSON value.
    if (result === undefined) {
      throw {
        code: 'internal',
        message:
          'evaluate script returned undefined (chrome.scripting result missing); retry runScenario — often a transient MV3 boundary flake.',
      };
    }
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw { code: 'internal', message: msg };
  }
  if (scenarioId === 'linkedin-scheduled-posts' && evalDebug && typeof ctx.sendProgress === 'function') {
    ctx.sendProgress({ subEvent: 'evaluateDebug', ...evalDebug });
  }
  return result;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isPassThroughStepError(err) {
  return (
    err != null &&
    typeof err === 'object' &&
    'code' in err &&
    (err.code === 'cancelled' || err.code === 'tabClosedDuringStep')
  );
}

/**
 * @template T
 * @param {Promise<{ cancelled?: true }>} cancelToken
 * @param {string} cancelMessage
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function raceWithCancel(cancelToken, cancelMessage, promise) {
  return Promise.race([
    promise,
    cancelToken.then(() => {
      throw { code: 'cancelled', message: cancelMessage };
    }),
  ]);
}

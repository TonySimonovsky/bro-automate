// steps/wait-for-state.js — call scenario.js predicate via two-stage MAIN-world install + invoke
// (TDD §7.6); resolve when truthy.
// Errors: selectorTimeout, matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6, §10
// Tasks: T-503
// Wave: 3
// Status: implemented (Wave 3)

/**
 * @param {string} id
 * @param {string} name
 * @param {object} args
 */
function pollScenarioPredicate(id, name, args) {
  try {
    return Boolean(globalThis['__broScenario_' + id][name](args));
  } catch {
    return false;
  }
}

/**
 * @param {object} ctx
 * @param {{ type: 'waitForState', fn: string, args?: object, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'waitForState requires a tab',
    };
  }
  if (ctx.scenario.module == null || ctx.scenario.module === '') {
    throw {
      code: 'internal',
      message: 'waitForState requires scenario.module',
    };
  }

  const tabId = ctx.tabId;
  const scenarioPath = 'scenarios/' + ctx.scenarioId + '/scenario.js';
  await raceWithCancel(
    ctx.cancelToken,
    'cancelled during waitForState (install)',
    ctx.injectMain(tabId, { files: [scenarioPath] }),
  );

  const timeoutMs = step.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  let done = false;

  while (Date.now() < deadline) {
    const truthy = await raceWithCancel(
      ctx.cancelToken,
      'cancelled during waitForState',
      ctx.injectMain(tabId, {
        func: pollScenarioPredicate,
        args: [ctx.scenarioId, step.fn, step.args ?? {}],
      }),
    );
    if (truthy) {
      done = true;
      break;
    }
    const sleepMs = Math.min(200, deadline - Date.now());
    if (sleepMs <= 0) {
      break;
    }
    await raceWithCancel(
      ctx.cancelToken,
      'cancelled during waitForState',
      new Promise((r) => setTimeout(r, sleepMs)),
    );
  }

  if (!done) {
    throw {
      code: 'selectorTimeout',
      message:
        'waitForState fn ' +
        step.fn +
        ' did not become truthy in ' +
        timeoutMs +
        'ms',
      fn: step.fn,
      timeoutMs,
    };
  }

  return { done: true, fn: step.fn };
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

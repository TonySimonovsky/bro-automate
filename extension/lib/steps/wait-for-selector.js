// steps/wait-for-selector.js — MAIN-world poll/observer; configurable timeout.
// Errors: selectorTimeout, matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6, §10
// Tasks: T-501
// Wave: 3
// Status: implemented (Wave 3)

/**
 * Runs in MAIN world: polls until selector matches or deadline.
 * @param {string} selector
 * @param {number} timeoutMs
 */
async function pollForSelector(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (document.querySelector(selector)) {
      return { found: true };
    }
    if (Date.now() >= deadline) {
      throw {
        code: 'selectorTimeout',
        message:
          'Timed out waiting for selector ' + selector + ' (' + timeoutMs + 'ms)',
        selector,
        timeoutMs,
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * @param {object} ctx
 * @param {{ type: 'waitForSelector', selector: string, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'waitForSelector requires a tab',
    };
  }
  const timeoutMs = step.timeoutMs ?? 15_000;
  const tabId = ctx.tabId;
  await raceWithCancel(
    ctx.cancelToken,
    'cancelled during waitForSelector',
    ctx.injectMain(tabId, {
      func: pollForSelector,
      args: [step.selector, timeoutMs],
    }),
  );
  return { found: true, selector: step.selector };
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

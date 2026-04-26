// steps/screenshot.js — chrome.tabs.captureVisibleTab for viewport; element-bounds variant
// optional. Returns base64 in the step result.
// Errors: matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6
// Tasks: T-513
// Wave: 3
// Status: implemented (Wave 3)

/**
 * @param {object} ctx
 * @param {{ type: 'screenshot', selector?: string, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'screenshot requires a tab',
    };
  }
  const timeoutMs = step.timeoutMs ?? 10_000;
  const cancelMessage = 'cancelled during screenshot';

  let tab;
  try {
    tab = await raceWithCancel(
      ctx.cancelToken,
      cancelMessage,
      ctx.chrome.tabs.get(ctx.tabId),
    );
  } catch (e) {
    if (e && typeof e === 'object' && e.code === 'cancelled') {
      throw e;
    }
    throw {
      code: 'tabClosedDuringStep',
      message: 'tab missing during screenshot',
    };
  }
  if (!tab) {
    throw {
      code: 'tabClosedDuringStep',
      message: 'tab missing during screenshot',
    };
  }
  const windowId = tab.windowId;

  const dataUrl = await raceWithTimeout(
    raceWithCancel(
      ctx.cancelToken,
      cancelMessage,
      ctx.chrome.tabs.captureVisibleTab(windowId, { format: 'png' }),
    ),
    timeoutMs,
  );

  const result = { format: 'png', dataUrl };
  if (step.selector) {
    result.note = 'element-bounds capture not implemented in v0.01';
  }
  return result;
}

/**
 * Races a promise with a wall-clock timeout, clearing the timer when the work settles.
 * @template T
 * @param {Promise<T>} work
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
function raceWithTimeout(work, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject({ code: 'internal', message: 'screenshot timed out' }),
      timeoutMs,
    );
    work.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
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

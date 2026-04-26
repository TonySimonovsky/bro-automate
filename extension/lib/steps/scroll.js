// steps/scroll.js — scroll selector or window by px or intoView.
// Errors: selectorTimeout, matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6
// Tasks: T-508
// Wave: 3
// Status: implemented (Wave 3)

/**
 * @param {string | undefined} selector
 * @param {boolean | undefined} intoView
 * @param {number | undefined} deltaX
 * @param {number | undefined} deltaY
 */
async function scrollInPage(selector, intoView, deltaX, deltaY) {
  const dx = deltaX ?? 0;
  const dy = deltaY ?? 0;

  if (intoView === true && selector) {
    const el = document.querySelector(selector);
    if (!el) {
      throw {
        code: 'selectorTimeout',
        message: 'scroll intoView: element not found for selector',
        selector,
      };
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise((r) => setTimeout(r, 250));
    return { scrolled: true };
  }

  if (selector) {
    const el = document.querySelector(selector);
    if (!el) {
      throw {
        code: 'selectorTimeout',
        message: 'scroll: element not found for selector',
        selector,
      };
    }
    el.scrollBy({ left: dx, top: dy, behavior: 'auto' });
    return { scrolled: true };
  }

  window.scrollBy({ left: dx, top: dy, behavior: 'auto' });
  return { scrolled: true };
}

/**
 * @param {object} ctx
 * @param {{
 *   type: 'scroll',
 *   selector?: string,
 *   intoView?: boolean,
 *   deltaX?: number,
 *   deltaY?: number,
 *   timeoutMs?: number,
 * }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'scroll requires a tab',
    };
  }
  const timeoutMs = step.timeoutMs ?? 10_000;
  const tabId = ctx.tabId;

  return await raceWithCancel(
    ctx.cancelToken,
    'cancelled during scroll',
    raceWithTimeout(
      timeoutMs,
      ctx.injectMain(tabId, {
        func: scrollInPage,
        args: [
          step.selector,
          step.intoView,
          step.deltaX,
          step.deltaY,
        ],
      }),
    ),
  );
}

/**
 * @template T
 * @param {number} ms
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function raceWithTimeout(ms, promise) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject({
        code: 'selectorTimeout',
        message: 'scroll timed out after ' + ms + 'ms',
        timeoutMs: ms,
      });
    }, ms);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
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

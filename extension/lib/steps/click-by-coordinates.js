// steps/click-by-coordinates.js — synthetic mouse events at viewport coords (last-resort for
// shadow DOM). PRD §5.4.
// Errors: matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6
// Tasks: T-505
// Wave: 3
// Status: implemented (Wave 3)

/**
 * MAIN world: full pointer/mouse sequence at (x, y).
 * @param {number} x
 * @param {number} y
 */
function clickAtFn(x, y) {
  const el = document.elementFromPoint(x, y);
  if (el == null) {
    return { clicked: false, reason: 'noElementAtPoint' };
  }
  const init = { clientX: x, clientY: y, bubbles: true, cancelable: true };
  el.dispatchEvent(new PointerEvent('pointerdown', init));
  el.dispatchEvent(new MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerEvent('pointerup', init));
  el.dispatchEvent(new MouseEvent('mouseup', init));
  el.dispatchEvent(new MouseEvent('click', init));
  return { clicked: true, target: { tag: el.tagName, x, y } };
}

/**
 * @param {object} ctx
 * @param {{ type: 'clickByCoordinates', x: number, y: number, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'clickByCoordinates requires a tab',
    };
  }
  const tabId = ctx.tabId;
  return await raceWithCancel(
    ctx.cancelToken,
    'cancelled during clickByCoordinates',
    ctx.injectMain(tabId, {
      func: clickAtFn,
      args: [step.x, step.y],
    }),
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

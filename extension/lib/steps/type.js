// steps/type.js — type into selector; optional clear: true.
// Errors: selectorTimeout, matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6
// Tasks: T-506
// Wave: 3
// Status: implemented (Wave 3)

/**
 * MAIN world: focus, optional clear via native value setter, append text, dispatch events.
 * @param {string} selector
 * @param {string} text
 * @param {boolean} clear
 */
function typeFn(selector, text, clear) {
  const el = document.querySelector(selector);
  if (!el) {
    throw {
      code: 'selectorTimeout',
      message: 'selector not found',
    };
  }
  el.focus();
  const desc = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
  if (clear && desc && typeof desc.set === 'function') {
    desc.set.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const current = el.value;
  if (desc && typeof desc.set === 'function') {
    desc.set.call(el, current + text);
  } else {
    el.value = current + text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { typed: text, cleared: clear === true, intoSelector: selector };
}

/**
 * @param {object} ctx
 * @param {{ type: 'type', selector: string, text: string, clear?: boolean, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'type requires a tab',
    };
  }
  const tabId = ctx.tabId;
  return await raceWithCancel(
    ctx.cancelToken,
    'cancelled during type',
    ctx.injectMain(tabId, {
      func: typeFn,
      args: [step.selector, step.text, step.clear === true],
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

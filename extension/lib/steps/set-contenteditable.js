// steps/set-contenteditable.js — focus + insert text + dispatch input event into a
// contenteditable element (rich text editor).
// Errors: selectorTimeout, matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6
// Tasks: T-507
// Wave: 3
// Status: implemented (Wave 3)

/**
 * MAIN world: clear, insert via execCommand or textContent fallback, dispatch input.
 * @param {string} selector
 * @param {string} text
 */
function setContenteditableFn(selector, text) {
  const el = document.querySelector(selector);
  if (!el) {
    throw {
      code: 'selectorTimeout',
      message: 'selector not found',
    };
  }
  el.focus();
  el.textContent = '';
  let ok = false;
  try {
    if (typeof document.execCommand === 'function') {
      ok = document.execCommand('insertText', false, text) === true;
    }
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    el.textContent = text;
  }
  el.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText' }),
  );
  return { inserted: text, intoSelector: selector };
}

/**
 * @param {object} ctx
 * @param {{ type: 'setContenteditable', selector: string, text: string, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'setContenteditable requires a tab',
    };
  }
  const tabId = ctx.tabId;
  return await raceWithCancel(
    ctx.cancelToken,
    'cancelled during setContenteditable',
    ctx.injectMain(tabId, {
      func: setContenteditableFn,
      args: [step.selector, step.text],
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

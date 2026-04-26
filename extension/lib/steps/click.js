// steps/click.js — click element by CSS selector or { text: "..." }.
// Errors: selectorTimeout, matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6, §10
// Tasks: T-504
// Wave: 3
// Status: implemented (Wave 3)

/**
 * MAIN world: poll until clickable target found, then el.click().
 * @param {string | null} selector
 * @param {string | null} text
 * @param {number} timeoutMs
 */
async function clickFn(selector, text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let el = null;
    if (selector) {
      el = document.querySelector(selector);
    } else if (text != null) {
      const nodes = document.querySelectorAll(
        'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"]',
      );
      for (const n of nodes) {
        if (!n.textContent.trim().includes(text)) continue;
        if (n.offsetParent === null) continue;
        el = n;
        break;
      }
    }
    if (el) {
      el.click();
      return { clicked: true, by: selector ? 'selector' : 'text' };
    }
    if (Date.now() >= deadline) {
      throw {
        code: 'selectorTimeout',
        message: 'click target not found within ' + timeoutMs + 'ms',
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * @param {object} ctx
 * @param {{ type: 'click', selector?: string, text?: string, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'click requires a tab',
    };
  }
  const hasSelector = step.selector != null && step.selector !== '';
  const hasText = step.text != null && step.text !== '';
  if (!hasSelector && !hasText) {
    throw {
      code: 'internal',
      message: 'click requires selector or text',
    };
  }
  const timeoutMs = step.timeoutMs ?? 10_000;
  const tabId = ctx.tabId;
  return await raceWithCancel(
    ctx.cancelToken,
    'cancelled during click',
    ctx.injectMain(tabId, {
      func: clickFn,
      args: [hasSelector ? step.selector : null, hasText ? step.text : null, timeoutMs],
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

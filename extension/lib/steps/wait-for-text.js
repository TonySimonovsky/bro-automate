// steps/wait-for-text.js — wait until any element's text content matches a string.
// Errors: selectorTimeout, matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6, §10
// Tasks: T-502
// Wave: 3
// Status: implemented (Wave 3)

/**
 * Runs in MAIN world: polls until body text includes `text` or deadline.
 * @param {string} text
 * @param {number} timeoutMs
 */
async function pollForText(text, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = document.body;
    if (body && body.innerText.includes(text)) {
      return { found: true };
    }
    if (Date.now() >= deadline) {
      throw {
        code: 'selectorTimeout',
        message:
          'Timed out waiting for text (' + timeoutMs + 'ms)',
        text,
        timeoutMs,
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * @param {object} ctx
 * @param {{ type: 'waitForText', text: string, timeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'waitForText requires a tab',
    };
  }
  const timeoutMs = step.timeoutMs ?? 15_000;
  const tabId = ctx.tabId;
  await raceWithCancel(
    ctx.cancelToken,
    'cancelled during waitForText',
    ctx.injectMain(tabId, {
      func: pollForText,
      args: [step.text, timeoutMs],
    }),
  );
  return { found: true, text: step.text };
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

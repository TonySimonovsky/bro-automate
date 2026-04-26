// steps/extract.js — declarative field extraction by CSS; supports multiple: true for repeating
// rows. PRD §5.4.
// Errors: matchesRefused, tabClosedDuringStep, internal.
// TDD: §7.6
// Tasks: T-509
// Wave: 3
// Status: implemented (Wave 3)

/**
 * @param {string | null} rootSelector
 * @param {Array<{ name: string, selector: string, attr?: string }>} fields
 * @param {boolean} multiple
 */
function extractFn(rootSelector, fields, multiple) {
  if (multiple && rootSelector == null) {
    throw {
      code: 'internal',
      message: 'multiple:true requires a rootSelector',
    };
  }

  /**
   * @param {Document | Element} scope
   */
  function scopeToObject(scope) {
    const out = {};
    for (const f of fields) {
      const el = scope.querySelector(f.selector);
      if (!el) {
        out[f.name] = null;
        continue;
      }
      out[f.name] = f.attr
        ? el.getAttribute(f.attr)
        : el.textContent.trim();
    }
    return out;
  }

  if (!multiple) {
    const root =
      rootSelector == null
        ? document
        : document.querySelector(rootSelector);
    if (rootSelector != null && !root) {
      const empty = {};
      for (const f of fields) {
        empty[f.name] = null;
      }
      return empty;
    }
    return scopeToObject(/** @type {Document | Element} */ (root));
  }

  const nodes = document.querySelectorAll(rootSelector);
  const list = [];
  nodes.forEach((el) => list.push(scopeToObject(el)));
  return list;
}

/**
 * @param {object} ctx
 * @param {{
 *   type: 'extract',
 *   selector?: string,
 *   fields: Array<{ name: string, selector: string, attr?: string }>,
 *   multiple?: boolean,
 *   timeoutMs?: number,
 * }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'extract requires a tab',
    };
  }
  const timeoutMs = step.timeoutMs ?? 5000;
  const tabId = ctx.tabId;

  const raw = await raceWithCancel(
    ctx.cancelToken,
    'cancelled during extract',
    raceWithTimeout(
      timeoutMs,
      ctx.injectMain(tabId, {
        func: extractFn,
        args: [
          step.selector ?? null,
          step.fields,
          step.multiple === true,
        ],
      }),
    ),
  );

  let result;
  try {
    result = JSON.parse(JSON.stringify(raw));
  } catch {
    throw {
      code: 'internal',
      message: 'extract result is not JSON-serialisable',
    };
  }

  ctx.appendPartial(result);
  return result;
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
        message: 'extract timed out after ' + ms + 'ms',
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

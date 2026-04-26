// steps/navigate.js — open or navigate a tab to a URL (must match scenario `matches`).
// Uses chrome.tabs.update or chrome.tabs.create; tracks ownership via tab-ownership.js.
// Errors: navigationBlocked, loginRequired, tabSlotTimeout, tabClosedDuringStep, cancelled,
//         internal.
// TDD: §7.6, §10
// PRD: NFR-S3 (loginRequired on /login redirect), FR-T7 (cancel cleanup must not leak tabs).
// Tasks: T-500 + Wave-5 fixes (C2 cancel-race cleanup, C3 loginRequired check).
// Wave: 3 (impl) + 5 (fixes)
// Status: implemented (Wave 3); patched (Wave 5)

// Detects login redirects so we throw loginRequired (PRD NFR-S3) instead of navigationBlocked.
// Matches /login or /<segment>/login (e.g. /uas/login on LinkedIn) as a path component.
// Intentionally permissive: any URL whose pathname contains a /login segment qualifies.
const LOGIN_PATH_RE = /\/(?:[a-z0-9-]+\/)?login(?:\/|$|\?|#)/i;

function isLoginRedirect(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const u = new URL(url);
    return LOGIN_PATH_RE.test(u.pathname);
  } catch {
    return LOGIN_PATH_RE.test(url);
  }
}

function loginRequiredError(url) {
  return {
    code: 'loginRequired',
    message: 'navigation redirected to login: ' + url,
    url,
  };
}

/**
 * @param {object} ctx
 * @param {{ type: 'navigate', url: string, newTab?: boolean, timeoutMs?: number, tabSlotTimeoutMs?: number }} step
 * @param {object} _params
 */
export default async function run(ctx, step, _params) {
  if (!ctx.isUrlAllowed(step.url)) {
    throw {
      code: 'navigationBlocked',
      message: 'URL outside scenario matches: ' + step.url,
      url: step.url,
    };
  }

  const timeoutMs = step.timeoutMs ?? 30_000;
  const newTab = step.newTab !== false;

  if (newTab) {
    // C2: hold the openTab promise so we can clean up an orphan tab if cancel wins the race.
    // Without this, ctx.openTab keeps running after raceWithCancel rejects; the tab gets
    // created and added to run.ownedTabs AFTER executeRun's finally block has already
    // snapshotted run.ownedTabs, leaking the tab and its budget slot (PRD FR-T7).
    const openPromise = ctx.openTab(step.url, {
      newTab: true,
      ...(step.tabSlotTimeoutMs != null ? { tabSlotTimeoutMs: step.tabSlotTimeoutMs } : {}),
    });
    let opened;
    try {
      opened = await raceWithCancel(
        ctx.cancelToken,
        'cancelled during navigate',
        openPromise,
      );
    } catch (e) {
      if (e && e.code === 'cancelled') {
        // Fire-and-forget cleanup of any orphan tab the in-flight openTab might still produce.
        scheduleOrphanCleanup(ctx, openPromise);
      }
      throw e;
    }
    const { tabId, release } = opened;
    void release;
    ctx.setTabId(tabId);
    const finalUrl = await waitForTabComplete(
      ctx,
      tabId,
      timeoutMs,
      'cancelled during navigate',
    );
    // C3: prefer loginRequired over navigationBlocked when the page bounced to a login URL.
    if (isLoginRedirect(finalUrl)) {
      throw loginRequiredError(finalUrl);
    }
    if (!ctx.isUrlAllowed(finalUrl)) {
      throw {
        code: 'navigationBlocked',
        message: 'navigation landed outside matches: ' + finalUrl,
        url: finalUrl,
      };
    }
    return { tabId: ctx.tabId, finalUrl };
  }

  if (ctx.tabId == null) {
    throw {
      code: 'internal',
      message: 'newTab:false requires existing tab',
    };
  }
  const tabId = ctx.tabId;
  await raceWithCancel(
    ctx.cancelToken,
    'cancelled during navigate',
    ctx.chrome.tabs.update(tabId, { url: step.url }),
  );
  const finalUrl = await waitForTabComplete(
    ctx,
    tabId,
    timeoutMs,
    'cancelled during navigate',
  );
  if (isLoginRedirect(finalUrl)) {
    throw loginRequiredError(finalUrl);
  }
  if (!ctx.isUrlAllowed(finalUrl)) {
    throw {
      code: 'navigationBlocked',
      message: 'navigation landed outside matches: ' + finalUrl,
      url: finalUrl,
    };
  }
  return { tabId: ctx.tabId, finalUrl };
}

/**
 * Wait for an in-flight openTab to settle after the caller already aborted; if it resolves,
 * close the resulting tab and release its budget slot. Errors are swallowed — this is a
 * best-effort cleanup path.
 * @param {object} ctx
 * @param {Promise<{ tabId: number, release: () => void }>} openPromise
 */
function scheduleOrphanCleanup(ctx, openPromise) {
  openPromise
    .then((opened) => {
      if (!opened) return;
      const { tabId, release } = opened;
      // Close the orphan tab (best effort; chrome.tabs.remove may also fire).
      try {
        if (typeof release === 'function') release();
      } catch {
        // ignore
      }
      try {
        if (ctx && ctx.closeTab && typeof tabId === 'number') {
          ctx.closeTab(tabId).catch(() => {});
        } else if (ctx && ctx.chrome && ctx.chrome.tabs && typeof tabId === 'number') {
          ctx.chrome.tabs.remove(tabId, () => {});
        }
      } catch {
        // ignore
      }
    })
    .catch(() => {
      // openTab failed (e.g. tabSlotTimeout). Nothing to clean up.
    });
}

/**
 * @param {object} ctx
 * @param {number} tabId
 * @param {number} timeoutMs
 * @param {string} cancelMessage
 */
async function waitForTabComplete(ctx, tabId, timeoutMs, cancelMessage) {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw {
        code: 'internal',
        message: 'navigate timed out waiting for tab to complete',
      };
    }
    let tab;
    try {
      tab = await raceWithCancel(
        ctx.cancelToken,
        cancelMessage,
        ctx.chrome.tabs.get(tabId),
      );
    } catch (e) {
      if (e && typeof e === 'object' && e.code === 'cancelled') {
        throw e;
      }
      throw {
        code: 'tabClosedDuringStep',
        message: 'tab closed during navigate',
      };
    }
    if (!tab) {
      throw {
        code: 'tabClosedDuringStep',
        message: 'tab closed during navigate',
      };
    }
    if (tab.status === 'complete') {
      return tab.url ?? '';
    }
    await sleepPoll(ctx, cancelMessage, 50, started, timeoutMs);
  }
}

function sleepPoll(ctx, cancelMessage, ms, started, limitMs) {
  const remain = limitMs - (Date.now() - started);
  if (remain <= 0) {
    return Promise.resolve();
  }
  const delay = Math.min(ms, remain);
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, delay);
    ctx.cancelToken
      .then(() => {
        clearTimeout(t);
        reject({ code: 'cancelled', message: cancelMessage });
      })
      .catch(() => {
        /* never */
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

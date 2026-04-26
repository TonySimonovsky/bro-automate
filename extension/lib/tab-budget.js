// tab-budget.js — global FIFO semaphore for automation tabs (PRD §5.3, FR-T1..FR-T7; TDD §7.4).
// Reads chrome.storage.local 'maxAutomationTabs' (default 20). Uses chrome.alarms for the 30s
// waitingForTabSlot ticker so it survives service-worker idle eviction.
// TDD: §7.4
// Tasks: T-404, T-410
// Wave: 2
// Status: implemented (Wave 2)

const DEFAULT_MAX = 20;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 300_000;
const WAIT_ALARM_NAME = 'broTabBudgetWaitTick';
const STORAGE_KEY = 'maxAutomationTabs';

/**
 * @typedef {object} AcquireOpts
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [cancelToken]
 * @property {string} [runId]
 * @property {string} [requestId]
 */

/**
 * @typedef {object} SlotHandle
 * @property {symbol} token
 * @property {() => void} release
 */

/**
 * @typedef {{ resolve: (v: SlotHandle) => void, reject: (e: unknown) => void, timer: ReturnType<typeof setTimeout>, runId?: string, requestId?: string, onAbort?: () => void, signal?: AbortSignal }} Waiter
 */

export class TabBudget {
  constructor() {
    this._max = DEFAULT_MAX;
    this._inUse = 0;
    /** @type {Waiter[]} */
    this._waiters = [];
    /** @type {((info: { runId?: string, requestId?: string }) => void) | null} */
    this._onWaiting = null;
    /** @type {typeof chrome.alarms | null} */
    this._alarms = null;
    /** @type {boolean} */
    this._alarmListenerAttached = false;
  }

  /**
   * @param {AcquireOpts} [opts]
   * @returns {Promise<SlotHandle>}
   */
  async acquire(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    const signal = opts.cancelToken;
    const runId = opts.runId;
    const requestId = opts.requestId;

    if (this._inUse < this._max) {
      return this._grantSlot();
    }

    return new Promise((resolve, reject) => {
      const wasEmpty = this._waiters.length === 0;

      /** @type {Waiter} */
      const entry = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this._removeWaiter(entry);
          reject({
            code: 'tabSlotTimeout',
            message: `tab slot not available within ${timeoutMs}ms`,
          });
        }, timeoutMs),
        runId,
        requestId,
      };

      if (signal) {
        const onAbort = () => {
          this._removeWaiter(entry);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        entry.signal = signal;
        entry.onAbort = onAbort;
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort);
      }

      this._waiters.push(entry);
      if (wasEmpty) {
        this._ensureWaitAlarm();
      }
    });
  }

  /**
   * @param {Waiter} entry
   */
  _removeWaiter(entry) {
    clearTimeout(entry.timer);
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
    }
    const i = this._waiters.indexOf(entry);
    if (i !== -1) this._waiters.splice(i, 1);
    if (this._waiters.length === 0) {
      this._clearWaitAlarm();
    }
  }

  _ensureWaitAlarm() {
    if (!this._onWaiting || !this._alarms) return;
    if (!this._alarmListenerAttached) {
      this._alarmListenerAttached = true;
      this._alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== WAIT_ALARM_NAME) return;
        if (this._waiters.length === 0) {
          this._clearWaitAlarm();
          return;
        }
        for (const w of this._waiters) {
          try {
            this._onWaiting?.({ runId: w.runId, requestId: w.requestId });
          } catch {
            // ignore
          }
        }
        this._alarms?.create(WAIT_ALARM_NAME, { delayInMinutes: 0.5 });
      });
    }
    this._alarms.create(WAIT_ALARM_NAME, { delayInMinutes: 0.5 });
  }

  _clearWaitAlarm() {
    try {
      this._alarms?.clear(WAIT_ALARM_NAME);
    } catch {
      // ignore
    }
  }

  /**
   * @returns {SlotHandle}
   */
  _grantSlot() {
    this._inUse++;
    let released = false;
    const token = Symbol('tabSlot');
    const release = () => {
      if (released) return;
      released = true;
      this._inUse--;
      this._drainWaiters();
    };
    return { token, release };
  }

  _drainWaiters() {
    while (this._waiters.length > 0 && this._inUse < this._max) {
      const w = this._waiters.shift();
      if (!w) break;
      clearTimeout(w.timer);
      if (w.signal && w.onAbort) {
        w.signal.removeEventListener('abort', w.onAbort);
      }
      w.resolve(this._grantSlot());
    }
    if (this._waiters.length === 0) {
      this._clearWaitAlarm();
    }
  }

  /**
   * @param {symbol} _token
   */
  release(_token) {
    void _token;
  }

  /**
   * @param {number} n
   */
  setMax(n) {
    if (!Number.isFinite(n) || n < 1) return;
    this._max = Math.floor(n);
    this._drainWaiters();
  }

  getMax() {
    return this._max;
  }

  queueLength() {
    return this._waiters.length;
  }
}

/**
 * @param {{ budget?: TabBudget, onWaiting?: (info: { runId?: string, requestId?: string }) => void }} [opts]
 */
export function bindToChrome(opts = {}) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  const budget = opts.budget;
  if (!(budget instanceof TabBudget)) return;

  const applyStoredMax = (val) => {
    if (typeof val === 'number' && Number.isFinite(val) && val >= 1) {
      budget.setMax(Math.floor(val));
    } else {
      budget.setMax(DEFAULT_MAX);
    }
  };

  chrome.storage.local.get([STORAGE_KEY], (got) => {
    applyStoredMax(got[STORAGE_KEY]);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      applyStoredMax(changes[STORAGE_KEY].newValue);
    }
  });

  if (typeof opts.onWaiting === 'function') {
    budget._onWaiting = opts.onWaiting;
  }
  budget._alarms = chrome.alarms || null;
}

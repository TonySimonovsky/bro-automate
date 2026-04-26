// run-registry.js — runId → run state record (PRD §5.2; TDD §7.2).
// TDD: §7.2
// Tasks: T-403
// Wave: 2
// Status: implemented (Wave 2)

const STORAGE_KEY = 'broRunRegistryMirror';

/**
 * @typedef {'queued' | 'running' | 'cancelling' | 'done' | 'error' | 'cancelled'} RunStatus
 */

/**
 * @typedef {object} RunRecord
 * @property {string} runId
 * @property {string} scenarioId
 * @property {string} requestId
 * @property {RunStatus} status
 * @property {number} currentStepIndex
 * @property {string | null} currentStepType
 * @property {Set<number>} ownedTabs
 * @property {unknown} partial
 * @property {string} startedAt
 * @property {string | undefined} endedAt
 * @property {boolean} cancelRequested
 */

export class RunRegistry {
  constructor() {
    /** @type {Map<string, RunRecord>} */
    this._runs = new Map();
    /** @type {Set<() => void>} */
    this._changeListeners = new Set();
  }

  /**
   * @param {() => void} fn
   * @returns {() => void}
   */
  onChange(fn) {
    this._changeListeners.add(fn);
    return () => this._changeListeners.delete(fn);
  }

  _emitChange() {
    for (const fn of this._changeListeners) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  }

  /**
   * @param {{ scenarioId: string, requestId: string }} p
   */
  create({ scenarioId, requestId }) {
    const runId = `r_${crypto.randomUUID()}`;
    /** @type {RunRecord} */
    const rec = {
      runId,
      scenarioId,
      requestId,
      status: 'queued',
      currentStepIndex: -1,
      currentStepType: null,
      ownedTabs: new Set(),
      partial: undefined,
      startedAt: new Date().toISOString(),
      endedAt: undefined,
      cancelRequested: false,
    };
    this._runs.set(runId, rec);
    this._emitChange();
    this._persistMirror();
    return runId;
  }

  /**
   * @param {string} runId
   * @returns {RunRecord | undefined}
   */
  get(runId) {
    return this._runs.get(runId);
  }

  /**
   * @param {string} runId
   * @param {RunStatus} status
   */
  setStatus(runId, status) {
    const r = this._runs.get(runId);
    if (!r) return;
    r.status = status;
    this._emitChange();
    this._persistMirror();
  }

  /**
   * @param {string} runId
   * @param {number} idx
   * @param {string | null} type
   */
  setStep(runId, idx, type) {
    const r = this._runs.get(runId);
    if (!r) return;
    r.currentStepIndex = idx;
    r.currentStepType = type;
    this._emitChange();
    this._persistMirror();
  }

  /**
   * @param {string} runId
   * @param {unknown} value
   */
  appendPartial(runId, value) {
    const r = this._runs.get(runId);
    if (!r) return;
    r.partial = value;
    this._emitChange();
    this._persistMirror();
  }

  /**
   * @param {string} runId
   */
  markCancelled(runId) {
    const r = this._runs.get(runId);
    if (!r) return;
    r.status = 'cancelled';
    r.cancelRequested = true;
    r.endedAt = new Date().toISOString();
    this._emitChange();
    this._persistMirror();
  }

  /**
   * @param {string} runId
   * @param {unknown} data
   */
  markDone(runId, data) {
    const r = this._runs.get(runId);
    if (!r) return;
    r.status = 'done';
    r.partial = data;
    r.endedAt = new Date().toISOString();
    this._emitChange();
    this._persistMirror();
  }

  /**
   * @param {string} runId
   * @param {string} code
   * @param {string} msg
   */
  markError(runId, code, msg) {
    const r = this._runs.get(runId);
    if (!r) return;
    r.status = 'error';
    r.endedAt = new Date().toISOString();
    r.partial = { error: code, errorMessage: msg };
    this._emitChange();
    this._persistMirror();
  }

  /**
   * @param {string} runId
   */
  delete(runId) {
    this._runs.delete(runId);
    this._emitChange();
    this._persistMirror();
  }

  /**
   * Runs still in flight (queued, running, or cancelling). Used for toolbar badge (PRD FR-X1).
   * Terminal records (`done`, `error`, `cancelled`) remain in the map but are excluded.
   */
  activeCount() {
    let n = 0;
    for (const r of this._runs.values()) {
      if (r.status === 'queued' || r.status === 'running' || r.status === 'cancelling') {
        n++;
      }
    }
    return n;
  }

  count() {
    return this._runs.size;
  }

  _persistMirror() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
      return;
    }
    const plain = {};
    for (const [id, rec] of this._runs) {
      plain[id] = {
        runId: rec.runId,
        scenarioId: rec.scenarioId,
        requestId: rec.requestId,
        status: rec.status,
        currentStepIndex: rec.currentStepIndex,
        currentStepType: rec.currentStepType,
        ownedTabs: [...rec.ownedTabs],
        partial: rec.partial,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        cancelRequested: rec.cancelRequested,
      };
    }
    chrome.storage.session.set({ [STORAGE_KEY]: plain });
  }
}

/**
 * @param {{ registry?: RunRegistry }} [opts]
 */
export function bindToChrome(opts = {}) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  const reg = opts.registry;
  if (reg instanceof RunRegistry) reg._persistMirror();
}

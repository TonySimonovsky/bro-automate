// tab-ownership.js — tabId ↔ runId map in chrome.storage.session (PRD §5.3, FR-T5/T6; TDD §7.5).
// Sole authoritative source of managed-tab status. No URL query flag (see TDD §7.5 rationale).
// TDD: §7.5
// Tasks: T-405
// Wave: 2
// Status: implemented (Wave 2)

export class TabOwnership {
  constructor() {
    /** @type {Map<number, string>} */
    this._tabToRun = new Map();
  }

  /**
   * @param {number} tabId
   * @param {string} runId
   */
  claim(tabId, runId) {
    this._tabToRun.set(tabId, runId);
    this._mirror();
  }

  /**
   * @param {number} tabId
   */
  release(tabId) {
    this._tabToRun.delete(tabId);
    this._mirror();
  }

  /**
   * @param {number} tabId
   * @returns {string | undefined}
   */
  ownerOf(tabId) {
    return this._tabToRun.get(tabId);
  }

  /**
   * @param {string} runId
   * @returns {number[]}
   */
  tabsOf(runId) {
    const ids = [];
    for (const [tid, rid] of this._tabToRun) {
      if (rid === runId) ids.push(tid);
    }
    return ids;
  }

  /**
   * @param {number} tabId
   */
  isOwned(tabId) {
    return this._tabToRun.has(tabId);
  }

  _mirror() {
    if (typeof chrome === 'undefined' || !chrome.storage?.session) return;
    /** @type {Record<string, string>} */
    const tabOwners = {};
    for (const [tid, runId] of this._tabToRun) {
      tabOwners[String(tid)] = runId;
    }
    chrome.storage.session.set({ tabOwners });
  }
}

/**
 * @param {{ ownership?: TabOwnership }} [opts]
 */
export function bindToChrome(opts = {}) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  chrome.storage.session.set({ tabOwners: {} });
  const o = opts.ownership;
  if (!(o instanceof TabOwnership)) return;
  chrome.tabs.onRemoved.addListener((tabId) => {
    o.release(tabId);
  });
}

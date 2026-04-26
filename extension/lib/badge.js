// badge.js — toolbar badge state (active when ≥1 run is in-flight). PRD FR-X1.
// TDD: §7 (UX), PRD §5.11
// Tasks: T-407
// Wave: 2
// Status: implemented (Wave 2)

/**
 * @param {{ active?: boolean, count?: number }} opts
 */
export function setBadge(opts) {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  const count = opts.count ?? 0;
  const text = count > 0 ? String(Math.min(count, 99)) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({
    color: count > 0 ? '#C62828' : '#00000000',
  });
  void opts.active;
}

/**
 * @param {{ registry?: { activeCount?: () => number, count: () => number, onChange: (fn: () => void) => () => void } }} [opts]
 */
export function bindToChrome(opts = {}) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  const registry = opts.registry;
  if (!registry || typeof registry.count !== 'function' || typeof registry.onChange !== 'function') {
    return;
  }
  const refresh = () => {
    const n =
      typeof registry.activeCount === 'function' ? registry.activeCount() : registry.count();
    setBadge({ active: n > 0, count: n });
  };
  registry.onChange(refresh);
  refresh();
}

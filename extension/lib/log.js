// log.js — structured logger (info/warn/error(scope, fields, msg)). Mirrors important events to
// the host (≤10 lines/sec) so they end up in host.log. PRD §5.10, TDD §12.
// TDD: §12
// Tasks: T-408
// Wave: 2
// Status: implemented (Wave 2)

/** @type {((envelope: object) => void) | null} */
let mirrorSend = null;

const MIRROR_MAX_PER_SEC = 10;
let mirrorWindowStart = 0;
let mirrorCountInWindow = 0;

function tryMirror(envelope) {
  if (typeof mirrorSend !== 'function') return;
  const now = Date.now();
  if (now - mirrorWindowStart >= 1000) {
    mirrorWindowStart = now;
    mirrorCountInWindow = 0;
  }
  if (mirrorCountInWindow >= MIRROR_MAX_PER_SEC) return;
  mirrorCountInWindow++;
  try {
    mirrorSend(envelope);
  } catch {
    // ignore mirror failures
  }
}

/**
 * @param {string} scope
 * @param {Record<string, unknown>} fields
 * @param {string} msg
 */
function baseEnvelope(scope, fields, msg) {
  return {
    event: 'log',
    ts: new Date().toISOString(),
    scope,
    msg,
    ...fields,
  };
}

/**
 * @param {(envelope: object) => void} fn
 */
export function setMirror(fn) {
  mirrorSend = typeof fn === 'function' ? fn : null;
}

/**
 * @param {string} scope
 * @param {Record<string, unknown>} fields
 * @param {string} msg
 */
export function info(scope, fields, msg) {
  const line = { level: 'info', ...baseEnvelope(scope, fields, msg) };
  console.log('[bro]', JSON.stringify(line));
  tryMirror(line);
}

/**
 * @param {string} scope
 * @param {Record<string, unknown>} fields
 * @param {string} msg
 */
export function warn(scope, fields, msg) {
  const line = { level: 'warn', ...baseEnvelope(scope, fields, msg) };
  console.warn('[bro]', JSON.stringify(line));
  tryMirror(line);
}

/**
 * @param {string} scope
 * @param {Record<string, unknown>} fields
 * @param {string} msg
 */
export function error(scope, fields, msg) {
  const line = { level: 'error', ...baseEnvelope(scope, fields, msg) };
  console.error('[bro]', JSON.stringify(line));
  tryMirror(line);
}

/**
 * @param {Record<string, never>} [_opts]
 */
export function bindToChrome(_opts) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
}

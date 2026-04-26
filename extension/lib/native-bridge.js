// native-bridge.js — connectNative + message routing between extension and native host.
// TDD: §7.1, §5 (protocol envelope)
// Tasks: T-402
// Wave: 2
// Status: implemented (Wave 2)

const NATIVE_HOST = 'aichamp.bro.automate';

/**
 * @typedef {object} NativeConnection
 * @property {(msg: object) => void} send
 * @property {(handler: (msg: object) => void) => void} onMessage
 * @property {(handler: () => void) => void} onDisconnect
 * @property {(action: string, handler: (msg: object) => void) => void} onAction
 * @property {(event: string, handler: (msg: object) => void) => void} onEvent
 */

/**
 * @returns {NativeConnection}
 */
export function connect() {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.connectNative) {
    throw new Error('native messaging unavailable');
  }
  const port = chrome.runtime.connectNative(NATIVE_HOST);
  /** @type {Map<string, (msg: object) => void>} */
  const actionHandlers = new Map();
  /** @type {Map<string, (msg: object) => void>} */
  const eventHandlers = new Map();
  /** @type {((msg: object) => void)[]} */
  const broadcastHandlers = [];

  port.onMessage.addListener((msg) => {
    if (msg && typeof msg === 'object') {
      if (typeof msg.event === 'string') {
        const h = eventHandlers.get(msg.event);
        if (h) h(msg);
      } else if (typeof msg.action === 'string') {
        const h = actionHandlers.get(msg.action);
        if (h) h(msg);
        else if (msg.requestId != null) {
          try {
            port.postMessage({
              requestId: msg.requestId,
              ok: false,
              error: 'unknownAction',
              errorMessage: 'no handler for action: ' + String(msg.action),
            });
          } catch {
            // ignore
          }
        }
      }
    }
    for (const h of broadcastHandlers) {
      try {
        h(msg);
      } catch {
        // isolate listener failures
      }
    }
  });

  return {
    send(msg) {
      port.postMessage(msg);
    },
    onMessage(handler) {
      broadcastHandlers.push(handler);
    },
    onDisconnect(handler) {
      port.onDisconnect.addListener(handler);
    },
    onAction(action, handler) {
      actionHandlers.set(action, handler);
    },
    onEvent(event, handler) {
      eventHandlers.set(event, handler);
    },
  };
}

/**
 * @param {Record<string, never>} [_opts]
 */
export function bindToChrome(_opts) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
}

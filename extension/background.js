// Service worker — command executor only. The HTTP poll loop lives in the
// offscreen document (offscreen.js); the SW just receives chrome.runtime
// messages from offscreen, runs the privileged command (chrome.debugger,
// chrome.tabs, chrome.tabGroups), and returns the result. The SW is now safe
// to idle-evict between commands: each new command wakes it via runtime
// messaging, and an offscreen-side watchdog calls chrome.runtime.reload() if
// the SW ever becomes unresponsive.

const CDP_PROTOCOL = '1.3';

async function ensureOffscreen() {
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: 'Primary HTTP poller for the RPA bridge; immune to SW idle eviction.',
      });
    }
  } catch (e) {
    console.warn('[rpa-cdp-v002] ensureOffscreen failed:', e.message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
  ensureOffscreen();
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') ensureOffscreen();
});

// Run on every SW boot (idle wake-up included): make sure the offscreen poller exists.
ensureOffscreen();

// Dedupe cache: maps server's _cmdId -> last result. Useful only if the same
// offscreen instance receives the same id twice (e.g. /done post failed and
// the bridge resent). The primary cache lives in offscreen.js; this one
// covers the small race window where the SW handles a cmd twice if its own
// state was lost between two adjacent invocations.
const PROCESSED_CACHE_LIMIT = 64;
const processedResults = new Map();
function rememberResult(id, result) {
  if (id == null) return;
  processedResults.set(id, result);
  while (processedResults.size > PROCESSED_CACHE_LIMIT) {
    const oldest = processedResults.keys().next().value;
    processedResults.delete(oldest);
  }
}

async function handleCommand(cmd) {
  try {
    if (cmd.type === 'tabs') {
      const tabs = await chrome.tabs.query(cmd.query || {});
      return tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active, windowId: t.windowId }));
    }

    if (cmd.type === 'attach') {
      await chrome.debugger.attach({ tabId: cmd.tabId }, CDP_PROTOCOL);
      return { success: true };
    }

    if (cmd.type === 'detach') {
      await chrome.debugger.detach({ tabId: cmd.tabId });
      return { success: true };
    }

    if (cmd.type === 'cdp') {
      const result = await chrome.debugger.sendCommand({ tabId: cmd.tabId }, cmd.method, cmd.params || {});
      return { success: true, result };
    }

    if (cmd.type === 'create-tab') {
      const tab = await chrome.tabs.create({ url: cmd.url || 'about:blank', active: false });
      return { success: true, tabId: tab.id, windowId: tab.windowId };
    }

    if (cmd.type === 'close-tab') {
      await chrome.tabs.remove(cmd.tabId);
      return { success: true };
    }

    if (cmd.type === 'group-tab') {
      const groupId = await chrome.tabs.group({ tabIds: [cmd.tabId] });
      await chrome.tabGroups.update(groupId, { title: cmd.title || '', color: cmd.color || 'blue' });
      return { success: true, groupId };
    }

    return { success: false, error: `Unknown command type: ${cmd.type}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Sync ping for the offscreen watchdog; async cmd dispatcher returns true so
// Chrome keeps the message channel open until handleCommand resolves.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'ping') {
    sendResponse('pong');
    return false;
  }

  if (msg.type === 'cmd' && msg.cmd) {
    const id = msg.cmd._cmdId;
    if (id != null && processedResults.has(id)) {
      sendResponse(processedResults.get(id));
      return false;
    }
    handleCommand(msg.cmd).then(result => {
      rememberResult(id, result);
      sendResponse(result);
    });
    return true;
  }

  return false;
});

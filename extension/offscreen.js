// Primary HTTP poller. Lives in the offscreen document (which is not subject to
// service-worker idle eviction) and forwards each received command to the SW
// via chrome.runtime.sendMessage. The SW only wakes long enough to execute the
// command and reply, then is allowed to idle-evict harmlessly.
//
// Watchdog: pings the SW every 5s. If 3 consecutive pings fail (SW deadlocked
// or refusing to wake), self-heals via chrome.runtime.reload() — the extension
// restarts cleanly, ensureOffscreen() in background.js recreates the offscreen
// page, and polling resumes. No manual chrome://extensions reload needed.

const SERVER = 'http://localhost:7823';
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

async function pingSW() {
  try {
    const r = await Promise.race([
      chrome.runtime.sendMessage({ type: 'ping' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), 2000)),
    ]);
    return r === 'pong';
  } catch (e) {
    return false;
  }
}

let pingFailures = 0;
async function watchdog() {
  while (true) {
    await new Promise(r => setTimeout(r, 5000));
    const ok = await pingSW();
    if (ok) {
      if (pingFailures > 0) console.log('[rpa-cdp-v002 offscreen] SW recovered');
      pingFailures = 0;
      continue;
    }
    pingFailures++;
    console.warn(`[rpa-cdp-v002 offscreen] SW ping failed (${pingFailures}/3)`);
    if (pingFailures >= 3) {
      console.warn('[rpa-cdp-v002 offscreen] SW unresponsive — chrome.runtime.reload()');
      pingFailures = 0;
      try { chrome.runtime.reload(); } catch (e) { console.warn('[rpa-cdp-v002 offscreen] reload failed:', e.message); }
    }
  }
}

async function executeViaSW(cmd) {
  // First attempt times out at 30s; on timeout/error try once more (gives the SW
  // time to wake from idle on the first message). After two failures we surface
  // an error result; the bridge will retry the command via its own resend logic.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await Promise.race([
        chrome.runtime.sendMessage({ type: 'cmd', cmd }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('SW message timeout')), 30000)),
      ]);
      return r;
    } catch (e) {
      if (attempt === 0) {
        console.warn('[rpa-cdp-v002 offscreen] SW message failed, retrying:', e.message);
        await new Promise(r => setTimeout(r, 200));
        continue;
      }
      return { success: false, error: `SW unresponsive: ${e.message}` };
    }
  }
}

async function poll() {
  console.log('[rpa-cdp-v002 offscreen] poll started, connecting to', SERVER);
  while (true) {
    try {
      const resp = await fetch(`${SERVER}/next`, { signal: AbortSignal.timeout(35000) });
      if (resp.status === 204) continue;
      const cmd = await resp.json();
      console.log('[rpa-cdp-v002 offscreen] cmd received:', cmd.type, 'id', cmd._cmdId);
      let result;
      if (cmd._cmdId != null && processedResults.has(cmd._cmdId)) {
        result = processedResults.get(cmd._cmdId);
        console.log('[rpa-cdp-v002 offscreen] replay cached for id', cmd._cmdId);
      } else {
        result = await executeViaSW(cmd);
        rememberResult(cmd._cmdId, result);
      }
      await fetch(`${SERVER}/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
    } catch (e) {
      console.warn('[rpa-cdp-v002 offscreen] poll error:', e.message, '— retrying in 1s');
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

poll();
watchdog();

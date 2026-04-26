// offscreen.js — keeps the MV3 service worker warm enough that Chrome does not close the
// native-messaging port between local CLI calls. No page context can observe this document.

(function () {
  function ping() {
    try {
      chrome.runtime.sendMessage({ event: 'broOffscreenKeepalive', ts: Date.now() }, function () {
        // Ignore errors: the service worker may be restarting.
        void chrome.runtime.lastError;
      });
    } catch {
      // ignore
    }
  }

  ping();
  setInterval(ping, 20 * 1000);
})();

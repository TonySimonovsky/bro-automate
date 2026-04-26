// content/dispatcher.js — generic content script for messaging only. Does NOT implement scenario
// logic. v0.01 tab ownership is tracked extension-side (chrome.storage.session + in-memory
// TabOwnership) and browser UI marking uses Chrome tab groups. We intentionally do NOT write
// DOM attributes / title / favicon / URL markers because page JavaScript could observe them.
// Registered dynamically via chrome.scripting.registerContentScripts for the URL patterns of
// every loaded scenario.
// TDD: §7.5, §7.6
// Tasks: T-409
// Wave: 3
// Status: implemented (Wave 3)
//
// v0.01: The service worker uses chrome.scripting.executeScript directly; this file is a small
// placeholder routing surface for future background→tab messages. It is currently not registered
// by the service worker (see pm/build/v.0.01/waves.md OI-5). Does not load scenario code by itself.
(function () {
  'use strict';

  function isBroOwnedTab() {
    // No page-visible ownership marker in v0.01. A future registered dispatcher should ask the
    // service worker via message for ownership instead of reading/writing page DOM.
    return false;
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || typeof msg !== 'object') {
      return;
    }
    if (msg.action === '_isOwned') {
      if (typeof sendResponse === 'function') {
        sendResponse(!!isBroOwnedTab());
      }
      return;
    }
    if (!isBroOwnedTab()) {
      return;
    }
    if (msg.action === 'injectAndRun') {
      if (typeof sendResponse === 'function') {
        sendResponse({ ok: true, routed: true, note: 'v0.01: prefer background executeScript' });
      }
    }
  });
})();

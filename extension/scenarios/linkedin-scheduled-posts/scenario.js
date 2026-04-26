// scenarios/linkedin-scheduled-posts/scenario.js — exports findInShadow, clickByAccessibleName,
// openComposer, openSchedulePanel, openScheduledList, isScheduledListReady,
// extractScheduledPosts, loginRequired.
// Source element map (in-repo snapshot):
//   pm/build/v.0.01/inputs/scenarios/linkedin-scheduled-posts-map.md
// PRD UC-2 / NFR-S3: if URL ever lands on /login, throw a loginRequired-coded error.
// TDD: §11.2
// Tasks: T-703
// Wave: 4
// Status: implemented (Wave 4).

(function () {
  if (globalThis['__broScenario_linkedin-scheduled-posts']) return;

  var diag = {
    scenarioId: 'linkedin-scheduled-posts',
    loadedAt: new Date().toISOString(),
    events: [],
    milestones: [],
    pollSamples: [],
  };
  globalThis.__broScenarioDiag = globalThis.__broScenarioDiag || {};
  globalThis.__broScenarioDiag['linkedin-scheduled-posts'] = diag;

  // ─── Polling (200ms / 15s — step-contract §5 defaults for wait steps) ───
  var DEFAULT_POLL_MS = 200;
  var DEFAULT_MAX_MS = 15000;

  function sleepMs(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function recordDiag(event, details) {
    try {
      var entry = {
        event: event,
        at: new Date().toISOString(),
        url: window.location.href,
        details: details || {},
      };
      diag.events.push(entry);
      if (diag.events.length > 80) diag.events.shift();
      if (String(event).indexOf(':poll') === -1) {
        diag.milestones.push(entry);
        if (diag.milestones.length > 40) diag.milestones.shift();
      } else {
        diag.pollSamples.push(entry);
        if (diag.pollSamples.length > 10) diag.pollSamples.shift();
      }
    } catch (_) {
      // Diagnostic breadcrumbs must never affect scenario behavior.
    }
  }

  function loginRequired() {
    var p = window.location.pathname;
    if (p.startsWith('/login') || p.startsWith('/uas/login')) {
      throw { code: 'loginRequired', message: 'redirected to login', url: window.location.href };
    }
  }

  async function pollUntil(name, fn, intervalMs, maxMs) {
    loginRequired();
    var iv = intervalMs != null ? intervalMs : DEFAULT_POLL_MS;
    var cap = maxMs != null ? maxMs : DEFAULT_MAX_MS;
    var t0 = Date.now();
    while (Date.now() - t0 < cap) {
      loginRequired();
      if (fn()) return;
      await sleepMs(iv);
    }
    throw {
      code: 'selectorTimeout',
      message: 'Timed out waiting for: ' + name + ' (' + cap + 'ms)',
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  function findInShadow(args) {
    loginRequired();
    var root = args && args.root ? args.root : document;
    var selector;
    if (args && args.selector) {
      selector = args.selector;
    } else {
      selector = args;
    }
    if (typeof selector !== 'string') return null;
    var el = root.querySelector(selector);
    if (el) return el;
    var shadowHosts = root.querySelectorAll('*');
    for (var i = 0; i < shadowHosts.length; i++) {
      if (shadowHosts[i].shadowRoot) {
        var found = findInShadow({ root: shadowHosts[i].shadowRoot, selector: selector });
        if (found) return found;
      }
    }
    return null;
  }

  function getAccessibleName(el) {
    if (!el || el.nodeType !== 1) return '';
    var al = el.getAttribute('aria-label');
    if (al) return al.trim();
    var lby = el.getAttribute('aria-labelledby');
    if (lby) {
      var parts = [];
      var ids = lby.split(/\s+/);
      for (var j = 0; j < ids.length; j++) {
        var ref = document.getElementById(ids[j]);
        if (ref && ref.textContent) parts.push(ref.textContent.trim());
      }
      if (parts.length) return parts.join(' ').trim();
    }
    if (el.tagName === 'IMG' && el.getAttribute('alt')) return el.getAttribute('alt').trim();
    if (el.textContent) return el.textContent.trim();
    return '';
  }

  function normText(s) {
    return (s == null ? '' : String(s)).replace(/\s+/g, ' ').trim();
  }

  function isClickable(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A') return true;
    if (el.getAttribute('role') === 'button') return true;
    return false;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
    if (typeof el.getBoundingClientRect === 'function') {
      var rect = el.getBoundingClientRect();
      if (rect && rect.width === 0 && rect.height === 0) return false;
    }
    if ('offsetParent' in el && el.offsetParent === null) {
      if (typeof el.getBoundingClientRect !== 'function') return false;
      var r = el.getBoundingClientRect();
      if (!r || (r.width === 0 && r.height === 0)) return false;
    }
    return true;
  }

  function describeElement(el, strategy) {
    if (!el) return null;
    var rect = null;
    try {
      if (typeof el.getBoundingClientRect === 'function') {
        var r = el.getBoundingClientRect();
        rect = { x: Math.round(r.x || r.left || 0), y: Math.round(r.y || r.top || 0), width: Math.round(r.width || 0), height: Math.round(r.height || 0) };
      }
    } catch (_) {
      rect = null;
    }
    return {
      strategy: strategy || '',
      tagName: el.tagName || '',
      role: el.getAttribute ? el.getAttribute('role') || '' : '',
      aria: el.getAttribute ? el.getAttribute('aria-label') || '' : '',
      text: normText(el.textContent).slice(0, 160),
      visible: isVisible(el),
      disabled: !!el.disabled,
      rect: rect,
    };
  }

  function allClickableCandidates() {
    var out = [];
    visitFromDocument(document, function (el) {
      if (isClickable(el)) out.push(el);
    });
    return out;
  }

  function visitElementTree(root, visitor) {
    if (!root) return;
    visitor(root);
    if (root.nodeType === 1 && root.shadowRoot) {
      visitElementTree(root.shadowRoot, visitor);
    }
    if (root.children) {
      for (var c = 0; c < root.children.length; c++) {
        visitElementTree(root.children[c], visitor);
      }
    }
  }

  function visitFromDocument(doc, visitor) {
    if (doc && doc.documentElement) {
      visitElementTree(doc.documentElement, visitor);
    }
  }

  function findByAccessibleName(name) {
    var target = (name && String(name).trim().toLowerCase()) || '';
    var found = null;
    var nodes = allClickableCandidates();
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!isVisible(el)) continue;
      var n = getAccessibleName(el);
      if (n && n.trim().toLowerCase() === target) {
        found = el;
        break;
      }
    }
    return found;
  }

  function enumerateStartPostCandidates() {
    var nodes = allClickableCandidates();
    var exact = [];
    var includes = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var name = normText(getAccessibleName(el));
      var lower = name.toLowerCase();
      var entry = { el: el, desc: describeElement(el, lower === 'start a post' ? 'accessible-exact' : 'accessible-includes') };
      if (lower === 'start a post') exact.push(entry);
      else if (lower.indexOf('start a post') !== -1) includes.push(entry);
    }
    exact.sort(function (a, b) { return Number(b.desc.visible) - Number(a.desc.visible); });
    includes.sort(function (a, b) { return Number(b.desc.visible) - Number(a.desc.visible); });
    return exact.concat(includes);
  }

  async function robustClick(el, label) {
    if (!el) throw phaseError('notActionable', label || 'click', 'click target missing');
    if (!isVisible(el)) {
      throw phaseError('notActionable', label || 'click', 'click target is not visible', { target: describeElement(el, label) });
    }
    try {
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'nearest' });
    } catch (_) {
      // ignore scroll failures; click fallback may still work.
    }
    await sleepMs(50);
    var target = el;
    var init = { bubbles: true, cancelable: true };
    try {
      if (typeof el.getBoundingClientRect === 'function') {
        var r = el.getBoundingClientRect();
        var x = Math.round((r.left || 0) + (r.width || 0) / 2);
        var y = Math.round((r.top || 0) + (r.height || 0) / 2);
        init.clientX = x;
        init.clientY = y;
        if (document.elementFromPoint) {
          var atPoint = document.elementFromPoint(x, y);
          if (atPoint && (atPoint === el || (el.contains && el.contains(atPoint)))) target = atPoint;
        }
      }
    } catch (_) {
      target = el;
    }
    function fire(CtorName, type) {
      try {
        var Ctor = window[CtorName] || window.Event;
        target.dispatchEvent(new Ctor(type, init));
      } catch (_) {
        try {
          target.dispatchEvent(new Event(type, init));
        } catch (_) {
          // ignore; el.click fallback below is still useful.
        }
      }
    }
    fire('PointerEvent', 'pointerdown');
    fire('MouseEvent', 'mousedown');
    fire('PointerEvent', 'pointerup');
    fire('MouseEvent', 'mouseup');
    fire('MouseEvent', 'click');
    if (typeof el.click === 'function') el.click();
    return { clicked: true, target: describeElement(el, label) };
  }

  function clickByAccessibleName(args) {
    loginRequired();
    var name = args && args.name;
    if (typeof name !== 'string' || !name.trim()) {
      throw { code: 'internal', message: 'clickByAccessibleName: missing name' };
    }
    var el = findByAccessibleName(name);
    if (!el) {
      throw {
        code: 'selectorTimeout',
        message: 'no element with accessible name: ' + name,
      };
    }
    el.click();
    return { clicked: true };
  }

  function findButtonByExactTextInTree(exact) {
    var want = (exact && String(exact)) || '';
    var found = null;
    visitFromDocument(document, function (el) {
      if (found) return;
      if (el.tagName !== 'BUTTON') return;
      if (el.textContent && el.textContent.trim() === want) found = el;
    });
    return found;
  }

  function findScheduledPostsHeadingH2() {
    var out = null;
    visitFromDocument(document, function (el) {
      if (out) return;
      if (el.tagName !== 'H2') return;
      if (el.textContent && el.textContent.trim() === 'Scheduled posts') out = el;
    });
    return out;
  }

  function scheduledPostRows() {
    var list = findInShadow({ selector: 'ul.artdeco-list' });
    if (!list) return [];
    return Array.prototype.slice.call(
      list.querySelectorAll('li.artdeco-list__item.share-post-list-view__item')
    );
  }

  function hasScheduledPostsEmptyState() {
    var modal = findInShadow({ selector: '.artdeco-modal.share-box-v2__modal' });
    var txt = modal && modal.textContent ? modal.textContent : '';
    return /no scheduled posts|you don'?t have any scheduled posts|0 scheduled posts/i.test(txt);
  }

  function hasComposerModal() {
    var modal = findInShadow({ selector: '.artdeco-modal.share-box-v2__modal' });
    if (!modal) return false;
    return (
      findInShadow({ selector: '[aria-label="Text editor for creating content"]' }) != null ||
      findInShadow({ selector: '.ql-editor' }) != null ||
      findInShadow({ selector: '[aria-label="Schedule post"]' }) != null ||
      findInShadow({ selector: '.share-actions__scheduled-post-btn' }) != null
    );
  }

  function hasSchedulePanel() {
    return (
      findInShadow({ selector: '#share-post__scheduled-date' }) != null ||
      findInShadow({ selector: 'input[name="artdeco-date"]' }) != null
    );
  }

  function detectPhase() {
    if (findScheduledPostsHeadingH2() || scheduledPostRows().length > 0 || hasScheduledPostsEmptyState()) return 'scheduledList';
    if (hasSchedulePanel()) return 'schedulePanel';
    if (hasComposerModal()) return 'composer';
    if (findInShadow({ selector: '.artdeco-modal.share-box-v2__modal' })) return 'modal';
    return 'feed';
  }

  function collectState() {
    var modal = findInShadow({ selector: '.artdeco-modal.share-box-v2__modal' });
    var list = findInShadow({ selector: 'ul.artdeco-list' });
    var rows = scheduledPostRows();
    var heading = findScheduledPostsHeadingH2();
    return {
      phase: detectPhase(),
      url: window.location.href,
      readyState: document.readyState,
      modalFound: !!modal,
      modalTextFirst300: modal && modal.textContent ? modal.textContent.trim().replace(/\s+/g, ' ').slice(0, 300) : null,
      listFound: !!list,
      listChildren: list && list.children ? list.children.length : 0,
      scheduledRowCount: rows.length,
      scheduledHeadingFound: !!heading,
      emptyStateFound: hasScheduledPostsEmptyState(),
      composerSignals: {
        editor: findInShadow({ selector: '[aria-label="Text editor for creating content"]' }) != null || findInShadow({ selector: '.ql-editor' }) != null,
        scheduleButton: findInShadow({ selector: '[aria-label="Schedule post"]' }) != null || findInShadow({ selector: '.share-actions__scheduled-post-btn' }) != null,
      },
      scheduleSignals: {
        dateField: hasSchedulePanel(),
        timeField: findInShadow({ selector: '#share-post__scheduled-time' }) != null || findInShadow({ selector: '.artdeco-typeahead__input' }) != null,
      },
    };
  }

  function phaseError(code, phase, message, state) {
    return {
      code: code,
      phase: phase,
      message: message,
      snapshot: state || collectState(),
      diag: diag,
    };
  }

  async function openComposer() {
    loginRequired();
    var deadline = Date.now() + DEFAULT_MAX_MS;
    var attempts = [];
    while (Date.now() < deadline) {
      loginRequired();
      if (detectPhase() === 'composer') {
        recordDiag('openComposer:alreadyOpen', collectState());
        return { opened: true, alreadyOpen: true };
      }
      var candidates = enumerateStartPostCandidates();
      if (candidates.length) {
        var selected = candidates[0];
        attempts.push(selected.desc);
        recordDiag('openComposer:clickAttempt', { selected: selected.desc, candidates: candidates.slice(0, 5).map(function (c) { return c.desc; }) });
        await robustClick(selected.el, 'startPost');
        var clickDeadline = Date.now() + 2000;
        while (Date.now() < clickDeadline) {
          if (detectPhase() === 'composer') {
            recordDiag('openComposer:opened', collectState());
            return { opened: true, attempts: attempts };
          }
          await sleepMs(DEFAULT_POLL_MS);
        }
      }
      await sleepMs(DEFAULT_POLL_MS);
    }
    throw phaseError('composerNotReady', 'openComposer', 'Start a post did not open the composer within ' + DEFAULT_MAX_MS + 'ms', {
      state: collectState(),
      attempts: attempts,
      candidates: enumerateStartPostCandidates().slice(0, 8).map(function (c) { return c.desc; }),
    });
  }

  async function openSchedulePanel() {
    loginRequired();
    var scheduleBtn = null;
    await pollUntil('Schedule post button', function () {
      scheduleBtn = findInShadow({ selector: '[aria-label="Schedule post"]' }) || findInShadow({ selector: '.share-actions__scheduled-post-btn' });
      return scheduleBtn != null;
    });
    await robustClick(scheduleBtn, 'schedulePost');
    await pollUntil('schedule date field', function () {
      return hasSchedulePanel();
    });
    var state = collectState();
    if (!state.modalFound) {
      throw phaseError('scheduledPanelLost', 'openSchedulePanel', 'schedule panel opened but share modal disappeared', state);
    }
    recordDiag('openSchedulePanel:opened', state);
    return { opened: true };
  }

  async function openScheduledList() {
    loginRequired();
    var t0 = Date.now();
    var clicked = false;
    while (Date.now() - t0 < DEFAULT_MAX_MS) {
      loginRequired();
      var btn = findButtonByExactTextInTree('View all scheduled posts');
      if (btn) {
        recordDiag('openScheduledList:click', {
          buttonText: btn.textContent ? btn.textContent.trim().replace(/\s+/g, ' ').slice(0, 120) : '',
        });
        await robustClick(btn, 'viewAllScheduledPosts');
        clicked = true;
        break;
      }
      await sleepMs(DEFAULT_POLL_MS);
    }
    if (!clicked) {
      throw {
        code: 'selectorTimeout',
        message: 'View all scheduled posts not found (' + DEFAULT_MAX_MS + 'ms)',
      };
    }
    await pollUntil('Scheduled posts heading', function () {
      return findScheduledPostsHeadingH2() != null;
    });
    var state = collectState();
    if (!state.modalFound || !state.scheduledHeadingFound) {
      throw phaseError('scheduledPanelLost', 'openScheduledList', 'scheduled posts heading appeared but panel did not remain open', state);
    }
    recordDiag('openScheduledList:opened', state);
    return { opened: true };
  }

  async function waitForScheduledListReady() {
    var deadline = Date.now() + DEFAULT_MAX_MS;
    var lastState = null;
    while (Date.now() < deadline) {
      loginRequired();
      lastState = collectState();
      recordDiag('runScheduledPostsFlow:readyPoll', lastState);
      if (!lastState.modalFound) {
        throw phaseError('scheduledPanelLost', 'waitForScheduledListReady', 'scheduled posts panel disappeared before extraction', lastState);
      }
      if (lastState.scheduledRowCount > 0 || lastState.emptyStateFound) return lastState;
      await sleepMs(DEFAULT_POLL_MS);
    }
    throw phaseError('selectorTimeout', 'waitForScheduledListReady', 'scheduled posts list did not become ready in ' + DEFAULT_MAX_MS + 'ms', lastState);
  }

  async function runScheduledPostsFlow() {
    diag.events = [];
    diag.milestones = [];
    diag.pollSamples = [];
    recordDiag('runScheduledPostsFlow:start', collectState());
    await openComposer();
    await openSchedulePanel();
    await openScheduledList();
    var readyState = await waitForScheduledListReady();
    if (readyState && readyState.emptyStateFound && readyState.scheduledRowCount === 0) {
      recordDiag('runScheduledPostsFlow:done', { posts: 0, empty: true, state: collectState() });
      return { posts: [] };
    }
    var out = await extractScheduledPosts();
    recordDiag('runScheduledPostsFlow:done', { posts: out.posts.length, state: collectState() });
    return out;
  }

  // Predicate used by scenario.json's waitForState step. It makes the scenario validate
  // that the scheduled-posts panel has actually settled before extraction runs. LinkedIn
  // renders the panel heading before the async row fetch resolves; without this predicate,
  // extractScheduledPosts can run too early and return {posts: []} (or, on some Chrome
  // versions, null when an async helper crosses the extension scripting boundary).
  function isScheduledListReady() {
    loginRequired();
    var state = collectState();
    recordDiag('isScheduledListReady:poll', state);
    if (state.scheduledRowCount > 0) return true;
    return state.emptyStateFound;
  }

  var PUBLISH_TIME_RE = /published on (.+?) at (.+?)(?:,? click|$)/i;

  function parsePublishTime(aria) {
    if (!aria) return '';
    var m = String(aria).match(PUBLISH_TIME_RE);
    if (m) return m[1].trim() + ' at ' + m[2].trim();
    return String(aria);
  }

  function textFromElement(el) {
    if (!el) return '';
    return normText(el.innerText || el.textContent || '');
  }

  function fallbackRowText(row) {
    var raw = textFromElement(row);
    if (!raw) return '';
    raw = raw.replace(/^Scheduled posts\s+/i, '');
    raw = raw.replace(/^Posting\s+.*?\bat\s+\d{1,2}:\d{2}\s*(?:AM|PM)\s*/i, '');
    raw = raw.replace(/\s+Actions menu for scheduled post.*$/i, '');
    raw = raw.replace(/\s+Preview of the scheduled post.*$/i, '');
    return normText(raw);
  }

  async function extractScheduledPosts() {
    loginRequired();
    var list = findInShadow({ selector: 'ul.artdeco-list' });
    if (!list) {
      throw {
        code: 'selectorTimeout',
        message: 'scheduled-posts ul.artdeco-list not found',
      };
    }
    // waitForState(isScheduledListReady) guarantees rows are present, unless LinkedIn
    // showed a real empty-state. Returning [] is now a validated empty result, not a race.
    var rows = scheduledPostRows();
    var posts = [];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var showMore = row.querySelector('button[aria-label*="Show more"]');
      if (showMore) {
        showMore.click();
        await sleepMs(150);
      }
      var textEl = row.querySelector('.inline-show-more-text');
      var text = textFromElement(textEl) || fallbackRowText(row);
      var img = row.querySelector('img');
      var mediaSrc = img && img.src ? img.src : null;
      var viewBtn = row.querySelector('button[aria-label*="Preview of the scheduled post"]');
      var aria = viewBtn && viewBtn.getAttribute('aria-label') ? viewBtn.getAttribute('aria-label') : '';
      var publishTime = parsePublishTime(aria);
      posts.push({ publishTime: publishTime, text: text, mediaSrc: mediaSrc });
    }
    return { posts: posts };
  }

  // loginRequired is also exported for explicit checks; same throw shape as internal checks
  function loginRequiredExport() {
    loginRequired();
    return { ok: true };
  }

  globalThis['__broScenario_linkedin-scheduled-posts'] = {
    findInShadow: findInShadow,
    clickByAccessibleName: clickByAccessibleName,
    openComposer: openComposer,
    openSchedulePanel: openSchedulePanel,
    openScheduledList: openScheduledList,
    isScheduledListReady: isScheduledListReady,
    extractScheduledPosts: extractScheduledPosts,
    runScheduledPostsFlow: runScheduledPostsFlow,
    loginRequired: loginRequiredExport,
  };
})();

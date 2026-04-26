// scenarios/upwork-collect/scenario.js — MAIN-world scenario module (TDD §7.6, §11.1).
// Logic per pm/build/v.0.01/inputs/scenarios/upwork-collect-map.md (canonical in-repo).
// PRD FR-RS1: never dismisses or removes notifications in v0.01.
//
// ORCHESTRATION (Architecture A — single-tab evaluate, agent-driven loop)
// Page-world code cannot call chrome.* or open tabs. `scrapeAll` only reads the CURRENT tab.
// - For each job URL: the operator navigates (or opens a run tab) to that URL, then runs this
//   scenario (or a follow-up run whose tab is already on the job page). Multiple URLs ⇒ multiple
//   runScenario / step sequences at the agent or CLI layer (FR-R5 one-shot per execution).
// - `resolveJobUrls` on a notifications tab returns `{ urls }`; the agent then navigates per URL
//   and invokes scraping (same scenario step 2 only in practice, or full two-step run on an
//   already-navigated job tab).
// - v0.01 `extension/lib/steps/evaluate.js` forwards only `step.args` from scenario.json, not
//   `ctx.params`. Tooling SHOULD merge run params into each evaluate step’s `args` when dispatching;
//   helpers below read a single `args` object (jobIds, jobUrls, source, limit, etc.).
// - Prior-step return values are not auto-merged into the next evaluate call. `scrapeAll` does not
//   receive `{ urls }` from `resolveJobUrls` in the same run; on a notifications page, step 2 returns
//   `{ skipped: true, reason: 'notJobDetail' }` instead of timing out.
//
// TDD: §11.1
// Tasks: T-701, T-704
// Wave: 4
// Status: implemented (Wave 4)

(function () {
  if (globalThis['__broScenario_upwork-collect']) return;

  var JOB_PATH_RE = /\/jobs\/~\d+/;

  function sleepSync(ms) {
    var t0 = Date.now();
    while (Date.now() - t0 < ms) {
      /* busy-wait: page-world clickViewMore must block ~2s per map §3 */
    }
  }

  function normLimit(n, fallback) {
    var lim = parseInt(n, 10);
    if (!isFinite(lim) || lim < 1) return fallback;
    return lim;
  }

  function toAbsoluteHref(href) {
    try {
      return new URL(href, window.location.origin).href;
    } catch {
      return href;
    }
  }

  /**
   * @param {{ limit?: number }} args
   * @returns {{ jobId: string, time: string, href: string, type: string }[]}
   */
  function collectJobLinks(args) {
    var limit = normLimit(args && args.limit, 20);
    var list = document.querySelector('ul.notifications-list');
    if (!list) return [];
    var items = list.querySelectorAll(':scope > li');
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < items.length && out.length < limit; i++) {
      var li = items[i];
      var iconEl = li.querySelector('.notification-icon .air3-icon');
      var iconTitle = iconEl ? iconEl.getAttribute('title') || '' : '';
      var text = li.textContent || '';
      if (iconTitle === 'Jobs' && text.indexOf('New job:') !== -1) {
        var a = li.querySelector('a[href*="/jobs/~"]');
        if (!a) continue;
        var href = a.getAttribute('href') || '';
        var m = href.match(/\/jobs\/~(\d+)/);
        if (!m) continue;
        var jobId = m[1];
        if (seen[jobId]) continue;
        seen[jobId] = true;
        var timeEl = li.querySelector('.notification-date');
        out.push({
          jobId: jobId,
          time: timeEl ? timeEl.textContent.trim() : '',
          href: toAbsoluteHref(href),
          type: 'job',
        });
      } else if (iconTitle === 'Engage' && text.toLowerCase().indexOf('invitation to interview') !== -1) {
        var a2 = li.querySelector('a[href*="/interview/"]');
        if (!a2) continue;
        var href2 = a2.getAttribute('href') || '';
        var m2 = href2.match(/uid\/(\d+)/);
        if (!m2) continue;
        var uid = m2[1];
        var dk = 'inv-' + uid;
        if (seen[dk]) continue;
        seen[dk] = true;
        var timeEl2 = li.querySelector('.notification-date');
        out.push({
          jobId: uid,
          time: timeEl2 ? timeEl2.textContent.trim() : '',
          href: toAbsoluteHref(href2),
          type: 'invitation',
        });
      }
    }
    return out;
  }

  /**
   * @returns {boolean}
   */
  function clickViewMore() {
    var list = document.querySelector('ul.notifications-list');
    var before = list ? list.querySelectorAll(':scope > li').length : 0;
    var btn = document.querySelector('button[data-ev-label="View more"]');
    if (!btn) return false;
    btn.click();
    sleepSync(2000);
    var list2 = document.querySelector('ul.notifications-list');
    var after = list2 ? list2.querySelectorAll(':scope > li').length : 0;
    return after > before;
  }

  /**
   * @returns {string|null}
   */
  function detectBlockedPage() {
    var body = document.body;
    if (!body) return null;
    var t = body.textContent || '';
    if (t.indexOf('This job is no longer available') !== -1) return 'Job no longer available';
    if (t.indexOf('Access denied') !== -1) return 'Access denied';
    if (t.indexOf('This job post has been removed') !== -1) return 'Job removed';
    if (t.indexOf('Page not found') !== -1) return 'Page not found';
    return null;
  }

  function loginRequired() {
    if (window.location.pathname.startsWith('/login')) {
      throw {
        code: 'loginRequired',
        message: 'redirected to login',
        url: window.location.href,
      };
    }
  }

  function jobIdFromLocation() {
    var p = window.location.pathname || '';
    var parts = p.split('~');
    if (parts.length < 2) return '';
    return (parts[1].split('/')[0] || '').split('?')[0] || '';
  }

  function isJobDetailLocation() {
    return JOB_PATH_RE.test(window.location.pathname || '');
  }

  function findMainColumn(card) {
    return card.querySelector('.air3-card-sections:not(.sidebar)');
  }

  function mainSections(card) {
    var col = findMainColumn(card);
    if (!col) return [];
    return col.querySelectorAll(':scope > section');
  }

  function findFeaturesUl(card) {
    var sections = card.querySelectorAll('.air3-card-sections:not(.sidebar) > section');
    for (var i = 0; i < sections.length; i++) {
      var ul = sections[i].querySelector('ul.features');
      if (ul && ul.querySelector('li .description')) return ul;
    }
    return null;
  }

  function parseFeatures(featUl, out) {
    if (!featUl) return;
    var lis = featUl.querySelectorAll(':scope > li');
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var desc = li.querySelector('.description');
      var strong = li.querySelector('.strong');
      var dtext = desc ? desc.textContent.trim() : '';
      var stext = strong ? strong.textContent.trim() : '';
      var val = stext || '';
      var low = dtext.toLowerCase();
      if (stext.indexOf('$') === 0 || stext.indexOf('$') !== -1) {
        if (stext.indexOf('$') === 0) out.budget = stext;
      }
      if (low.indexOf('fixed-price') !== -1) out.jobType = 'Fixed-price';
      if (low.indexOf('hourly') !== -1) out.jobType = 'Hourly';
      if (low.indexOf('willing') !== -1 || low.indexOf('experience') !== -1) {
        if (val) out.experienceLevel = val;
      }
      if (low.indexOf('duration') !== -1 && val) out.duration = val;
      if (val.indexOf('hrs/week') !== -1 || val.toLowerCase().indexOf('hour') !== -1) {
        out.hoursPerWeek = val;
      }
      var ch0 = li.children[0];
      if (ch0 && ch0.textContent && ch0.textContent.trim() === 'Project Type:') {
        var ch1 = li.children[1];
        if (ch1) out.projectType = ch1.textContent.trim();
      }
    }
  }

  function findSectionByH5(card, needle) {
    var sections = card.querySelectorAll('.air3-card-sections:not(.sidebar) > section');
    for (var i = 0; i < sections.length; i++) {
      var h5 = sections[i].querySelector('h5');
      if (h5 && h5.textContent && h5.textContent.indexOf(needle) !== -1) return sections[i];
    }
    return null;
  }

  function activityValue(section, titleSub) {
    if (!section) return '';
    var lis = section.querySelectorAll('li');
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var title = li.querySelector('.title');
      if (title && title.textContent && title.textContent.indexOf(titleSub) !== -1) {
        var val = li.querySelector('.value');
        return val ? val.textContent.trim() : '';
      }
    }
    return '';
  }

  function screeningText(card) {
    var sections = card.querySelectorAll('.air3-card-sections:not(.sidebar) > section');
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      var tx = s.textContent || '';
      if (tx.indexOf('questions when submitting') !== -1 || tx.indexOf('Screening') !== -1) {
        return s.textContent.trim();
      }
    }
    return '';
  }

  function skillsList(card) {
    var sec = findSectionByH5(card, 'Skills and Expertise');
    if (!sec) return [];
    var badges = sec.querySelectorAll('.air3-badge');
    var arr = [];
    for (var i = 0; i < badges.length; i++) {
      var x = badges[i].textContent.trim();
      if (x) arr.push(x);
    }
    return arr;
  }

  function connectsFromCard(card) {
    var nodes = card.querySelectorAll('.text-body-sm');
    for (var i = 0; i < nodes.length; i++) {
      var tx = nodes[i].textContent || '';
      if (tx.indexOf(' Connects') !== -1) {
        var words = tx.trim().split(/\s+/);
        if (words.length) return words[0];
      }
    }
    return '';
  }

  function parseClientBlock(card, out) {
    var block = card.querySelector('.cfe-ui-job-about-client');
    if (!block) return;
    var t = block.textContent || '';
    out.paymentVerified = t.indexOf('Payment method verified') !== -1 || t.indexOf('Payment verified') !== -1;
    out.phoneVerified = t.indexOf('Phone number verified') !== -1;
    var ratingEl = block.querySelector('.rating .air3-rating');
    if (ratingEl) out.clientRating = ratingEl.textContent.trim();
    var nowrap = block.querySelector('.rating .nowrap');
    if (nowrap) out.clientReviews = nowrap.textContent.trim();

    var feat = block.querySelector('ul.features');
    if (!feat) return;
    var lis = feat.querySelectorAll(':scope > li');
    for (var i = 0; i < lis.length; i++) {
      var li = lis[i];
      var lit = li.textContent || '';
      var strong = li.querySelector('strong');
      var div = li.querySelector('div');
      if (lit.indexOf('jobs posted') !== -1 || lit.indexOf('job posted') !== -1) {
        if (strong) {
          var sw = strong.textContent.trim().split(/\s+/);
          if (sw.length) out.clientJobsPosted = sw[0];
        }
      }
      if (lit.indexOf('total spent') !== -1 && strong) {
        out.clientTotalSpent = strong.textContent.trim().split('\n')[0].trim();
      }
      if (lit.toLowerCase().indexOf('member since') !== -1) {
        var idx = lit.toLowerCase().indexOf('member since');
        out.clientMemberSince = lit.slice(idx + 13).trim();
      }
      if (div && lit.indexOf('hire rate') !== -1) {
        var parts = div.textContent.split(',');
        for (var p = 0; p < parts.length; p++) {
          if (parts[p].indexOf('hire rate') !== -1) {
            var w = parts[p].trim().split(/\s+/);
            if (w.length) out.clientHireRate = w[0];
          }
          if (parts[p].indexOf('open job') !== -1) {
            var w2 = parts[p].trim().split(/\s+/);
            if (w2.length) out.clientOpenJobs = w2[0];
          }
        }
      }
      if (lit.indexOf('hire') !== -1 && lit.indexOf('active') !== -1 && lit.indexOf('posted') === -1) {
        if (div) {
          var segs = div.textContent.split(',');
          for (var s = 0; s < segs.length; s++) {
            if (segs[s].indexOf('active') !== -1) {
              out.clientActive = segs[s].trim();
              break;
            }
          }
        }
      }
    }

    for (var j = 0; j < lis.length; j++) {
      var li2 = lis[j];
      var st = li2.querySelector('strong');
      var dv = li2.querySelector('div');
      if (!st || !dv) continue;
      var l2 = li2.textContent || '';
      if (l2.indexOf('posted') !== -1 || l2.indexOf('spent') !== -1 || l2.indexOf('hire rate') !== -1) continue;
      var spans = dv.querySelectorAll('span.nowrap');
      if (!out.clientCountry && st.textContent) {
        out.clientCountry = st.textContent.trim();
        if (spans[0]) out.clientCity = spans[0].textContent.trim();
        if (spans[1]) out.clientLocalTime = spans[1].textContent.trim();
        break;
      }
    }
  }

  /**
   * @returns {object|null} — null if card unusable
   */
  function extract() {
    var url = window.location.href;
    var jobId = jobIdFromLocation();
    var empty = {
      jobId: jobId,
      url: url,
      title: '',
      postedTime: '',
      location: '',
      description: '',
      jobType: '',
      budget: '',
      experienceLevel: '',
      duration: '',
      hoursPerWeek: '',
      projectType: '',
      screeningQuestions: [],
      skills: [],
      proposals: '',
      lastViewedByClient: '',
      interviewing: '',
      invitesSent: '',
      unansweredInvites: '',
      connects: '',
      paymentVerified: false,
      phoneVerified: false,
      clientRating: '',
      clientReviews: '',
      clientCountry: '',
      clientCity: '',
      clientLocalTime: '',
      clientJobsPosted: '',
      clientHireRate: '',
      clientOpenJobs: '',
      clientTotalSpent: '',
      clientHires: '',
      clientActive: '',
      clientMemberSince: '',
    };

    var card = document.querySelector('.job-details-card');
    if (!card) return null;

    var sections = mainSections(card);
    var first = sections[0];
    if (first) {
      var h = first.querySelector('h4, h3, h2');
      if (h) empty.title = h.textContent.trim();
      var pol = first.querySelector('.posted-on-line');
      if (pol) {
        var c0 = pol.children[0];
        var c1 = pol.children[1];
        if (c0) {
          var sp = c0.querySelector('span');
          empty.postedTime = sp ? sp.textContent.trim() : c0.textContent.trim();
        }
        if (c1) empty.location = c1.textContent.trim();
      }
      for (var si = 0; si < sections.length; si++) {
        if (sections[si].querySelector('.break')) {
          var br = sections[si].querySelector('.break');
          var ps = br.querySelector('p');
          if (ps) empty.description = ps.textContent.trim();
          else empty.description = br.textContent.trim();
          break;
        }
      }
    }

    parseFeatures(findFeaturesUl(card), empty);
    var act = findSectionByH5(card, 'Activity on this job');
    empty.proposals = activityValue(act, 'Proposals');
    empty.lastViewedByClient = activityValue(act, 'Last viewed by client');
    empty.interviewing = activityValue(act, 'Interviewing');
    empty.invitesSent = activityValue(act, 'Invites sent');
    empty.unansweredInvites = activityValue(act, 'Unanswered invites');

    var sq = screeningText(card);
    empty.screeningQuestions = sq ? [sq] : [];
    empty.skills = skillsList(card);
    empty.connects = connectsFromCard(card);
    parseClientBlock(card, empty);

    return empty;
  }

  /**
   * @param {Record<string, unknown>} args
   * @returns {{ urls: string[] }}
   */
  function resolveJobUrls(args) {
    args = args || {};
    var limit = normLimit(args.limit, 20);

    if (Array.isArray(args.jobIds) && args.jobIds.length) {
      var urls = [];
      for (var i = 0; i < args.jobIds.length; i++) {
        var id = String(args.jobIds[i]).replace(/^\~+/, '');
        urls.push('https://www.upwork.com/jobs/~' + id);
      }
      return { urls: urls };
    }

    if (Array.isArray(args.jobUrls) && args.jobUrls.length) {
      var u2 = [];
      for (var j = 0; j < args.jobUrls.length; j++) {
        u2.push(String(args.jobUrls[j]));
      }
      return { urls: u2 };
    }

    if (args.source === 'notifications') {
      var collected = collectJobLinks({ limit: limit });
      while (collected.length < limit && clickViewMore()) {
        collected = collectJobLinks({ limit: limit });
      }
      var outUrls = [];
      for (var k = 0; k < collected.length && outUrls.length < limit; k++) {
        outUrls.push(collected[k].href);
      }
      return { urls: outUrls };
    }

    throw {
      code: 'internal',
      message: 'upwork-collect requires one of jobIds, jobUrls, or source',
    };
  }

  /**
   * Reads ONLY the current tab. See architecture note at file top.
   * @param {Record<string, unknown>} _args
   * @returns {Promise<Record<string, unknown>>}
   */
  async function scrapeAll(_args) {
    loginRequired();

    if (!isJobDetailLocation()) {
      return {
        skipped: true,
        reason: 'notJobDetail',
        message:
          'Current URL is not a /jobs/~… detail page; navigate first, or use resolveJobUrls output in an agent-driven loop (Architecture A).',
        currentUrl: window.location.href,
      };
    }

    await new Promise(function (resolve) {
      setTimeout(resolve, 1500);
    });

    var url = window.location.href;
    var jobId = jobIdFromLocation();

    var blockedReason = detectBlockedPage();
    if (blockedReason) {
      return { jobId: jobId, url: url, blocked: true, blockedReason: blockedReason };
    }

    var deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (document.querySelector('.job-details-card')) break;
      await new Promise(function (r) {
        setTimeout(r, 50);
      });
    }

    var data = extract();
    if (!data) {
      return {
        jobId: jobId,
        url: url,
        blocked: true,
        blockedReason: 'No job-details-card or main sections',
      };
    }

    var result = { ok: true };
    for (var key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        result[key] = data[key];
      }
    }
    return result;
  }

  globalThis['__broScenario_upwork-collect'] = {
    resolveJobUrls: resolveJobUrls,
    scrapeAll: scrapeAll,
    collectJobLinks: collectJobLinks,
    clickViewMore: clickViewMore,
    extract: extract,
    detectBlockedPage: detectBlockedPage,
    loginRequired: loginRequired,
  };
})();

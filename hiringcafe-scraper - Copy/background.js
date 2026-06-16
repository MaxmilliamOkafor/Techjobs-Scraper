// background.js — service worker (v2.2.0 — multi-site: hiring.cafe + eurotoptech.com + simplify.jobs)

const STATE_KEY = "hiringcafe_state";
const RESULTS_KEY = "hiringcafe_results";

// Sites this extension can scrape. Add new sites here to extend support.
const SITE_MATCHES = [
  "https://hiring.cafe/*", "https://*.hiring.cafe/*",
  "https://eurotoptech.com/*", "https://*.eurotoptech.com/*",
  "https://simplify.jobs/*", "https://*.simplify.jobs/*"
];
const SITE_HOST_RE = /(^|\.)(hiring\.cafe|eurotoptech\.com|simplify\.jobs)$/i;

const FETCH_TIMEOUT_MS = 5000;
const TAB_RESOLVE_TIMEOUT_MS = 8000;
const TAB_POST_LOAD_QUIET_MS = 200;
const TAB_MAX_REDIRECT_HOPS = 8;
const MAX_CONCURRENT_TABS = 2;
const DETAIL_LOAD_TIMEOUT_MS = 15000;
const DETAIL_APPLY_POLL_INTERVAL_MS = 250;
const DETAIL_APPLY_POLL_MAX_ATTEMPTS = 60;
const REDIRECT_HOSTS = new Set(["hiring.cafe", "www.hiring.cafe"]);
// simplify.jobs job links are /jobs/click/{id} — an HTTP 302 to the employer
// ATS that must be followed in a tab (the cross-origin hop isn't fetch-readable).
const CLICK_REDIRECT_HOSTS = new Set(["simplify.jobs", "www.simplify.jobs"]);

let state = {
  status: "idle", pageIndex: 0, totalPages: null,
  scrapedThisPage: 0, totalScraped: 0, inFlight: 0,
  fetchHits: 0, tabHits: 0,
  lastError: null, startedAt: null, finishedAt: null, activeTabId: null, site: null
};

const activeAbortControllers = new Set();
const activeResolverTabs = new Set();
const activeResolverFinishers = new Set();
let resolverWindowId = null;
let cancelAll = false;

try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
      .catch((e) => console.warn("setPanelBehavior failed", e));
  }
} catch (e) { console.warn("sidePanel API missing", e); }

(async function hydrate() {
  try {
    const stored = await chrome.storage.local.get(STATE_KEY);
    if (stored && stored[STATE_KEY]) {
      state = { ...state, ...stored[STATE_KEY], inFlight: 0 };
      if (state.status === "running" || state.status === "stopping") state.status = "idle";
    }
  } catch (e) { console.warn("hydrate failed", e); }
})();

let persistTimer = null;
async function persistState() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try { await chrome.storage.local.set({ [STATE_KEY]: state }); }
    catch (e) { console.warn("persistState failed", e); }
    chrome.runtime.sendMessage({ type: "STATE_UPDATE", state }).catch(() => {});
  }, 60);
}

async function getResults() {
  const stored = await chrome.storage.local.get(RESULTS_KEY);
  return Array.isArray(stored[RESULTS_KEY]) ? stored[RESULTS_KEY] : [];
}
let pendingRows = [];
let rowFlushTimer = null;
function bufferRow(row) {
  pendingRows.push(row);
  if (rowFlushTimer) return;
  rowFlushTimer = setTimeout(flushRows, 200);
}
async function flushRows() {
  rowFlushTimer = null;
  if (pendingRows.length === 0) return;
  const batch = pendingRows; pendingRows = [];
  try {
    const results = await getResults();
    for (const r of batch) results.push(r);
    await chrome.storage.local.set({ [RESULTS_KEY]: results });
    state.totalScraped = results.length;
    persistState();
  } catch (e) {
    console.warn("flushRows failed", e);
    pendingRows = batch.concat(pendingRows);
  }
}
async function clearResults() {
  pendingRows = [];
  if (rowFlushTimer) { clearTimeout(rowFlushTimer); rowFlushTimer = null; }
  await chrome.storage.local.set({ [RESULTS_KEY]: [] });
  Object.assign(state, {
    totalScraped: 0, scrapedThisPage: 0, pageIndex: 0, totalPages: null,
    lastError: null, status: "idle", startedAt: null, finishedAt: null,
    fetchHits: 0, tabHits: 0, inFlight: 0
  });
  persistState();
}

class Semaphore {
  constructor(n) { this.permits = n; this.queue = []; }
  acquire() {
    if (this.permits > 0) { this.permits -= 1; return Promise.resolve(); }
    return new Promise((r) => this.queue.push(r));
  }
  release() {
    if (this.queue.length) this.queue.shift()();
    else this.permits += 1;
  }
}
const tabSem = new Semaphore(MAX_CONCURRENT_TABS);

function hostOf(url) { try { return new URL(url).host.toLowerCase(); } catch (_) { return ""; } }
function isAggregator(url) { return REDIRECT_HOSTS.has(hostOf(url)); }
// Strip source/tracking query params so the exported link is the clean employer
// posting (e.g. drop "?gh_src=Simplify" so "Simplify" never appears in the URL).
const TRACKING_PARAMS = new Set(["gh_src","utm_source","utm_medium","utm_campaign","utm_term","utm_content","ref","src","source","referrer"]);
function cleanFinalUrl(u) {
  if (!u) return u;
  try {
    const url = new URL(u);
    const drop = [];
    url.searchParams.forEach((v, k) => {
      if (TRACKING_PARAMS.has(k.toLowerCase()) || /simplify/i.test(v) || /simplify/i.test(k)) drop.push(k);
    });
    drop.forEach((k) => url.searchParams.delete(k));
    return url.toString();
  } catch (_) { return u; }
}

async function fetchFollow(url) {
  if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled" };
  const ctrl = new AbortController();
  activeAbortControllers.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET", redirect: "follow",
      credentials: "include", cache: "no-store",
      signal: ctrl.signal
    });
    clearTimeout(timer);
    return { ok: true, finalUrl: resp.url || url };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false, finalUrl: null,
      error: e?.name === "AbortError" ? (cancelAll ? "cancelled" : "fetch timeout") : (e?.message || String(e))
    };
  } finally { activeAbortControllers.delete(ctrl); }
}

// FAST PATH for hiring.cafe: the real employer URL is server-rendered into the
// job detail page's __NEXT_DATA__ JSON as "apply_url". A single fetch gets it —
// no hidden tab, no clicking a hrefless "Apply now" button, no popup race.
async function resolveHiringCafeApplyUrl(detailUrl) {
  if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled" };
  const ctrl = new AbortController();
  activeAbortControllers.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(detailUrl, {
      method: "GET", redirect: "follow", credentials: "include",
      cache: "no-store", signal: ctrl.signal
    });
    const html = await resp.text();
    clearTimeout(timer);
    const unescape = (s) => s.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&");
    let applyUrl = null;
    const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const scope = nd ? nd[1] : html;
    const m = scope.match(/"apply_url"\s*:\s*"([^"]+)"/);
    if (m) applyUrl = unescape(m[1]);
    return (applyUrl && /^https?:\/\//i.test(applyUrl))
      ? { ok: true, finalUrl: applyUrl }
      : { ok: false, finalUrl: null, error: "apply_url not found in detail page" };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, finalUrl: null, error: e?.name === "AbortError" ? (cancelAll ? "cancelled" : "detail fetch timeout") : (e?.message || String(e)) };
  } finally { activeAbortControllers.delete(ctrl); }
}

async function ensureResolverWindow() {
  if (resolverWindowId != null) {
    try { const w = await chrome.windows.get(resolverWindowId); if (w) return resolverWindowId; }
    catch (_) {}
    resolverWindowId = null;
  }
  try {
    const w = await chrome.windows.create({
      type: "popup", focused: false, url: "about:blank",
      left: -10000, top: -10000, width: 200, height: 200
    });
    resolverWindowId = w.id;
    try { await chrome.windows.update(w.id, { state: "minimized" }); } catch (_) {}
    return resolverWindowId;
  } catch (e) {
    console.warn("resolver window failed", e);
    resolverWindowId = null;
    return null;
  }
}
async function teardownResolverWindow() {
  if (resolverWindowId == null) return;
  try { await chrome.windows.remove(resolverWindowId); } catch (_) {}
  resolverWindowId = null;
}

function resolveByTab(initialUrl) {
  return new Promise(async (resolve) => {
    if (cancelAll) { resolve({ ok: false, finalUrl: null, error: "cancelled" }); return; }
    const winId = await ensureResolverWindow();
    let tabId = null, finalUrl = initialUrl, hops = 0, settled = false, quietTimer = null;
    const hardTimer = setTimeout(() => finish("timeout"), TAB_RESOLVE_TIMEOUT_MS);
    const onUpdated = (uId, ci) => {
      if (uId !== tabId) return;
      if (ci.url) {
        finalUrl = ci.url; hops += 1;
        if (hops > TAB_MAX_REDIRECT_HOPS) finish("too many redirects");
      }
      if (ci.status === "complete") {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish(null), TAB_POST_LOAD_QUIET_MS);
      }
    };
    const onRemoved = (rId) => { if (rId === tabId) finish(null); };
    function cleanup() {
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
      try { chrome.tabs.onRemoved.removeListener(onRemoved); } catch (_) {}
      clearTimeout(hardTimer);
      if (quietTimer) clearTimeout(quietTimer);
      if (tabId != null) activeResolverTabs.delete(tabId);
      activeResolverFinishers.delete(finish);
    }
    function finish(error) {
      if (settled) return;
      settled = true; cleanup();
      const close = () => {
        if (tabId != null) chrome.tabs.remove(tabId).catch(() => {});
        resolve({ ok: !error, finalUrl, error: error || null });
      };
      if (tabId != null) {
        chrome.tabs.get(tabId).then((t) => { if (t && t.url) finalUrl = t.url; close(); }).catch(close);
      } else resolve({ ok: false, finalUrl: null, error: error || "no tab" });
    }
    activeResolverFinishers.add(finish);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    const opts = { url: initialUrl, active: false };
    if (winId != null) opts.windowId = winId;
    chrome.tabs.create(opts).then((tab) => {
      tabId = tab.id; activeResolverTabs.add(tabId);
      finalUrl = tab.url || initialUrl;
    }).catch((e) => finish("create failed: " + (e?.message || e)));
  });
}

// ---- detail-page apply-URL finder (runs in detail tab) ----
function findApplyNowOnDetailPage(pollInterval, maxAttempts) {
  return new Promise((resolve) => {
    let attempts = 0;
    const APPLY_RE = /^Apply\s*(now|directly)?\b/i;
    const SKIP_RE = /^(View All Jobs|Website|Full View|Save|Mark Applied|Hide Job|Report|Job Posting|View all|Contact Recruiter|HiringCafe|Add Career Page|Sign up|Sign in|Log in|Login|Submit|Talent Network|About|Terms|Privacy|Reject|Accept)\b/i;
    function visText(el) {
      return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    }
    function isVisible(el) {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const cs = window.getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") return false;
      return true;
    }
    function isOffSiteHref(href) {
      if (!href || !/^https?:/i.test(href)) return false;
      try {
        const u = new URL(href, window.location.href);
        return !/(^|\.)hiring\.cafe$/i.test(u.host);
      } catch (_) { return false; }
    }
    function check() {
      const anchors = Array.from(document.querySelectorAll("a"));
      for (const a of anchors) {
        if (!isVisible(a)) continue;
        const txt = visText(a);
        if (SKIP_RE.test(txt)) continue;
        if (APPLY_RE.test(txt) && a.href && !/^javascript:/i.test(a.href)) {
          resolve({ href: a.href, label: txt, kind: "apply-anchor" }); return;
        }
      }
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        if (!isVisible(b)) continue;
        const txt = visText(b);
        if (SKIP_RE.test(txt)) continue;
        if (APPLY_RE.test(txt)) {
          for (const k of ["data-url", "data-href", "data-apply-url", "data-link"]) {
            const v = b.getAttribute(k);
            if (v && /^https?:/i.test(v)) {
              resolve({ href: v, label: txt, kind: "button-data" }); return;
            }
          }
          resolve({ href: null, label: txt, kind: "button-no-href" }); return;
        }
      }
      let bestOff = null;
      for (const a of anchors) {
        if (!isVisible(a)) continue;
        if (!isOffSiteHref(a.href)) continue;
        const txt = visText(a);
        if (SKIP_RE.test(txt)) continue;
        const r = a.getBoundingClientRect();
        const area = r.width * r.height;
        if (!bestOff || area > bestOff.area) bestOff = { el: a, txt, area };
      }
      if (bestOff && bestOff.el && bestOff.el.href) {
        resolve({ href: bestOff.el.href, label: bestOff.txt || "off-site", kind: "off-anchor" }); return;
      }
      attempts += 1;
      if (attempts < maxAttempts) setTimeout(check, pollInterval);
      else resolve({ href: null, label: "no apply target found", kind: "missing" });
    }
    check();
  });
}

async function resolveByDetailPage(detailUrl) {
  if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled" };
  if (!detailUrl) return { ok: false, finalUrl: null, error: "no detail url" };
  const winId = await ensureResolverWindow();
  let tabId = null;
  try {
    const opts = { url: detailUrl, active: false };
    if (winId != null) opts.windowId = winId;
    const tab = await chrome.tabs.create(opts);
    tabId = tab.id;
    activeResolverTabs.add(tabId);
    await new Promise((resolve) => {
      let done = false;
      const onUpdated = (id, ci) => {
        if (id === tabId && ci.status === "complete") finish();
      };
      function finish() {
        if (done) return;
        done = true;
        try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
        resolve();
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(finish, DETAIL_LOAD_TIMEOUT_MS);
    });
    if (cancelAll) {
      return { ok: false, finalUrl: null, error: "cancelled" };
    }
    const inj = await chrome.scripting.executeScript({
      target: { tabId },
      func: findApplyNowOnDetailPage,
      args: [DETAIL_APPLY_POLL_INTERVAL_MS, DETAIL_APPLY_POLL_MAX_ATTEMPTS],
      world: "MAIN"
    });
    const r = inj && inj[0] && inj[0].result;
    if (r && r.href) {
      return { ok: true, finalUrl: r.href, kind: r.kind, label: r.label };
    }

    if (r && r.kind === "button-no-href") {
      const spawned = await new Promise((resolve) => {
        let settled = false;
        let spawnedTabId = null;
        let quietTimer = null;
        const hardTimer = setTimeout(() => finish("timeout waiting for ATS tab"), TAB_RESOLVE_TIMEOUT_MS);
        const onCreated = (newTab) => {
          if (newTab.openerTabId === tabId) {
            spawnedTabId = newTab.id;
            activeResolverTabs.add(spawnedTabId);
          }
        };
        const onUpdated = (id, changeInfo, updatedTab) => {
          if (spawnedTabId == null) return;
          if (id !== spawnedTabId) return;
          if (quietTimer) clearTimeout(quietTimer);
          if (changeInfo.status === "complete" || changeInfo.url || (updatedTab && updatedTab.url)) {
            quietTimer = setTimeout(async () => {
              try {
                const t = await chrome.tabs.get(spawnedTabId);
                const url = t?.url || updatedTab?.url || "";
                finish(null, url);
              } catch (e) {
                finish(e?.message || String(e));
              }
            }, TAB_POST_LOAD_QUIET_MS + 400);
          }
        };
        function cleanup() {
          try { chrome.tabs.onCreated.removeListener(onCreated); } catch (_) {}
          try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (_) {}
          try { clearTimeout(hardTimer); } catch (_) {}
          if (quietTimer) {
            try { clearTimeout(quietTimer); } catch (_) {}
          }
        }
        async function finish(error, finalUrl = null) {
          if (settled) return;
          settled = true;
          cleanup();
          if (spawnedTabId != null) {
            try {
              activeResolverTabs.delete(spawnedTabId);
              await chrome.tabs.remove(spawnedTabId);
            } catch (_) {}
          }
          if (error) resolve({ ok: false, error, finalUrl: finalUrl || null });
          else resolve({ ok: true, error: null, finalUrl });
        }
        chrome.tabs.onCreated.addListener(onCreated);
        chrome.tabs.onUpdated.addListener(onUpdated);

        chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: () => {
            const APPLY_RE = /^Apply\s*now\b/i;
            const SKIP_RE = /^(View All Jobs|Website|Full View|Save|Mark Applied|Hide Job|Report)\b/i;
            const all = Array.from(document.querySelectorAll("a, button"));
            for (const el of all) {
              const txt = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
              if (!txt || SKIP_RE.test(txt)) continue;
              if (!APPLY_RE.test(txt)) continue;
              try {
                el.click();
                return { clicked: true, tag: el.tagName.toLowerCase(), text: txt };
              } catch (e) {
                return { clicked: false, error: e?.message || String(e) };
              }
            }
            return { clicked: false, error: "apply now element not clickable" };
          }
        }).catch((e) => finish(e?.message || String(e)));
      });
      if (spawned.ok && spawned.finalUrl && !isAggregator(spawned.finalUrl)) {
        return {
          ok: true,
          finalUrl: spawned.finalUrl,
          kind: "button-click-tab",
          label: r.label || "Apply now"
        };
      }
      return {
        ok: false,
        finalUrl: spawned.finalUrl || null,
        error: spawned.error || "apply now button did not open ATS url"
      };
    }
    return {
      ok: false,
      finalUrl: null,
      error: (r && r.kind) ? ("apply now: " + r.kind) : "apply now not resolvable"
    };
  } catch (e) {
    return { ok: false, finalUrl: null, error: "detail open failed: " + (e?.message || e) };
  } finally {
    if (tabId != null) {
      activeResolverTabs.delete(tabId);
      chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

async function resolveJobUrl(initialUrl) {
  if (!initialUrl) return { ok: false, finalUrl: null, error: "empty url", method: "none" };
  if (cancelAll) return { ok: false, finalUrl: null, error: "cancelled", method: "none" };
  state.inFlight += 1; persistState();
  try {
    const startHost = hostOf(initialUrl);
    if (REDIRECT_HOSTS.has(startHost)) {
      // FAST PATH: read the employer URL straight from the detail page's
      // __NEXT_DATA__ ("apply_url"). One fetch, no tab/popup. Only if this
      // fails do we fall back to the original tab-based detail resolution.
      const fast = await resolveHiringCafeApplyUrl(initialUrl);
      if (fast.ok && fast.finalUrl) {
        const ff = await fetchFollow(fast.finalUrl);
        const finalUrl = (ff.ok && ff.finalUrl && !isAggregator(ff.finalUrl)) ? ff.finalUrl : fast.finalUrl;
        state.fetchHits += 1;
        return { ok: true, finalUrl, applyInitial: fast.finalUrl, method: "detail-nextdata" };
      }
      if (cancelAll) return { ok: false, finalUrl: initialUrl, error: "cancelled", method: "none" };
      await tabSem.acquire();
      let applyUrl = null, applyKind = "";
      try {
        if (cancelAll) return { ok: false, finalUrl: initialUrl, error: "cancelled", method: "none" };
        const d = await resolveByDetailPage(initialUrl);
        if (!d.ok) return { ...d, applyInitial: initialUrl, method: "detail-fail" };
        applyUrl = d.finalUrl; applyKind = d.kind || "";
      } finally { tabSem.release(); }
      if (cancelAll) return { ok: false, finalUrl: applyUrl, error: "cancelled", method: "detail" };
      const f = await fetchFollow(applyUrl);
      if (f.ok && f.finalUrl && !isAggregator(f.finalUrl)) {
        state.fetchHits += 1;
        return { ok: true, finalUrl: f.finalUrl, applyInitial: applyUrl, method: "detail+fetch", kind: applyKind };
      }
      if (cancelAll) return { ok: false, finalUrl: f.finalUrl || applyUrl, error: "cancelled", method: "detail+fetch" };
      await tabSem.acquire();
      try {
        if (cancelAll) return { ok: false, finalUrl: f.finalUrl || applyUrl, error: "cancelled", method: "detail+fetch" };
        const t = await resolveByTab(f.finalUrl || applyUrl);
        state.tabHits += 1;
        return { ok: t.ok && !isAggregator(t.finalUrl), finalUrl: t.finalUrl, applyInitial: applyUrl, method: t.ok ? "detail+tab" : ("detail+tab:" + (t.error || "fail")), kind: applyKind };
      } finally { tabSem.release(); }
    }
    if (CLICK_REDIRECT_HOSTS.has(startHost)) {
      // FAST PATH (no tab): with broad host access the service worker can follow
      // the /jobs/click/{id} HTTP redirect with fetch and read the final ATS URL.
      const cf = await fetchFollow(initialUrl);
      if (cf.ok && cf.finalUrl && !CLICK_REDIRECT_HOSTS.has(hostOf(cf.finalUrl))) {
        state.fetchHits += 1;
        return { ok: true, finalUrl: cleanFinalUrl(cf.finalUrl), applyInitial: initialUrl, method: "click-fetch" };
      }
      if (cancelAll) return { ok: false, finalUrl: initialUrl, error: "cancelled", method: "none" };
      // FALLBACK: follow it in a tab (rare — only if the fetch can't read it).
      await tabSem.acquire();
      try {
        if (cancelAll) return { ok: false, finalUrl: initialUrl, error: "cancelled", method: "none" };
        const t = await resolveByTab(initialUrl);
        state.tabHits += 1;
        const left = t.finalUrl && !CLICK_REDIRECT_HOSTS.has(hostOf(t.finalUrl));
        return { ok: t.ok && left, finalUrl: cleanFinalUrl(t.finalUrl), applyInitial: initialUrl, method: t.ok ? "click-tab" : ("click-tab:" + (t.error || "fail")) };
      } finally { tabSem.release(); }
    }
    const f = await fetchFollow(initialUrl);
    if (f.ok && f.finalUrl && !isAggregator(f.finalUrl)) {
      state.fetchHits += 1;
      return { ok: true, finalUrl: cleanFinalUrl(f.finalUrl), applyInitial: initialUrl, method: "fetch" };
    }
    if (cancelAll) return { ok: false, finalUrl: f.finalUrl || initialUrl, error: "cancelled", method: "fetch" };
    await tabSem.acquire();
    try {
      if (cancelAll) return { ok: false, finalUrl: f.finalUrl || initialUrl, error: "cancelled", method: "fetch" };
      const t = await resolveByTab(f.finalUrl || initialUrl);
      state.tabHits += 1;
      return { ok: t.ok, finalUrl: cleanFinalUrl(t.finalUrl), applyInitial: initialUrl, method: t.ok ? "tab" : ("tab:" + (t.error || "fail")) };
    } finally { tabSem.release(); }
  } finally {
    state.inFlight -= 1; persistState();
  }
}

async function abortAllResolutions() {
  cancelAll = true;
  for (const ctrl of Array.from(activeAbortControllers)) { try { ctrl.abort(); } catch (_) {} }
  activeAbortControllers.clear();
  for (const f of Array.from(activeResolverFinishers)) { try { f("cancelled"); } catch (_) {} }
  activeResolverFinishers.clear();
  for (const id of Array.from(activeResolverTabs)) { chrome.tabs.remove(id).catch(() => {}); }
  activeResolverTabs.clear();
  await teardownResolverWindow();
}
function resetCancelFlag() { cancelAll = false; }

async function findTargetTab(preferTabId) {
  const tabs = await chrome.tabs.query({ url: SITE_MATCHES });
  if (!tabs.length) return null;
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  if (preferTabId) { const m = tabs.find((t) => t.id === preferTabId); if (m) return m; }
  return tabs[0];
}
function siteLabelFor(url) {
  const h = hostOf(url);
  if (/hiring\.cafe$/i.test(h)) return "hiring.cafe";
  if (/eurotoptech\.com$/i.test(h)) return "eurotoptech.com";
  if (/simplify\.jobs$/i.test(h)) return "simplify.jobs";
  return h || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "GET_STATE": {
          await flushRows();
          const results = await getResults();
          sendResponse({ ok: true, state, resultCount: results.length });
          return;
        }
        case "START_SCRAPE": {
          const target = await findTargetTab();
          if (!target) { sendResponse({ ok: false, error: "Open hiring.cafe or eurotoptech.com in a tab first." }); return; }
          await clearResults();
          resetCancelFlag();
          state.status = "running";
          state.startedAt = Date.now();
          state.activeTabId = target.id;
          state.site = siteLabelFor(target.url);
          state.fetchHits = 0; state.tabHits = 0;
          persistState();
          chrome.tabs.sendMessage(target.id, { type: "BEGIN_SCRAPE", options: msg.options || {} })
            .catch(async () => {
              try {
                await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
                await chrome.tabs.sendMessage(target.id, { type: "BEGIN_SCRAPE", options: msg.options || {} });
              } catch (e2) {
                state.status = "error";
                state.lastError = "Could not reach content script: " + (e2?.message || e2);
                persistState();
              }
            });
          sendResponse({ ok: true });
          return;
        }
        case "STOP_SCRAPE": {
          state.status = "stopping"; persistState();
          if (state.activeTabId != null) chrome.tabs.sendMessage(state.activeTabId, { type: "ABORT_SCRAPE" }).catch(() => {});
          await abortAllResolutions();
          state.status = "idle";
          state.finishedAt = Date.now();
          state.activeTabId = null;
          persistState();
          sendResponse({ ok: true });
          return;
        }
        case "CLEAR_RESULTS": { await clearResults(); sendResponse({ ok: true }); return; }
        case "RESOLVE_URL": { const r = await resolveJobUrl(msg.url); sendResponse(r); return; }
        case "JOB_SCRAPED": { bufferRow(msg.row); sendResponse({ ok: true }); return; }

        case "PAGE_PROGRESS": {
          state.pageIndex = msg.pageIndex ?? state.pageIndex;
          state.totalPages = msg.totalPages ?? state.totalPages;
          state.scrapedThisPage = msg.scrapedThisPage ?? 0;
          if (msg.status) state.status = msg.status;
          persistState();
          sendResponse({ ok: true });
          return;
        }
        case "SCRAPE_DONE": {
          await flushRows();
          state.status = msg.error ? "error" : "done";
          state.lastError = msg.error || null;
          state.finishedAt = Date.now();
          state.activeTabId = null;
          await teardownResolverWindow();
          persistState();
          sendResponse({ ok: true });
          return;
        }
        case "GET_RESULTS": {
          await flushRows();
          const results = await getResults();
          sendResponse({ ok: true, results });
          return;
        }
        case "START_PICKER": {
          const target = await findTargetTab(msg.tabId);
          if (!target) { sendResponse({ ok: false, error: "Open hiring.cafe or eurotoptech.com in a tab first." }); return; }
          try { await chrome.tabs.sendMessage(target.id, { type: "START_PICKER", mode: msg.mode }); }
          catch (_) {
            try {
              await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
              await chrome.tabs.sendMessage(target.id, { type: "START_PICKER", mode: msg.mode });
            } catch (e) {
              sendResponse({ ok: false, error: "Could not start picker: " + (e?.message || e) });
              return;
            }
          }
          sendResponse({ ok: true });
          return;
        }
        case "ELEMENT_PICKED": {
          chrome.runtime.sendMessage({ type: "ELEMENT_PICKED", spec: msg.spec, mode: msg.mode }).catch(() => {});
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: "unknown message type" });
      }
    } catch (e) {
      console.error("background error", e);
      try { sendResponse({ ok: false, error: e?.message || String(e) }); } catch (_) {}
    }
  })();
  return true;
});

chrome.windows.onRemoved.addListener((id) => { if (id === resolverWindowId) resolverWindowId = null; });

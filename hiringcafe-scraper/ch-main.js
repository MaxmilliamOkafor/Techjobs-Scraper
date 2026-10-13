// ch-main.js — runs in the PAGE (MAIN) world on careerhound.io.
//
// Current layout: each job is <article data-testid="job-card" data-job-id="…">
// with the title in an <h3>. There are NO <a> links on a card: the title and
// "Apply" are both <button>s, so the employer URL is not in the markup. It has
// to come from the page itself, which only this MAIN-world script can reach:
//
//   1. a URL-bearing attribute on the card or its Apply button;
//   2. the job's own data in React, found by matching the card's data-job-id
//      (matching the id — not "nearest URL" — means a grid component holding
//      every job can never hand one card another card's link);
//   3. otherwise, press Apply with opening SUPPRESSED and record where it was
//      going: window.open is stubbed, and navigations (the Navigation API
//      "navigate" event, plus anchor clicks) are recorded and cancelled, so
//      nothing opens and this search page never leaves.
//
// A destination on careerhound.io itself (a /go/… style redirect) is returned
// separately as `internal`, for the background worker to follow.
(() => {
  if (window.__chMainInjected__) return;
  window.__chMainInjected__ = true;

  const URL_KEYS = ["apply_url", "applyUrl", "apply_link", "applyLink", "application_url", "applicationUrl",
    "external_url", "externalUrl", "job_url", "jobUrl", "redirect_url", "redirectUrl", "source_url",
    "sourceUrl", "original_url", "originalUrl", "url", "link", "href"];
  const ATTR_KEYS = ["data-url", "data-href", "data-apply-url", "data-link", "data-external-url", "href"];
  const SKIP_KEYS = new Set(["_owner", "return", "child", "sibling", "alternate", "stateNode",
    "_store", "_debugOwner", "_debugSource", "ref", "dependencies"]);
  const INTERNAL_RE = /(^|\.)careerhound\.io$/i;
  const ASSET_RE = /\.(png|jpe?g|svg|gif|webp|ico|css|js|woff2?)(\?|#|$)/i;

  function abs(u) { try { return new URL(String(u), location.href).href; } catch (_) { return ""; } }
  function hostOf(u) { try { return new URL(u).host; } catch (_) { return ""; } }
  function isExternal(u) {
    if (!u || typeof u !== "string" || !/^https?:\/\//i.test(u) || ASSET_RE.test(u)) return false;
    const h = hostOf(u);
    return !!h && !INTERNAL_RE.test(h);
  }
  function isInternalLink(u) {
    if (!u || !/^https?:\/\//i.test(u)) return false;
    const h = hostOf(u);
    return INTERNAL_RE.test(h) && u.split("?")[0] !== location.href.split("?")[0];
  }
  function fiberOf(el) {
    const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$") || x.startsWith("__reactInternalInstance$"));
    return k ? el[k] : null;
  }
  const idOf = (o) => (o && (o.id ?? o.jobId ?? o.job_id ?? o.uuid ?? o._id));

  // 1) attributes
  function fromAttributes(card) {
    for (const el of [card, ...card.querySelectorAll("*")]) {
      for (const k of ATTR_KEYS) {
        const v = el.getAttribute && el.getAttribute(k);
        if (v && isExternal(abs(v))) return abs(v);
      }
    }
    return "";
  }

  // 2) React data: the object whose id equals this card's data-job-id.
  function findJobObj(card, jobId) {
    let f = fiberOf(card), d = 0;
    while (f && d < 12) {
      for (const bag of [f.memoizedProps, f.memoizedState]) {
        const hit = searchById(bag, jobId);
        if (hit) return hit;
      }
      f = f.return; d += 1;
    }
    return null;
  }
  function searchById(bag, jobId) {
    if (!bag || typeof bag !== "object") return null;
    const stack = [bag], seen = new Set();
    let steps = 0;
    while (stack.length && steps < 2500) {
      const o = stack.pop(); steps += 1;
      if (!o || typeof o !== "object" || seen.has(o)) continue;
      seen.add(o);
      if (!Array.isArray(o) && idOf(o) != null && String(idOf(o)) === jobId) return o;
      if (Array.isArray(o)) { for (const v of o) if (v && typeof v === "object") stack.push(v); continue; }
      for (const k in o) {
        if (SKIP_KEYS.has(k)) continue;
        const v = o[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return null;
  }
  // URL fields on the job object, or one level down (job.apply.url and the like).
  function urlFromObj(o) {
    const scan = (x) => {
      if (!x || typeof x !== "object") return { ext: "", internal: "" };
      let internal = "";
      for (const k of URL_KEYS) {
        const v = x[k];
        if (typeof v !== "string") continue;
        const a = abs(v);
        if (isExternal(a)) return { ext: a, internal: "" };
        if (!internal && isInternalLink(a) && k !== "href") internal = a;
      }
      return { ext: "", internal };
    };
    const top = scan(o);
    if (top.ext) return top;
    let internal = top.internal;
    for (const k in o) {
      if (SKIP_KEYS.has(k)) continue;
      const v = o[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const r = scan(v);
        if (r.ext) return r;
        if (!internal) internal = r.internal;
      }
    }
    return { ext: "", internal };
  }

  // 3) Press Apply with opening suppressed; record the destination.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function captureByClick(card) {
    const btn = Array.from(card.querySelectorAll('button, [role="button"]'))
      .find((b) => /^\s*apply\b/i.test(b.innerText || b.textContent || ""));
    if (!btn) return { ext: "", internal: "", note: "no Apply button" };
    let ext = "", internal = "";
    const rec = (u) => {
      const a = abs(u);
      if (!a) return;
      if (!ext && isExternal(a)) ext = a;
      else if (!internal && isInternalLink(a)) internal = a;
    };
    const fakeLoc = {
      get href() { return "about:blank"; }, set href(v) { rec(v); },
      assign(v) { rec(v); }, replace(v) { rec(v); }, toString() { return "about:blank"; }
    };
    const fakeWin = {
      closed: false, opener: null, close() { this.closed = true; }, focus() {}, blur() {},
      document: { write() {}, open() {}, close() {} },
      get location() { return fakeLoc; }, set location(v) { rec(v); }
    };
    const origOpen = window.open;
    window.open = function (u) { if (u) rec(u); return fakeWin; };
    const nav = window.navigation;
    const onNavigate = (e) => {
      try { rec(e.destination && e.destination.url); } catch (_) {}
      if (e.cancelable) e.preventDefault();          // never leave the search page
    };
    const onClick = (e) => {
      const a = e.target && e.target.closest && e.target.closest("a[href]");
      if (a) { rec(a.href); e.preventDefault(); }
    };
    if (nav) nav.addEventListener("navigate", onNavigate);
    document.addEventListener("click", onClick, true);
    const dialogsBefore = document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length;
    try {
      btn.click();
      const t0 = Date.now();
      // The site may fetch first and open after; give it a moment. An internal
      // hop is kept only if no external destination follows it.
      while (!ext && Date.now() - t0 < 2500) {
        if (internal && Date.now() - t0 > 600) break;
        await sleep(40);
      }
    } finally {
      window.open = origOpen;
      if (nav) nav.removeEventListener("navigate", onNavigate);
      document.removeEventListener("click", onClick, true);
    }
    // If the click raised a dialog (e.g. sign in) close it so the next card is reachable.
    let note = "";
    if (!ext && !internal && document.querySelectorAll('[role="dialog"], [aria-modal="true"]').length > dialogsBefore) {
      note = "Apply opened a dialog instead of a link (sign in to Career Hound?)";
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      await sleep(150);
    }
    return { ext, internal, note };
  }

  async function resolveIds(ids, allowClick) {
    const out = {};
    for (const id of ids) {
      const card = document.querySelector('article[data-testid="job-card"][data-job-id="' + CSS.escape(id) + '"]');
      if (!card) { out[id] = { url: "", internal: "", how: "card not mounted" }; continue; }
      const a = fromAttributes(card);
      if (a) { out[id] = { url: a, internal: "", how: "attribute" }; continue; }
      const job = findJobObj(card, id);
      const r = job ? urlFromObj(job) : { ext: "", internal: "" };
      if (r.ext) { out[id] = { url: r.ext, internal: "", how: "react-data" }; continue; }
      if (allowClick) {
        const c = await captureByClick(card);
        if (c.ext) { out[id] = { url: c.ext, internal: "", how: "apply-click" }; continue; }
        const internal = c.internal || r.internal;
        out[id] = { url: "", internal, how: internal ? "apply-click-internal" : (c.note || "apply gave no destination") };
        continue;
      }
      out[id] = { url: "", internal: r.internal, how: r.internal ? "react-data-internal" : "no url in data" };
    }
    return out;
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || !e.data || e.data.__tjsChReq == null) return;
    let results = {};
    try { results = await resolveIds(Array.isArray(e.data.ids) ? e.data.ids : [], e.data.allowClick !== false); }
    catch (err) { results = { __error: String(err) }; }
    window.postMessage({ __tjsChRes: e.data.__tjsChReq, results }, "*");
  });
})();

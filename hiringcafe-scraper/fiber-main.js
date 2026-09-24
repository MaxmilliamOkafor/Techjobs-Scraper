// fiber-main.js — MAIN-world helper for React-based job boards
// (hiring.cafe, jobright.ai, careerhound.io).
//
// Why: the content script runs in an ISOLATED world where React fiber props
// (__reactFiber$…) are invisible. These boards fetch their listings from an API
// and hold the employer/ATS apply URL in React state — it is often NOT in the
// DOM and NOT in the server-rendered HTML, which is why fetching the detail page
// and regexing for "apply_url" returns nothing. Reading the fiber gets the URL
// straight from the data the page already loaded: no network call, no hidden
// tabs, nothing to be rate-limited or bot-blocked.
//
// This is the same technique sj-main.js uses for simplify.jobs, generalised.
(() => {
  if (window.__tjsFiberMainInjected__) return;
  window.__tjsFiberMainInjected__ = true;

  const BASE_HOST = location.hostname.replace(/^www\./i, "");
  const INTERNAL_RE = new RegExp("(^|\\.)" + BASE_HOST.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i");
  // Property names that strongly indicate "this is the apply link".
  const URL_KEY_RE = /^(apply|application|external|posting|job|destination|target)?_?(url|link|href)$/i;
  // Infrastructure/asset hosts that are never an apply target.
  const NOISE_HOST_RE = /(gstatic|googleapis|google-analytics|googletagmanager|cloudflare|jsdelivr|unpkg|fontawesome|sentry|segment|intercom|hotjar|mixpanel|amplitude|datadog|logo\.dev|clearbit|gravatar|vercel|cdn)/i;
  const ASSET_RE = /\.(png|jpe?g|svg|gif|webp|ico|css|js|mjs|woff2?|ttf|map)(\?|#|$)/i;

  function isExternalApplyUrl(u) {
    if (!u || typeof u !== "string" || u.length > 2000) return false;
    if (!/^https?:\/\//i.test(u)) return false;
    if (ASSET_RE.test(u)) return false;
    try {
      const h = new URL(u).host;
      if (INTERNAL_RE.test(h)) return false;     // never an internal link
      if (NOISE_HOST_RE.test(h)) return false;   // never a CDN/analytics host
      return true;
    } catch (_) { return false; }
  }

  function fiberOf(el) {
    const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$") || x.startsWith("__reactInternalInstance$"));
    return k ? el[k] : null;
  }

  // Walk the fiber for this element (and its ancestors) looking for an external
  // URL. A value under an apply-ish key wins immediately; any other external URL
  // is kept as a weaker fallback.
  function findApplyUrl(el) {
    let fiber = fiberOf(el), depth = 0, weak = "";
    while (fiber && depth < 15) {
      for (const bag of [fiber.memoizedProps, fiber.memoizedState]) {
        if (!bag || typeof bag !== "object") continue;
        const stack = [bag], seen = new Set();
        let steps = 0;
        while (stack.length && steps < 2000) {
          const o = stack.pop(); steps += 1;
          if (!o || typeof o !== "object" || seen.has(o)) continue;
          seen.add(o);
          let entries;
          try { entries = Object.entries(o); } catch (_) { continue; }
          for (const [k, v] of entries) {
            if (typeof v === "string") {
              if (isExternalApplyUrl(v)) {
                if (URL_KEY_RE.test(k)) return v;
                if (!weak) weak = v;
              }
            } else if (v && typeof v === "object") {
              stack.push(v);
            }
          }
        }
      }
      fiber = fiber.return; depth += 1;
    }
    return weak;
  }

  const txt = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();

  // Climb to the smallest ancestor that holds a whole listing.
  function cardOf(el) {
    let node = el, safety = 0;
    while (node && node !== document.body && safety < 25) {
      if (txt(node).length > 60) return node;
      node = node.parentElement; safety += 1;
    }
    return el;
  }

  // Produce {href, title, url} entries. `href` is the board's own internal job
  // link when present — the content script already stores that as
  // job_posting_initial_url, so it makes an exact join key. `title` is a
  // fallback key for boards whose cards carry no internal job link.
  function collect() {
    const out = [];
    const seen = new Set();

    const jobLinks = Array.from(document.querySelectorAll('a[href*="/job/"], a[href*="/jobs/"], a[href*="job="]'))
      .filter((a) => a.href && !/^javascript:/i.test(a.href));
    for (const a of jobLinks) {
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      const card = cardOf(a);
      const url = findApplyUrl(card) || findApplyUrl(a);
      if (url) out.push({ href: a.href, title: "", url });
    }

    // Boards with no internal job links (e.g. jobright): key on the apply control's card title.
    if (!out.length) {
      const controls = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        .filter((el) => /\b(apply\s+with\s+autofill|apply\s+now|apply)\b/i.test(txt(el)));
      const cards = new Set();
      for (const c of controls) cards.add(cardOf(c));
      for (const card of cards) {
        const url = findApplyUrl(card);
        if (!url) continue;
        const h = card.querySelector("h1,h2,h3,h4,h5,h6");
        out.push({ href: "", title: h ? txt(h) : txt(card).slice(0, 80), url });
      }
    }
    return out;
  }

  function probe() {
    const links = document.querySelectorAll('a[href*="/job/"], a[href*="/jobs/"], a[href*="job="]').length;
    const sample = document.querySelector('a[href*="/job/"], a[href*="/jobs/"], a[href*="job="]');
    return {
      host: location.hostname,
      jobLinks: links,
      reactDetected: !!(sample && fiberOf(sample)),
      found: collect().length
    };
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__tjsFiberReq == null) return;
    let payload;
    try { payload = { entries: collect(), probe: probe() }; }
    catch (err) { payload = { entries: [], probe: { error: String(err) } }; }
    payload.__tjsFiberRes = e.data.__tjsFiberReq;
    window.postMessage(payload, "*");
  });
})();

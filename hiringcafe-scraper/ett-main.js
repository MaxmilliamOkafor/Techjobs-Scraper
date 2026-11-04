// ett-main.js — MAIN-world helper for eurotoptech.com (runs at document_start).
//
// The job list comes from POST /api/jobs, whose body holds every filter set on
// the page (city, country, seniority, workplace, search, sort …). This helper
// only LISTENS: it remembers the body of the page's latest /api/jobs request so
// the content script can request the same search page by page, instead of
// clicking every card. It never sends a request of its own.
(() => {
  if (window.__ettMainInjected__) return;
  window.__ettMainInjected__ = true;

  let lastBody = null;
  const isJobs = (u) => /\/api\/jobs(\?|$)/.test(String(u || "").replace(/^https?:\/\/[^/]+/, ""));
  function keep(body) {
    try {
      const b = typeof body === "string" ? JSON.parse(body) : null;
      if (b && typeof b === "object" && b.filters) lastBody = b;
    } catch (_) {}
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (isJobs(url) && init && init.body) keep(init.body);
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__ettReq) return;
    window.postMessage({ __ettRes: e.data.__ettReq, body: lastBody }, "*");
  });
})();

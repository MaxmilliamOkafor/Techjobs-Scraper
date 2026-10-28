// notify-main.js — MAIN-world helper for app.notify.careers (runs at document_start).
//
// Notify's job list (/postings) is a grid of cards, 16 more per "show more"
// press. Each card already links to the employer's posting, but the card text
// only has company, date and countries. The page fetches each batch of jobs
// from its search service; this helper only LISTENS to those responses (it
// never sends a request of its own) and keeps each job's details (salary,
// workplace type, experience level, fields …) by posting URL, so the content
// script can add them to the rows it reads off the cards.
(() => {
  if (window.__nfyMainInjected__) return;
  window.__nfyMainInjected__ = true;

  const byUrl = new Map();   // posting url -> compact job
  const norm = (u) => String(u || "").trim().replace(/\/+$/, "");

  function keep(doc) {
    if (!doc || typeof doc !== "object" || typeof doc.url !== "string") return;
    byUrl.set(norm(doc.url), {
      url: doc.url, title: doc.title || "", company: doc.company_name || "",
      locations: Array.isArray(doc.locations) ? doc.locations : [],
      countries: Array.isArray(doc.countries) ? doc.countries : [],
      workplace_type: doc.workplace_type || "",
      experience_levels: Array.isArray(doc.experience_levels) ? doc.experience_levels : [],
      fields: Array.isArray(doc.fields) ? doc.fields : [],
      salary_min: doc.salary_min, salary_max: doc.salary_max,
      salary_currency: doc.salary_currency || "", salary_period: doc.salary_period || "",
      hourly_salary: doc.hourly_salary, posted: doc.posted,
      offers_sponsorship: doc.offers_sponsorship
    });
  }
  function ingest(json) {
    try {
      for (const r of (json && json.results) || []) for (const h of (r && r.hits) || []) keep(h && h.document);
    } catch (_) {}
  }
  const isSearch = (u) => /multi_search|\/documents\/search/.test(String(u || ""));

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (isSearch(url)) p.then((r) => r.clone().json()).then(ingest).catch(() => {});
      } catch (_) {}
      return p;
    };
  }
  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { try { this.__nfyUrl = u; } catch (_) {} return XO.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (isSearch(this.__nfyUrl)) this.addEventListener("load", () => {
        try { ingest(this.responseType === "json" ? this.response : JSON.parse(this.responseText)); } catch (_) {}
      });
    } catch (_) {}
    return XS.apply(this, arguments);
  };

  // Bridge to the isolated content script: details for the given posting URLs.
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__nfyReq) return;
    const out = {};
    for (const u of Array.isArray(e.data.urls) ? e.data.urls : []) { const d = byUrl.get(norm(u)); if (d) out[u] = d; }
    window.postMessage({ __nfyRes: e.data.__nfyReq, jobs: out, cached: byUrl.size }, "*");
  });
})();

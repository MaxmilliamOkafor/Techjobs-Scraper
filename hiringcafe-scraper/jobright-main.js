// jobright-main.js — MAIN-world helper for jobright.ai (runs at document_start).
//
// jobright's job lists (/jobs/recommend, /jobs/liked, /jobs/applied, ...) are a
// VIRTUALISED infinite-scroll list: only ~8-14 cards exist in the DOM at once,
// and the card itself never contains the employer's apply URL. The list API
// (/swan/recommend/list/jobs, ...) returns every job's full `jobResult`,
// including `applyLink` / `originalUrl` (the real Greenhouse / Workday / iCIMS
// ... URL). That API is a server-side cursor — each page is served ONCE — so the
// scraper must never call it itself. Instead we passively observe the page's own
// fetch/XHR responses, cache every job by id, and hand the cache to content.js
// on request via window.postMessage.
(() => {
  if (window.__jrMainInjected__) return;
  window.__jrMainInjected__ = true;

  const cache = new Map(); // jobId -> compact row

  function compact(item) {
    const jr = item.jobResult || {};
    const cr = item.companyResult || {};
    return {
      id: jr.jobId,
      title: jr.jobTitle || "",
      company: cr.companyName || "",
      location: jr.jobLocation || "",
      locations: Array.isArray(jr.jobLocations) ? jr.jobLocations : [],
      is_remote: !!jr.isRemote,
      work_model: jr.workModel || "",
      salary: jr.salaryDesc || "",
      employment_type: jr.employmentType || "",
      seniority: jr.jobSeniority || "",
      min_yoe: jr.minYearsOfExperience,
      posted: jr.publishTimeDesc || "",
      publish_time: jr.publishTime || "",
      apply_link: jr.applyLink || "",
      original_url: jr.originalUrl || "",
      summary: jr.jobSummary || "",
      skills: Array.isArray(jr.jdCoreSkills)
        ? jr.jdCoreSkills.map((s) => (s && (s.skill || s.name)) || s).filter((s) => typeof s === "string")
        : [],
      score: item.displayScore
    };
  }

  // Walk any JSON payload and pick out { jobResult: { jobId } } objects.
  function harvest(obj, depth) {
    if (!obj || typeof obj !== "object" || depth > 8) return;
    if (Array.isArray(obj)) { for (const x of obj) harvest(x, depth + 1); return; }
    if (obj.jobResult && typeof obj.jobResult === "object" && obj.jobResult.jobId) {
      try { cache.set(obj.jobResult.jobId, compact(obj)); } catch (_) {}
      return;
    }
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === "object") harvest(v, depth + 1);
    }
  }
  function isJobApi(url) { return /\/swan\//.test(String(url || "")); }
  function ingestText(text) {
    if (!text || text[0] !== "{" && text[0] !== "[") return;
    try { harvest(JSON.parse(text), 0); } catch (_) {}
  }

  // --- fetch hook ---
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (isJobApi(url)) {
          p.then((resp) => {
            try { resp.clone().text().then(ingestText).catch(() => {}); } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  }

  // --- XHR hook (axios uses XHR) ---
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__jrUrl = url; } catch (_) {}
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    try {
      if (isJobApi(this.__jrUrl)) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text") ingestText(this.responseText);
            else if (this.responseType === "json") harvest(this.response, 0);
          } catch (_) {}
        });
      }
    } catch (_) {}
    return XS.apply(this, arguments);
  };

  // Also harvest SSR data on detail pages (/jobs/info/{id}).
  function harvestNextData() {
    try {
      const el = document.getElementById("__NEXT_DATA__");
      if (el) harvest(JSON.parse(el.textContent), 0);
    } catch (_) {}
  }
  document.addEventListener("DOMContentLoaded", harvestNextData);

  // --- bridge to the isolated content script ---
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || !e.data.__jrReq) return;
    const ids = Array.isArray(e.data.ids) ? e.data.ids : null;
    const rows = [];
    if (ids) { for (const id of ids) { const r = cache.get(id); if (r) rows.push(r); } }
    else rows.push(...cache.values());
    window.postMessage({ __jrRes: e.data.__jrReq, rows }, "*");
  });
})();

// sj-main.js — runs in the PAGE (MAIN) world on simplify.jobs.
//
// Why this file exists: the regular content script runs in an ISOLATED world
// where React fiber properties (__reactFiber$…) on DOM nodes are invisible.
// simplify.jobs carries the job UUID + fields inside that fiber's job object
// (the card DOM has no job id / no apply href). So this MAIN-world script reads
// the fibers and answers the content script's postMessage request with
// serialized rows. No inline injection → no page-CSP issues.
//
// Hardened after a simplify.jobs redesign (routing moved to /search?job=<uuid>):
//  * card lookup no longer depends solely on [data-testid="job-card"],
//  * the fiber walk accepts any job-shaped object, not only a literal `hit`,
//  * any apply/external URL present on the job object is returned directly, so
//    we can skip the /jobs/click/<id> redirect entirely when it's available.
(() => {
  if (window.__sjMainInjected__) return;
  window.__sjMainInjected__ = true;

  // Candidate URL fields seen on simplify job objects. First external match wins.
  const URL_KEYS = [
    "apply_url", "applyUrl", "application_url", "applicationUrl",
    "job_url", "jobUrl", "external_url", "externalUrl",
    "posting_url", "postingUrl", "url", "link"
  ];
  function isExternal(u) {
    if (!u || typeof u !== "string" || !/^https?:\/\//i.test(u)) return false;
    try { return !/(^|\.)simplify\.jobs$/i.test(new URL(u).host); } catch (_) { return false; }
  }
  function pickUrl(o) {
    for (const k of URL_KEYS) if (isExternal(o[k])) return o[k];
    return "";
  }
  // A job-shaped object: has some id AND a title. Company/locations raise
  // confidence but aren't required (field names have changed before).
  function looksLikeJob(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    const id = o.posting_id || o.id || o.objectID || o.job_id || o.jobId || o.uuid;
    if (!id || typeof o.title !== "string" || !o.title) return false;
    return true;
  }

  function getHit(el) {
    const fk = Object.keys(el).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (!fk) return null;
    let fiber = el[fk], depth = 0;
    while (fiber && depth < 15) {
      for (const bag of [fiber.memoizedProps, fiber.memoizedState]) {
        if (!bag || typeof bag !== "object") continue;
        const stack = [bag];
        const seen = new Set();
        let steps = 0;
        while (stack.length && steps < 1200) {
          const o = stack.pop(); steps += 1;
          if (!o || typeof o !== "object" || seen.has(o)) continue;
          seen.add(o);
          // Preferred: an explicit `hit` (the original Algolia shape).
          if (looksLikeJob(o.hit)) return o.hit;
          // Fallback: this object itself looks like a job.
          if (looksLikeJob(o)) return o;
          for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
        }
      }
      fiber = fiber.return; depth += 1;
    }
    return null;
  }

  // Card lookup with progressive fallbacks so a testid/class rename can't zero
  // this out. Returns the clickable/​container element for each job card.
  function findCardEls() {
    const tries = [
      '[data-testid="job-card"]',
      '[data-testid*="job-card" i]',
      '[data-testid*="jobcard" i]',
      '[data-testid*="job" i]',
      'a[href*="job="]',
      'a[href*="/jobs/"]'
    ];
    for (const sel of tries) {
      let els;
      try { els = Array.from(document.querySelectorAll(sel)); } catch (_) { continue; }
      if (els.length) {
        const out = [], seen = new Set();
        for (const e of els) {
          const c = e.closest("button, article, li, a") || e;
          if (!seen.has(c)) { seen.add(c); out.push(c); }
        }
        if (out.length) return out;
      }
    }
    return [];
  }

  function extractAll() {
    const rows = [];
    const seenIds = new Set();
    for (const el of findCardEls()) {
      const h = getHit(el);
      if (!h) continue;
      const id = h.posting_id || h.id || h.objectID || h.job_id || h.jobId || h.uuid || "";
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      rows.push({
        id: id,
        // Direct apply URL when the job object carries one — lets the content
        // script skip the /jobs/click/<id> redirect entirely.
        apply_url: pickUrl(h),
        title: h.title || "",
        company: h.company_name || h.company || "",
        locations: Array.isArray(h.locations) ? h.locations : [],
        type: h.type || "",
        travel: h.travel_requirements || "",
        experience: Array.isArray(h.experience_level) ? h.experience_level : [],
        functions: Array.isArray(h.functions) ? h.functions : [],
        majors: Array.isArray(h.majors) ? h.majors : [],
        min_salary: h.min_salary || null,
        max_salary: h.max_salary || null,
        currency_type: h.currency_type || "",
        salary_period: h.salary_period || null
      });
    }
    return rows;
  }

  // Diagnostic: lets the content script report WHY extraction found nothing.
  function probe() {
    const els = findCardEls();
    return { cardEls: els.length, withFiber: els.filter((e) => getHit(e)).length };
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__sjReq == null) return;
    try {
      window.postMessage({ __sjRes: e.data.__sjReq, rows: extractAll(), probe: probe() }, "*");
    } catch (err) {
      window.postMessage({ __sjRes: e.data.__sjReq, rows: [], probe: { error: String(err) } }, "*");
    }
  });
})();

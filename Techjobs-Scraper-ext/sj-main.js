// sj-main.js — runs in the PAGE (MAIN) world on simplify.jobs.
//
// Why this file exists: the regular content script runs in an ISOLATED world
// where React fiber properties (__reactFiber$…) on DOM nodes are invisible.
// simplify.jobs only carries the job UUID + fields inside that fiber's `hit`
// object (the card DOM has no job id / no apply href). So this MAIN-world
// script reads the fibers and answers the content script's postMessage request
// with serialized rows. No inline injection → no page-CSP issues.
(() => {
  if (window.__sjMainInjected__) return;
  window.__sjMainInjected__ = true;

  function getHit(btn) {
    const fk = Object.keys(btn).find((k) => k.startsWith("__reactFiber$"));
    if (!fk) return null;
    let fiber = btn[fk], depth = 0;
    while (fiber && depth < 10) {
      const mp = fiber.memoizedProps;
      if (mp && typeof mp === "object") {
        const stack = [mp]; let steps = 0;
        while (stack.length && steps < 400) {
          const o = stack.pop(); steps += 1;
          if (!o || typeof o !== "object") continue;
          if (o.hit && typeof o.hit === "object" && o.hit.id && o.hit.title) return o.hit;
          for (const v of Object.values(o)) if (v && typeof v === "object") stack.push(v);
        }
      }
      fiber = fiber.return; depth += 1;
    }
    return null;
  }

  function extractAll() {
    const cards = Array.from(document.querySelectorAll('[data-testid="job-card"]'))
      .map((c) => c.closest("button") || c);
    const rows = [];
    for (const btn of cards) {
      const h = getHit(btn);
      if (!h) continue;
      rows.push({
        id: h.posting_id || h.id || h.objectID || "",
        title: h.title || "",
        company: h.company_name || "",
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

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__sjReq == null) return;
    try {
      window.postMessage({ __sjRes: e.data.__sjReq, rows: extractAll() }, "*");
    } catch (_) {
      window.postMessage({ __sjRes: e.data.__sjReq, rows: [] }, "*");
    }
  });
})();

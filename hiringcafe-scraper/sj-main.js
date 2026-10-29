// sj-main.js — runs in the PAGE (MAIN) world on simplify.jobs.
//
// Why this file exists: the regular content script runs in an ISOLATED world
// where React fiber properties (__reactFiber$…) on DOM nodes are invisible.
// simplify.jobs keeps each job's data only in React; the rendered markup has no
// job id. This MAIN-world script reads the fibers and answers the content
// script's postMessage request with serialized rows.
//
// Current layout (Sept 2026 redesign): each job is a plain <li> inside
// [data-testid="custom-hits"] (which is also the scrolling element), with
// generated styling classes — no link and no job id anywhere in the DOM. The full
// job object (id, title, company, locations, work mode, level, functions,
// last-updated) is attached to that <li> by React. So cards are found by what
// their React data CONTAINS, never by markup, and each one found is tagged with
// data-tjs-sj="<id>" so the isolated content script (which cannot see fibers,
// but can see attributes) knows which elements are job cards for scrolling.
//
// The old layout ([data-testid="job-card"] inside a <button>) is still
// recognised first, in case it is served to some accounts or rolled back.
// Versioned: a tab open since before an update can still hold an OLD copy of
// this helper, which knows only the pre-redesign layout and answers with
// nothing. New flag and message names mean the old copy neither blocks this one
// from installing nor answers the content script's requests.
(() => {
  if (window.__sjMainV3__) return;
  window.__sjMainV3__ = true;

  const TAG = "data-tjs-sj";

  // Candidate URL fields seen on simplify job objects. First external match wins.
  const URL_KEYS = [
    "apply_url", "applyUrl", "application_url", "applicationUrl",
    "job_url", "jobUrl", "external_url", "externalUrl",
    "posting_url", "postingUrl", "url", "link"
  ];
  // Fiber/element plumbing that leads OUT of this card into the rest of the
  // app. Following these turns a per-card search into a whole-page search, which
  // finds some other job (or every job) instead of this card's own.
  const SKIP_KEYS = new Set(["_owner", "return", "child", "sibling", "alternate",
    "stateNode", "_store", "_debugOwner", "_debugSource", "ref", "dependencies"]);

  function isExternal(u) {
    if (!u || typeof u !== "string" || !/^https?:\/\//i.test(u)) return false;
    try { return !/(^|\.)simplify\.jobs$/i.test(new URL(u).host); } catch (_) { return false; }
  }
  function pickUrl(o) {
    for (const k of URL_KEYS) if (isExternal(o[k])) return o[k];
    return "";
  }
  function jobId(o) {
    return (o && (o.posting_id || o.id || o.objectID || o.job_id || o.jobId || o.uuid)) || "";
  }
  // A job-shaped object: some scalar id AND a non-empty title.
  function looksLikeJob(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return false;
    const id = jobId(o);
    if (!id || (typeof id !== "string" && typeof id !== "number")) return false;
    return typeof o.title === "string" && o.title.length > 0;
  }
  function fiberOf(el) {
    const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$") || x.startsWith("__reactInternalInstance$"));
    return k ? el[k] : null;
  }

  // Bounded search of one props/state bag for a job object.
  function findJobIn(bag, budget) {
    if (!bag || typeof bag !== "object") return null;
    const stack = [bag], seen = new Set();
    let steps = 0;
    while (stack.length && steps < budget) {
      const o = stack.pop(); steps += 1;
      if (!o || typeof o !== "object" || seen.has(o)) continue;
      seen.add(o);
      if (looksLikeJob(o.hit)) return o.hit;       // original Algolia shape
      if (looksLikeJob(o.job)) return o.job;
      if (looksLikeJob(o)) return o;
      if (Array.isArray(o)) { for (const v of o) if (v && typeof v === "object") stack.push(v); continue; }
      for (const k in o) {
        if (SKIP_KEYS.has(k)) continue;
        const v = o[k];
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return null;
  }

  // Verified location on the live page: the card component above each <li>
  // carries the job as props.job, within ~4 fiber levels.
  function directJob(el) {
    let f = fiberOf(el);
    for (let i = 0; i < 6 && f; i++) {
      const j = f.memoizedProps && f.memoizedProps.job;
      if (looksLikeJob(j)) return j;
      f = f.return;
    }
    return null;
  }

  // The job belonging to THIS element: nearest match walking up the fiber.
  // Depth-limited so it never climbs as far as the list component, whose props
  // hold every job and would hand back the first one for every card.
  function getHit(el) {
    let fiber = fiberOf(el), depth = 0;
    while (fiber && depth < 8) {
      const hit = findJobIn(fiber.memoizedProps, 600) || findJobIn(fiber.memoizedState, 300);
      if (hit) return hit;
      fiber = fiber.return; depth += 1;
    }
    return null;
  }

  // The list component usually holds the loaded results as an array. Reading
  // that directly catches every loaded job even if a card-to-job mapping
  // misfires. Only arrays where most entries are jobs count.
  function harvestArrays(fromEls, out) {
    const seenFibers = new Set();
    for (const el of fromEls.slice(0, 4)) {
      let f = fiberOf(el), d = 0;
      while (f && d < 30) {
        if (!seenFibers.has(f)) {
          seenFibers.add(f);
          for (const bag of [f.memoizedProps, f.memoizedState]) scanForJobArrays(bag, out);
        }
        f = f.return; d += 1;
      }
    }
  }
  function scanForJobArrays(bag, out) {
    if (!bag || typeof bag !== "object") return;
    const stack = [[bag, 0]], seen = new Set();
    let steps = 0;
    while (stack.length && steps < 3000) {
      const [o, depth] = stack.pop(); steps += 1;
      if (!o || typeof o !== "object" || seen.has(o)) continue;
      seen.add(o);
      if (Array.isArray(o)) {
        const jobs = o.filter(looksLikeJob);
        if (jobs.length >= 2 && jobs.length >= o.length * 0.5) {
          for (const j of jobs) { const id = String(jobId(j)); if (!out.has(id)) out.set(id, j); }
          continue;
        }
        if (depth < 10) for (const v of o) if (v && typeof v === "object") stack.push([v, depth + 1]);
        continue;
      }
      if (depth >= 10) continue;
      for (const k in o) {
        if (SKIP_KEYS.has(k)) continue;
        const v = o[k];
        if (v && typeof v === "object") stack.push([v, depth + 1]);
      }
    }
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Returns [{el, hit}] for every job card currently rendered.
  function findCards() {
    const out = [];
    // 1) Old layout, if still served.
    const legacy = Array.from(document.querySelectorAll('[data-testid="job-card"]'))
      .map((c) => c.closest("button") || c);
    for (const el of legacy) { const hit = getHit(el); if (hit) out.push({ el, hit }); }
    if (out.length) return out;

    // 2) Current layout: <li> items whose React data holds a job, inside the
    //    results container [data-testid="custom-hits"]. Scoping matters: a
    //    filter-sidebar <li> can walk up into a parent that holds every job and
    //    be mistaken for a card. Only if that container is missing do we fall
    //    back to scanning every <li> on the page. Inner <li>s (tags, location
    //    chips) inside a card are skipped — the outermost li is the card.
    const hitsBox = document.querySelector('[data-testid="custom-hits"]');
    const candidates = hitsBox ? hitsBox.querySelectorAll("li") : document.querySelectorAll("li");
    const seenIds = new Map();
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if ((el.innerText || "").trim().length < 10) continue;
      const hit = directJob(el) || getHit(el);
      if (!hit) continue;
      const id = String(jobId(hit));
      const prev = seenIds.get(id);
      if (prev && prev.contains(el)) continue;      // nested li of a card already found
      seenIds.set(id, el);
      out.push({ el, hit });
    }
    // If one id was handed to several unrelated cards, the per-card lookup
    // climbed into shared data; keep only the first of each id.
    const firstById = new Map();
    for (const c of out) { const id = String(jobId(c.hit)); if (!firstById.has(id)) firstById.set(id, c); }
    return Array.from(firstById.values());
  }

  // Mapping tolerant of the field names shifting between releases.
  const str = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
  function nameOf(v) {
    if (!v) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") return str(v.name || v.value || v.label || v.formatted_address || v.title || "");
    return str(v);
  }
  function listOf(v) {
    if (!v) return [];
    return (Array.isArray(v) ? v : [v]).map(nameOf).filter(Boolean);
  }
  function toRow(h) {
    return {
      id: String(jobId(h)),
      apply_url: pickUrl(h),
      title: h.title || "",
      company: str(h.company_name) || nameOf(h.company) || nameOf(h.organization),
      locations: listOf(h.locations || h.location),
      type: nameOf(h.type || h.employment_type || h.job_type),
      travel: nameOf(h.travel_requirements || h.work_mode || h.workplace_type || h.remote_type || h.work_type),
      experience: listOf(h.experience_level || h.experience_levels || h.level || h.seniority),
      functions: listOf(h.functions || h.categories),
      majors: listOf(h.majors),
      min_salary: h.min_salary || null,
      max_salary: h.max_salary || null,
      currency_type: h.currency_type || "",
      salary_period: h.salary_period || null,
      updated: h.updated_date || h.updated_at || h.updatedAt || h.last_updated || h.date_updated ||
               h.posted_date || h.created_at || h.createdAt || null
    };
  }

  let lastProbe = {};
  function extractAll() {
    const cards = findCards();
    const byId = new Map();
    for (const { el, hit } of cards) {
      const id = String(jobId(hit));
      try { el.setAttribute(TAG, id); } catch (_) {}
      if (!byId.has(id)) byId.set(id, hit);
    }
    const fromArrays = new Map();
    harvestArrays(cards.map((c) => c.el), fromArrays);
    for (const [id, j] of fromArrays) if (!byId.has(id)) byId.set(id, j);
    lastProbe = { hitsBox: !!document.querySelector('[data-testid="custom-hits"]'),
                  liScanned: document.querySelectorAll("li").length, cardEls: cards.length,
                  withFiber: cards.length, arrayJobs: fromArrays.size, rows: byId.size };
    return Array.from(byId.values()).map(toRow);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__sjReq3 == null) return;
    try {
      const rows = extractAll();
      window.postMessage({ __sjRes3: e.data.__sjReq3, rows, probe: lastProbe }, "*");
    } catch (err) {
      window.postMessage({ __sjRes3: e.data.__sjReq3, rows: [], probe: { error: String(err) } }, "*");
    }
  });
})();

// hnhiring.js — scrapes valid ATS apply URLs from hnhiring.com
//
// Page model: hnhiring.com renders the Hacker News "Who is Hiring?" thread as a
// single flat list — <ul class="jobs"> with one <li class="job"> per posting.
// Each <li> has a `.user a` header (the HN username), a date span, and a `.body`
// div holding the free-text comment. Apply links are plain <a> tags inside
// `.body`; their visible text is the URL itself. Most links are noise
// (LinkedIn, GitHub, Drive, Forms, company homepages), so a single posting may
// contain zero, one, or several real apply links mixed with junk.
//
// "Valid ATS job URL" here = a `.body` link whose host matches one of the four
// trackers we care about: Greenhouse, Lever, Ashby, or Rippling. Everything
// else is dropped. No modal-opening or URL-resolution is needed — the body
// links are already the final destination.
//
// This is a self-contained content script. It speaks the same message protocol
// as content.js (BEGIN_SCRAPE -> JOB_SCRAPED* -> SCRAPE_DONE), so the existing
// popup Start/Export and background row buffering work unchanged.

(() => {
  if (window.__hnhiringScraperInjected__) return;
  window.__hnhiringScraperInjected__ = true;

  let aborted = false;

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // --- ATS allowlist. Only Greenhouse, Lever, Ashby, Rippling. -------------
  // Matched against the URL hostname (path-scoped where the bare domain is a
  // marketing homepage rather than a job board). Extend this array if you later
  // want to capture more trackers.
  const ATS_PROVIDERS = [
    { name: "greenhouse", re: /(^|\.)greenhouse\.io$/i },   // boards/job-boards/app.greenhouse.io, EU subdomains
    { name: "greenhouse", re: /(^|\.)grnh\.se$/i },          // greenhouse short links
    { name: "lever",      re: /(^|\.)lever\.co$/i },         // jobs.lever.co + jobs.eu.lever.co
    { name: "ashby",      re: /(^|\.)ashbyhq\.com$/i },      // jobs.ashbyhq.com
    { name: "rippling",   re: /(^|\.)ats\.rippling\.com$/i } // ats.rippling.com job board (not the rippling.com homepage)
  ];

  // Hosts that are explicitly NOT applications — common noise on the page.
  // The allowlist already excludes these, but the denylist is a cheap, explicit
  // guard and documents intent.
  const DENY_HOST = /(^|\.)(linkedin\.com|github\.com|github\.io|gitlab\.com|drive\.google\.com|docs\.google\.com|forms\.gle|tally\.so|notion\.so|notion\.site|twitter\.com|x\.com|medium\.com|youtube\.com|youtu\.be|calendly\.com)$/i;

  // Tracking params we strip so the exported link is the canonical apply URL.
  const TRACKING_PARAMS = new Set([
    "gh_src", "utm_source", "utm_medium", "utm_campaign", "utm_term",
    "utm_content", "ref", "src", "source", "referrer"
  ]);

  function classifyATS(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl, location.href);
    } catch (e) {
      return null;
    }
    if (!/^https?:$/.test(u.protocol)) return null;
    const host = u.hostname;
    if (DENY_HOST.test(host)) return null;
    for (const p of ATS_PROVIDERS) {
      if (p.re.test(host)) {
        // Normalise: keep origin + path, drop tracking query, keep meaningful
        // query (e.g. Ashby/Greenhouse sometimes carry the job id in the path,
        // so origin+pathname is the stable canonical form).
        const url = new URL(u.origin + u.pathname);
        u.searchParams.forEach((v, k) => {
          if (!TRACKING_PARAMS.has(k.toLowerCase())) url.searchParams.set(k, v);
        });
        let clean = url.toString().replace(/\/$/, "");
        return { provider: p.name, url: clean, rawUrl };
      }
    }
    return null;
  }

  // First non-empty text line of the comment is the HN posting headline, usually
  // "Company | Role | Location | Type | ...".
  function getHeadline(li) {
    const body = li.querySelector(".body") || li;
    const txt = (body.innerText || body.textContent || "").trim();
    return txt.split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
  }

  function parseHeadline(headline) {
    const parts = headline.split("|").map((s) => s.trim());
    return {
      company: parts[0] || "",
      role: parts[1] || "",
      location: parts[2] || "",
      employment: parts[3] || ""
    };
  }

  function getJobItems() {
    let items = Array.from(document.querySelectorAll("ul.jobs > li.job"));
    if (!items.length) items = Array.from(document.querySelectorAll("li.job"));
    if (!items.length) items = Array.from(document.querySelectorAll("ul.jobs > li"));
    return items;
  }

  function scrapeHNHiring() {
    const rows = [];
    const globalSeen = new Set(); // dedupe identical apply URLs across the page
    const items = getJobItems();

    for (const li of items) {
      if (aborted) break;

      const headline = getHeadline(li);
      const meta = parseHeadline(headline);
      const userEl = li.querySelector(".user a");
      const dateEl =
        li.querySelector(".type-info") ||
        li.querySelector(".user .right") ||
        li.querySelector(".date") ||
        li.querySelector("time");
      const hnUser = userEl ? (userEl.textContent || "").trim() : "";
      const postedAt = dateEl ? (dateEl.textContent || "").trim() : "";

      // Only links INSIDE .body are apply links; the .user link is the HN profile.
      const body = li.querySelector(".body") || li;
      const localSeen = new Set();
      const atsLinks = [];
      for (const a of body.querySelectorAll("a")) {
        const hit = classifyATS(a.href);
        if (!hit) continue;
        if (localSeen.has(hit.url) || globalSeen.has(hit.url)) continue;
        localSeen.add(hit.url);
        globalSeen.add(hit.url);
        atsLinks.push(hit);
      }
      if (atsLinks.length === 0) continue; // skip postings with no valid ATS link

      // One row per ATS URL — a single HN comment can advertise several roles
      // across several apply links.
      for (const link of atsLinks) {
        rows.push({
          // Keys aligned with the extension's CSV columns so export "just works":
          url: link.url,
          title: meta.role,
          company: meta.company,
          location: meta.location,
          salary: "",
          work_mode: "",
          yoe: "",
          commitment: meta.employment,
          posted_age: postedAt,
          ats_provider: link.provider,
          // Extra context (not in the default CSV but kept on the row object):
          hn_user: hnUser,
          raw_url: link.rawUrl,
          headline: headline,
          source_url: location.href,
          status: "ok",
          method: "body-link",
          scraped_at: new Date().toISOString()
        });
      }
    }
    return rows;
  }

  async function runScrape() {
    aborted = false;
    const onListPage = !!document.querySelector("li.job");
    if (!onListPage) {
      await send("SCRAPE_DONE", {
        error:
          "No job list on this page. Open a monthly 'Who is hiring?' page " +
          "(e.g. hnhiring.com/june-2026) and run again."
      });
      return;
    }

    await send("PAGE_PROGRESS", {
      pageIndex: 1,
      totalPages: 1,
      scrapedThisPage: 0,
      status: "running"
    });

    const rows = scrapeHNHiring();

    let completed = 0;
    for (const row of rows) {
      if (aborted) break;
      await send("JOB_SCRAPED", { row });
      completed += 1;
      if (completed % 10 === 0 || completed === rows.length) {
        await send("PAGE_PROGRESS", {
          pageIndex: 1,
          totalPages: 1,
          scrapedThisPage: completed,
          status: "running"
        });
      }
    }

    await send("SCRAPE_DONE", aborted ? { error: "stopped by user" } : {});
  }

  // Expose for manual/debug use from the page console.
  window.__hnhiringScrape = scrapeHNHiring;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "BEGIN_SCRAPE") {
      runScrape().catch((e) =>
        send("SCRAPE_DONE", { error: e?.message || String(e) })
      );
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "ABORT_SCRAPE") {
      aborted = true;
      sendResponse({ ok: true });
      return;
    }
    // hnhiring has no element-picker / pagination needs; ack so the popup's
    // picker flow doesn't hang on this site.
    if (msg.type === "START_PICKER") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "STOP_PICKER") {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "PING") {
      sendResponse({ ok: true });
      return;
    }
  });
})();

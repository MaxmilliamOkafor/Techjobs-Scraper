// csv-lazyapply.js — Additive feature (does not touch the scraper).
// Upload / drag-drop one or more CSV files of job URLs, keep only the four
// supported ATS platforms, dedupe across all files, then auto-add every URL
// into the LazyApply "Add Job to Queue" field — one by one, fast.

(function () {
  // LazyApply dashboard. We drive whichever tab is open on this origin.
  const LAZYAPPLY_MATCH = ["https://app.lazyapply.com/*"];

  /** The host, so a URL is judged by where it points, not by its text. */
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); }
    catch (_) { return ""; }
  }

  // A Job URL is kept ONLY if its HOST is one of these. Everything else
  // (LinkedIn, Workday, SmartRecruiters, Personio, Indeed, …) is ignored.
  //
  // Anchored, and matched against the parsed hostname rather than tested
  // against the whole URL string. Testing the string accepts anything
  // that merely MENTIONS a supported domain: a Boolean job search of the
  // form site:greenhouse.io OR site:rippling-ats.com carries those
  // domains in its own query and would be queued as if it were a job.
  //
  // Each platform is one pattern covering every host form it ships, not
  // one per spelling. Greenhouse serves the same posting from
  // boards.greenhouse.io and job-boards.greenhouse.io, and its own API
  // returns the first of those in absolute_url; Lever has an EU host.
  // Listing only some of the spellings counts a real, live posting on a
  // supported platform as unsupported.
  const ATS_HOSTS = [
    /^(?:job-)?boards\.(?:eu\.)?greenhouse\.io$/i,
    /^jobs\.(?:eu\.)?lever\.co$/i,
    /^jobs\.ashbyhq\.com$/i,
    /^ats\.rippling\.com$/i,
    /^(?:[a-z0-9-]+\.)?rippling-ats\.com$/i,
  ];
  function isSupported(url) {
    const h = hostOf(url);
    return !!h && ATS_HOSTS.some((re) => re.test(h));
  }

  // ---- Universal URL handling -------------------------------------------
  // A CSV can reach this tool in many shapes: a "Job URL" column, a "url"
  // column, several URL columns, redirect/tracking wrappers, or no job URLs
  // at all but SEARCH pages that list them (a Boolean Google search with
  // site:greenhouse.io etc.). All of these are accepted now.

  // Search-engine result pages. These are not jobs, but the jobs are on them:
  // they are opened in a background tab and their job links collected.
  const SEARCH_HOST_RE = /^(?:google\.[a-z.]+|bing\.com|duckduckgo\.com|html\.duckduckgo\.com)$/i;
  function isSearchUrl(url) {
    const h = hostOf(url);
    if (!h || !SEARCH_HOST_RE.test(h)) return false;
    try {
      const u = new URL(url);
      return /^\/(search|html\/?)?$/i.test(u.pathname) && (u.searchParams.has("q") || u.searchParams.has("p"));
    } catch (_) { return false; }
  }

  // Redirectors (google.com/url?q=…, trackers with ?url= / ?to= …) carry the
  // real link in a query parameter. Only a value that is ITSELF a supported
  // URL is taken, so a search's "site:greenhouse.io" text never qualifies.
  function unwrap(url) {
    if (isSupported(url)) return url;
    try {
      const u = new URL(url);
      for (const [, v] of u.searchParams) {
        if (/^https?:\/\//i.test(v) && isSupported(v)) return v;
      }
    } catch (_) {}
    return url;
  }

  // One canonical form per posting, so the same job reached via http://,
  // a tracking suffix or a trailing slash is only queued once.
  const TRACKING_PARAM_RE = /^(utm_.*|gh_src|lever-source.*|lever-origin|ref|src|source|referrer|fbclid|gclid)$/i;
  function normalizeJobUrl(url) {
    try {
      const u = new URL(url);
      u.protocol = "https:";
      u.hash = "";
      for (const k of Array.from(u.searchParams.keys())) {
        if (TRACKING_PARAM_RE.test(k)) u.searchParams.delete(k);
      }
      // gh_jid only repeats the id when the path already names the job.
      if (/\/jobs\/\d+/.test(u.pathname)) u.searchParams.delete("gh_jid");
      let out = u.toString();
      if (out.endsWith("?")) out = out.slice(0, -1);
      return out.replace(/\/(?=$)/, "");
    } catch (_) { return url; }
  }

  // A board's HOME page (jobs.lever.co/acme) is on a supported host but is not
  // a posting; LazyApply cannot apply to it. Search results are full of them.
  function isJobPosting(url) {
    if (!isSupported(url)) return false;
    try {
      const u = new URL(url);
      const h = u.hostname.replace(/^www\./, "");
      const segs = u.pathname.split("/").filter(Boolean);
      if (/greenhouse\.io$/i.test(h)) return /\/jobs\/\d+/.test(u.pathname) || u.searchParams.has("token") || u.searchParams.has("gh_jid");
      if (/lever\.co$/i.test(h) || /ashbyhq\.com$/i.test(h)) return segs.length >= 2;
      return /\/jobs?\/[^/]+/.test(u.pathname) || segs.length >= 2;
    } catch (_) { return false; }
  }

  // Every URL inside a cell, not just the first: some exports put several
  // links in one cell, separated by spaces, pipes or semicolons.
  function urlsIn(cell) {
    return (String(cell || "").match(/https?:\/\/[^\s",|;<>]+/gi) || [])
      .map((u) => u.replace(/[)\].,;]+$/, ""));
  }

  const els = {
    card: document.getElementById("csv-card"),
    dropzone: document.getElementById("csv-dropzone"),
    fileInput: document.getElementById("csv-file-input"),
    startBtn: document.getElementById("csv-start-btn"),
    stopBtn: document.getElementById("csv-stop-btn"),
    delayInput: document.getElementById("csv-delay"),
    summary: document.getElementById("csv-summary"),
    progressBar: document.getElementById("csv-progress-bar"),
    log: document.getElementById("csv-log"),
  };
  if (!els.card) return; // markup not present — nothing to wire up.

  let masterList = []; // deduped, supported URLs across all files
  let nextIndex = 0;   // resume pointer: index of the first URL not yet processed
  let searchList = []; // search-result pages still to be opened for job links
  let searchIndex = 0; // resume pointer into searchList
  let sourceSig = "";  // identifies the uploaded file(s), for resuming
  let running = false;
  let stopRequested = false;

  // Progress is persisted so a run RESUMES where it stopped instead of restarting
  // from the top, and survives the side panel being torn down / reloaded mid-run
  // (which is the usual cause of it "randomly stopping").
  const LA_STATE_KEY = "lazyapply_queue_state";
  function listSignature(list) {
    return list.length + "|" + (list[0] || "") + "|" + (list[list.length - 1] || "");
  }
  function persistQueueState() {
    try {
      chrome.storage.local.set({
        [LA_STATE_KEY]: { sig: sourceSig, master: masterList, nextIndex, searches: searchList, searchIndex }
      });
    } catch (_) {}
  }
  function clearQueueState() {
    try { chrome.storage.local.remove(LA_STATE_KEY); } catch (_) {}
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function log(line) {
    els.log.textContent += line + "\n";
    els.log.scrollTop = els.log.scrollHeight;
  }
  function clearLog() { els.log.textContent = ""; }
  function setProgress(frac) {
    if (els.progressBar) els.progressBar.style.width = Math.max(0, Math.min(1, frac)) * 100 + "%";
  }

  // ---- CSV parsing -------------------------------------------------------
  // Minimal RFC-4180 parser: quoted fields, "" escapes, CRLF/CR/LF rows.
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
        continue;
      }
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* ignore, handled by \n */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // Locate the "Job URL" column. Falls back to any header containing "url".
  function findUrlColumn(header) {
    const norm = header.map((h) => (h || "").trim().toLowerCase());
    const exact = norm.indexOf("job url");
    if (exact !== -1) return exact;
    return norm.findIndex(
      (h) => h === "url" || h === "job posting (final url)" || h.includes("url")
    );
  }

  // Returns the job URLs, the SEARCH pages to expand, and what it turned away.
  //
  // Every cell of every row is scanned, whatever the columns are called, so
  // the tool no longer depends on the file having a "Job URL" column. A
  // "0 supported" still says WHY: the hosts it skipped are reported.
  function scanCsv(text) {
    const rows = parseCsv(text).filter((r) => r.some((c) => c && c.trim()));
    if (!rows.length) return { urls: [], searches: [], rejected: 0, hosts: [], rows: 0, column: -1 };
    const col = findUrlColumn(rows[0]);
    // A header row is one that holds no URL of its own.
    const hasHeader = !rows[0].some((c) => urlsIn(c).length);
    const out = [], searches = [];
    const seen = new Set(), seenSearch = new Set();
    const seenHosts = new Map();
    let rejected = 0;
    for (let r = hasHeader ? 1 : 0; r < rows.length; r++) {
      // The URL column first, so its link wins the dedupe, then the rest.
      const cells = col === -1 ? rows[r] : [rows[r][col], ...rows[r].filter((_, i) => i !== col)];
      for (const cell of cells) {
        for (const raw of urlsIn(cell)) {
          const url = unwrap(raw);
          if (isSupported(url)) {
            if (!isJobPosting(url)) continue;          // a board home page, not a job
            const n = normalizeJobUrl(url);
            if (!seen.has(n)) { seen.add(n); out.push(n); }
            continue;
          }
          if (isSearchUrl(url)) {
            if (!seenSearch.has(url)) { seenSearch.add(url); searches.push(url); }
            continue;
          }
          rejected++;
          const h = hostOf(url) || "?";
          seenHosts.set(h, (seenHosts.get(h) || 0) + 1);
        }
      }
    }
    const hosts = [...seenHosts.entries()].sort((a, b) => b[1] - a[1]);
    return { urls: out, searches, rejected, hosts, rows: rows.length - (hasHeader ? 1 : 0), column: col };
  }

  function extractUrls(text) { return scanCsv(text).urls; }

  async function readFiles(fileList) {
    const files = Array.from(fileList);
    const perFile = [];
    const seen = new Set(), seenSearch = new Set();
    const master = [], searches = [];
    for (const f of files) {
      let scan = { urls: [], searches: [], rejected: 0, hosts: [], rows: 0 };
      try { scan = scanCsv(await f.text()); }
      catch (e) { log(`⚠ Could not read ${f.name}: ${e?.message || e}`); }
      perFile.push({ name: f.name, count: scan.urls.length, searches: scan.searches.length,
        rejected: scan.rejected, hosts: scan.hosts, rows: scan.rows });
      for (const u of scan.urls) if (!seen.has(u)) { seen.add(u); master.push(u); }
      for (const u of scan.searches) if (!seenSearch.has(u)) { seenSearch.add(u); searches.push(u); }
    }
    return { perFile, master, searches };
  }

  async function handleFiles(fileList) {
    if (!fileList || !fileList.length || running) return;
    clearLog();
    setProgress(0);
    const { perFile, master, searches } = await readFiles(fileList);
    masterList = master;
    searchList = searches;
    sourceSig = listSignature(master) + "#" + listSignature(searches);
    // If this is the SAME file a previous (interrupted) run was working through,
    // resume from where it stopped rather than re-adding everything. Job links
    // already collected from search pages come back with it.
    let resumed = 0;
    nextIndex = 0; searchIndex = 0;
    try {
      const stored = await chrome.storage.local.get(LA_STATE_KEY);
      const s = stored[LA_STATE_KEY];
      if (s && s.sig === sourceSig && Array.isArray(s.master)) {
        masterList = s.master;
        nextIndex = Math.min(Math.max(0, s.nextIndex || 0), masterList.length);
        searchIndex = Math.min(Math.max(0, s.searchIndex || 0), searchList.length);
        resumed = nextIndex;
      }
    } catch (_) {}
    persistQueueState();
    const totalRaw = perFile.reduce((a, b) => a + b.count, 0);
    const lines = perFile.map((p) => {
      let line = `  • ${p.name}: ${p.count} job URL(s)`;
      if (p.searches) line += `, ${p.searches} search page(s)`;
      if (p.rejected) line += `, ${p.rejected} skipped`;
      if (!p.count && !p.searches && !p.rejected && !p.rows) line += " (no rows read)";
      return line;
    });
    const pendingSearches = searchList.length - searchIndex;
    els.summary.textContent =
      `${perFile.length} file(s) scanned\n${lines.join("\n")}` +
      `\n\nJob URLs (pre-dedupe): ${totalRaw}\nUnique to add: ${masterList.length}` +
      (searchList.length ? `\nSearch pages to open: ${pendingSearches}${searchIndex ? ` (${searchIndex} done)` : ""}` : "") +
      (resumed > 0 ? `\nAlready added: ${resumed} — will resume from #${resumed + 1}` : "");
    els.startBtn.disabled = false;   // stays live; runQueue says what is missing
    setProgress(masterList.length ? nextIndex / masterList.length : 0);
    if (masterList.length || searchList.length) {
      if (resumed > 0) log(`Loaded ${masterList.length} URL(s). ${resumed} already added — click "Add to LazyApply Queue" to resume from #${resumed + 1}.`);
      else if (masterList.length) log(`Loaded ${masterList.length} unique job URL(s).`);
      if (pendingSearches) {
        log(`Found ${pendingSearches} search page(s). Each is opened in a background tab and its`);
        log("Greenhouse / Lever / Ashby / Rippling job links are collected, then queued.");
      }
      log('Open the LazyApply Job Queue, then click "Add to LazyApply Queue".');
    }

    // Say WHY nothing came through. The reasons need different fixes and
    // the count alone distinguishes none of them.
    if (!masterList.length && !searchList.length) {
      const allHosts = new Map();
      let anyRows = 0;
      for (const p of perFile) {
        anyRows += p.rows || 0;
        for (const [h, n] of p.hosts || []) allHosts.set(h, (allHosts.get(h) || 0) + n);
      }
      if (!anyRows) {
        log("The file had no readable rows. Check it is a CSV (or a plain list of URLs).");
      } else if (!allHosts.size) {
        log(`Read ${anyRows} row(s) but found no URLs in any column.`);
      } else {
        const top = [...allHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        log(`Read ${anyRows} row(s) and found URLs, but none on a platform LazyApply queues.`);
        log("What was in the file: " + top.map(([h, n]) => `${h} (${n})`).join(", "));
        log("It queues job postings on: Greenhouse, Lever, Ashby, Rippling.");
      }
    }
  }

  // ---- Search-page expansion (runs in a background tab) ------------------
  // Injected into a search results page. Pure function: no closure.
  function readSearchPage() {
    const text = (document.body && document.body.innerText) || "";
    const captcha = /\/sorry\//.test(location.pathname) ||
      !!document.querySelector('form#captcha-form, iframe[src*="recaptcha"], #recaptcha') ||
      /unusual traffic|not a robot|verify you are human/i.test(text.slice(0, 3000));
    const consent = /consent\./.test(location.hostname);
    const hrefs = Array.from(document.querySelectorAll("a[href]")).map((a) => a.href);
    return { captcha, consent, hrefs, url: location.href };
  }

  function waitTabComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return; done = true;
        try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (_) {}
        clearTimeout(t); resolve(ok);
      };
      const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(true); };
      chrome.tabs.onUpdated.addListener(onUpd);
      const t = setTimeout(() => finish(false), timeoutMs);
      chrome.tabs.get(tabId).then((tab) => { if (tab && tab.status === "complete") setTimeout(() => finish(true), 50); }).catch(() => finish(false));
    });
  }

  async function readTab(tabId) {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: readSearchPage });
    return (res && res.result) || { captcha: false, hrefs: [] };
  }

  // Opens each search page in ONE reused background tab, collects its job
  // links and appends them to masterList. Paced to look like a person paging
  // through results. If the search engine asks for a human check, the tab is
  // brought to the front and the run waits for YOU to complete it; it is never
  // bypassed. Returns false if the run was stopped.
  async function expandSearches() {
    if (searchIndex >= searchList.length) return true;
    const seen = new Set(masterList);
    let tab = null;
    let found = 0;
    log(`\n🔎 Opening ${searchList.length - searchIndex} search page(s) to collect job links…\n`);
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      for (; searchIndex < searchList.length; searchIndex++) {
        if (stopRequested) { persistQueueState(); log(`\n■ Stopped while reading search pages (${searchIndex}/${searchList.length}).`); return false; }
        const url = searchList[searchIndex];
        setProgress(searchIndex / searchList.length);
        try { await chrome.tabs.update(tab.id, { url }); }
        catch (_) { tab = await chrome.tabs.create({ url, active: false }); }
        await waitTabComplete(tab.id, 20000);
        await sleep(800);                              // let results render

        let page = await readTab(tab.id).catch(() => ({ captcha: false, hrefs: [] }));
        if (page.captcha || page.consent) {
          log(`⚠ The search engine is asking for a check (page ${searchIndex + 1}). Complete it in the`);
          log("  tab that just opened; collection continues by itself once it's done.");
          try {
            await chrome.tabs.update(tab.id, { active: true });
            const t = await chrome.tabs.get(tab.id);
            await chrome.windows.update(t.windowId, { focused: true });
          } catch (_) {}
          const deadline = Date.now() + 10 * 60 * 1000;
          for (;;) {
            if (stopRequested) { persistQueueState(); log("\n■ Stopped."); return false; }
            if (Date.now() > deadline) { persistQueueState(); log(`\n■ Check not completed in 10 min — paused at search page ${searchIndex + 1}. Click "Add to LazyApply Queue" to resume.`); return false; }
            await sleep(2000);
            page = await readTab(tab.id).catch(() => ({ captcha: true, hrefs: [] }));
            if (!page.captcha && !page.consent) break;
          }
          // Back on the results (the engine usually returns there itself).
          if (!isSearchUrl(page.url)) {
            await chrome.tabs.update(tab.id, { url });
            await waitTabComplete(tab.id, 20000);
            await sleep(800);
            page = await readTab(tab.id).catch(() => ({ captcha: false, hrefs: [] }));
          }
          log("✓ Thanks — continuing.");
        }

        let here = 0;
        for (const raw of page.hrefs || []) {
          const u = unwrap(raw);
          if (!isJobPosting(u)) continue;
          const n = normalizeJobUrl(u);
          if (seen.has(n)) continue;
          seen.add(n); masterList.push(n); here++;
        }
        found += here;
        log(`Search ${searchIndex + 1}/${searchList.length}: ${here} new job link(s)`);
        persistQueueState();
        // Queue what we just found, right now. Waiting for all 153 search pages
        // before the first add meant ~9 minutes of nothing going into the field.
        if (here) {
          const st = await drainQueue();
          if (st === "stopped" || st === "lost-tab") return false;
        }
        // Human-ish pacing between result pages keeps the engine from
        // challenging every request.
        await sleep(2500 + Math.round(Math.random() * 2500));
      }
    } finally {
      if (tab) chrome.tabs.remove(tab.id).catch(() => {});
    }
    persistQueueState();
    log(`\n✔ Search pages done — ${found} job link(s) collected. Total to add: ${masterList.length}.`);
    return true;
  }

  // ---- Page automation (runs in the LazyApply tab) -----------------------
  // Serialized & injected via chrome.scripting.executeScript — must be a pure
  // (async) function with no closure over module scope. The page is a MUI/React
  // app: the "Add to Queue" button is disabled until a React-tracked `input`
  // event fires, and on a successful add MUI clears the field and re-disables
  // the button — which we use as a clean confirmation signal.
  async function addUrlToQueueInPage(url) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Identify the queue URL field POSITIVELY, or not at all.
    //
    // The old last resort was "first visible input", and it allowed
    // type="search" — so whenever the two placeholder selectors missed (the
    // Add-Job card not mounted yet, or a placeholder reworded), every job URL
    // was typed into whatever box happened to be first in the DOM: the site's
    // search bar. The page also now carries a "Job Title (Optional)" field, so
    // there is more than one wrong answer available. Typing a job URL into an
    // arbitrary box is worse than doing nothing, so this returns null instead.
    function findInput() {
      const vis = (i) => { const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const isWrongField = (i) => {
        if (!i) return true;
        if (i.type && /^(search|password|email|number|checkbox|radio|hidden|file|submit|button)$/i.test(i.type)) return true;
        const ph = i.getAttribute("placeholder") || "";
        if (/^https?:\/\//i.test(ph)) return false;   // a URL example = strong positive
        const hay = [ph, i.getAttribute("aria-label"), i.getAttribute("name"), i.id].filter(Boolean).join(" ");
        return /search|filter|title|keyword|location|email|password/i.test(hay);
      };

      // 1) The documented placeholder.
      let el = document.querySelector('input[placeholder^="https://company.greenhouse.io/jobs"]')
            || document.querySelector('input[placeholder*="greenhouse.io/jobs"]');
      if (el && vis(el)) return el;

      // 2) Any field whose placeholder is itself a URL example.
      el = Array.from(document.querySelectorAll("input")).find(
        (i) => /^https?:\/\//i.test(i.getAttribute("placeholder") || "") && vis(i));
      if (el) return el;

      // 3) Scope to the "Add Job to Queue" card, skipping Job Title.
      const label = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,p"))
        .find((n) => n.children.length === 0 && /add job to queue/i.test((n.textContent || "").trim()));
      const card = label && label.closest("section, form, div");
      if (card) {
        el = Array.from(card.querySelectorAll("input")).find((i) => !isWrongField(i) && vis(i));
        if (el) return el;
      }

      // 4) A field named for one of the platforms — still never a search box.
      el = Array.from(document.querySelectorAll("input, textarea")).find((i) =>
        /greenhouse|lever|ashby|rippling|job url|job posting|paste/i.test(
          (i.getAttribute("placeholder") || "") + " " + (i.getAttribute("aria-label") || "")
        ) && !isWrongField(i) && vis(i));
      if (el) return el;

      return null;   // deliberately no "first visible input" fallback
    }

    function findAddButton(input) {
      const vis = (b) => b && b.offsetParent !== null;
      const txt = (b) => ((b.textContent || b.value || "")).replace(/\s+/g, " ").trim();
      const btns = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'));
      let b = btns.find((x) => /add to queue/i.test(txt(x)));
      if (b) return b;
      b = btns.find((x) => /^\+?\s*add\b/i.test(txt(x)) && !/remove|delete|clear/i.test(txt(x)));
      if (b) return b;
      // Scoped, but ONLY an add-ish control. "First visible button" in the
      // container could be a nav or search control.
      if (input) {
        const scope = input.closest("form, section, div");
        if (scope) {
          b = Array.from(scope.querySelectorAll('button, [role="button"]'))
            .find((x) => vis(x) && /add|queue|submit/i.test(txt(x)));
          if (b) return b;
        }
      }
      return null;
    }

    // The page is BUSY while a previous add is still in flight: the field and
    // the button are disabled and the button reads "Adding...". Writing a new
    // URL into a disabled field does nothing, and the old code then fell
    // through to an Enter-key fallback the page never listens for. Wait it out.
    const isBusy = () => {
      const i = findInput();
      const b = findAddButton(i);
      return !!(i && i.disabled) || !!(b && /^\s*adding\b/i.test(b.textContent || ""));
    };
    {
      const idleDeadline = Date.now() + 30000;
      let w = 50;
      while (isBusy()) {
        if (Date.now() >= idleDeadline) return { ok: false, busy: true, error: "page still busy with the previous add" };
        await sleep(w);
        if (w < 300) w = Math.min(300, Math.round(w * 1.5));
      }
    }

    // The Add-Job card can mount a moment after navigation. Wait briefly rather
    // than declaring it missing (which previously sent us to a fallback that
    // typed into the site's search bar).
    let input = findInput();
    for (let w = 0; !input && w < 20; w++) { await sleep(100); input = findInput(); }
    if (!input) {
      return { ok: false, error: 'queue URL field not found — open the LazyApply "Add Job to Queue" page' };
    }

    const proto =
      input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const fire = (type) => input.dispatchEvent(new Event(type, { bubbles: true }));
    const setVal = (v) => {
      try { setter.call(input, v); } catch (_) { input.value = v; }
      fire("input"); // React-tracked
    };

    input.focus();
    setVal(""); // clear any existing text first (empty input event)
    setVal(url); // then set the URL
    fire("change");

    // Wait for React to re-render and enable the button. Check immediately, then
    // poll with a BACKING-OFF interval: fast when the page is keeping up, but
    // cheap when it isn't. findAddButton() scans every button on the page, so a
    // flat 5ms poll here was hammering the DOM and helping crash the tab.
    let btn = null;
    const btnDeadline = Date.now() + 800;
    let iv = 10, ticks = 0;
    for (;;) {
      btn = findAddButton(input);
      if (btn && !btn.disabled) break;
      if (Date.now() >= btnDeadline) break;
      await sleep(iv);
      if (iv < 120) iv = Math.min(120, Math.round(iv * 1.6));
      if (++ticks % 4 === 0) fire("input"); // nudge React periodically
    }

    if (!btn) {
      // No button at all — fall back to submitting with Enter.
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, charCode: 13, which: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      return { ok: true, via: "enter", confirmed: false };
    }
    if (btn.disabled) return { ok: false, error: "Add button stayed disabled (URL rejected by page)" };

    // The field must actually hold THIS url at click time. React can revert a
    // programmatic value; clicking Add then queues nothing (or the previous
    // URL) while still looking like a successful add.
    const pre = findInput();
    if (!pre || pre.value !== url) {
      return { ok: false, error: "input did not hold the URL at click time" };
    }

    // Snapshot the alerts already on screen so an old "success" toast is
    // never mistaken for this add's result.
    const alertTexts = () =>
      Array.from(document.querySelectorAll('.MuiAlert-message, [role="alert"]'))
        .map((a) => (a.innerText || a.textContent || "").trim()).filter(Boolean);
    const before = new Set(alertTexts());

    btn.click();

    // Confirmation. LazyApply clears the field ONLY after its POST succeeds;
    // on failure it leaves the URL in place and shows an error toast.
    //
    // That POST now takes ~2-3 s (it used to be well under one), which is
    // what broke this: the old 2.5 s window expired while the request was
    // still in flight, the URL was marked "unconfirmed" and retried into a
    // page that was still "Adding...", and the retry fell through to a
    // fallback that queued nothing. So wait for the request to FINISH (the
    // page leaves its busy state), then read the outcome.
    const clickedAt = Date.now();
    const confDeadline = clickedAt + 30000;
    let civ = 25, sawBusy = false;   // tight poll: return the instant the field clears
    await sleep(civ);                 // let React enter its busy state
    for (;;) {
      const cur = findInput();
      if (!cur || cur.value === "") return { ok: true, via: "click", confirmed: true };
      const busy = isBusy();
      if (busy) sawBusy = true;
      // "Not busy" only means "finished" once the request has visibly started
      // (or long enough has passed that it never will).
      if (!busy && (sawBusy || Date.now() - clickedAt > 3000)) {
        // Request finished and the URL is still there: the page rejected it.
        await sleep(150);             // let the toast render
        const again = findInput();
        if (!again || again.value === "") return { ok: true, via: "click", confirmed: true };
        const msg = alertTexts().find((t) => !before.has(t) && !/success/i.test(t)) ||
                    alertTexts().find((t) => !/success/i.test(t));
        return { ok: false, rejected: true, error: msg || "LazyApply did not accept the URL" };
      }
      if (Date.now() >= confDeadline) return { ok: true, via: "click", confirmed: false };
      await sleep(civ);
      if (civ < 100) civ = Math.min(100, Math.round(civ * 1.5));
    }
  }

  async function findLazyApplyTab() {
    const tabs = await chrome.tabs.query({ url: LAZYAPPLY_MATCH });
    if (!tabs.length) return null;
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0];
  }

  // ---- the add loop, callable more than once -----------------------------
  // Adds every URL from nextIndex to the end of masterList, one at a time:
  // paste into the LazyApply queue field, click "Add to Queue", confirm, repeat.
  // Pulled out of runQueue so search-page harvesting can call it after EACH page
  // and URLs start going in immediately, instead of waiting for all 153 pages
  // (~9 minutes) before the first one is added.
  let runPace = 1, runInjectFails = 0, runAdded = 0;
  const runUnconfirmed = [], runFailed = [];
  function resetRunStats() {
    runPace = 1; runInjectFails = 0; runAdded = 0;
    runUnconfirmed.length = 0; runFailed.length = 0;
  }
  // -> "done" | "stopped" | "no-tab" | "lost-tab"
  async function drainQueue() {
    if (nextIndex >= masterList.length) return "done";
    log(`\n\u25b6 Adding ${masterList.length - nextIndex} URL(s) (from #${nextIndex + 1}).\n`);
    let i = nextIndex;
    for (; i < masterList.length; i++) {
      if (stopRequested) {
        nextIndex = i; persistQueueState();
        log(`\n\u25a0 Stopped at ${i}/${masterList.length}. Click "Add to LazyApply Queue" to resume from #${i + 1}.`);
        return "stopped";
      }
      const url = masterList[i];
      setProgress(i / masterList.length);
      // Re-find the tab every iteration so a closed/re-opened LazyApply tab is
      // picked up instead of killing the run.
      const tab = await findLazyApplyTab();
      if (!tab) {
        nextIndex = i; persistQueueState();
        log(`\n\u25a0 LazyApply tab not found \u2014 paused at ${i}/${masterList.length}. Open https://app.lazyapply.com/dashboard (Job Queue) and click "Add to LazyApply Queue" to resume from #${i + 1}.`);
        return "no-tab";
      }
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, func: addUrlToQueueInPage, args: [url],
        });
        const r = res && res.result;
        if (r && r.ok) {
          runInjectFails = 0;
          if (r.confirmed) {
            runAdded++;
            runPace = Math.max(1, runPace - 5);
            log(`Adding ${i + 1}/${masterList.length} \u2713  ${url}`);
          } else {
            // Not proven queued. Do NOT retry: the request may still land and a
            // retry would queue the job twice. Slow down, record it, move on.
            runPace = Math.min(2000, runPace * 2 + 200);
            runUnconfirmed.push(url);
            log(`Adding ${i + 1}/${masterList.length} \u26a0 unconfirmed  ${url}`);
          }
        } else {
          runInjectFails = 0;
          runFailed.push({ url, error: (r && r.error) || "unknown" });
          log(`Adding ${i + 1}/${masterList.length} \u2717  ${url}  \u2014 ${(r && r.error) || "failed"}`);
        }
      } catch (e) {
        // Crashed/reloading tab: retry this same URL, then pause with the
        // resume point saved rather than burning through the rest of the list.
        runInjectFails += 1;
        if (runInjectFails >= 4) {
          nextIndex = i; persistQueueState();
          log(`\n\u25a0 Lost the LazyApply tab at ${i}/${masterList.length} (${e?.message || e}).`);
          log(`  Reload https://app.lazyapply.com/dashboard, then click "Add to LazyApply Queue" to resume from #${i + 1}.`);
          return "lost-tab";
        }
        log(`\u26a0 Page busy, retrying ${i + 1}/${masterList.length}\u2026 (${runInjectFails}/3)`);
        await sleep(600 * runInjectFails);
        i -= 1;
        continue;
      }
      nextIndex = i + 1;
      persistQueueState();
      await sleep(runPace);
    }
    return "done";
  }

  async function runQueue() {
    if (running) return;

    // A DISABLED BUTTON EXPLAINS NOTHING.
    //
    // This used to return silently on an empty list, and the button was
    // disabled on top of that, so "click it and nothing happens" was the
    // entire experience -- with no way to tell an empty list from a
    // broken one. The button stays live and says which it is.
    const searchesLeft = searchList.length - searchIndex;
    if (!masterList.length && !searchesLeft) {
      log("Nothing loaded to add. Drop in a CSV with Greenhouse, Lever, Ashby or");
      log("Rippling job URLs, or Google/Bing search pages that list them.");
      return;
    }

    // Nor does an empty page. Checked BEFORE announcing the run, which
    // otherwise printed "Adding 240 URL(s)" and then paused at 0/240.
    if (!(await findLazyApplyTab())) {
      log("No LazyApply tab is open. Open https://app.lazyapply.com/dashboard on the");
      log('Job Queue, leave it open, then click "Add to LazyApply Queue" again.');
      return;
    }

    // A completed list re-run from scratch when the user clicks again.
    if (!searchesLeft && nextIndex >= masterList.length) { nextIndex = 0; persistQueueState(); }

    running = true;
    stopRequested = false;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.fileInput.disabled = true;
    els.dropzone.classList.add("disabled");
    const endRun = () => {
      running = false;
      els.stopBtn.disabled = true;
      els.fileInput.disabled = false;
      els.dropzone.classList.remove("disabled");
      els.startBtn.disabled = false;
    };

    resetRunStats();

    // Search pages first: each page's job links are queued as soon as it is read.
    if (searchesLeft) {
      let ok = false;
      try { ok = await expandSearches(); }
      catch (e) { log(`✗ Reading search pages failed: ${e?.message || e}`); persistQueueState(); }
      if (!ok) { endRun(); return; }
      if (!masterList.length) {
        log("No Greenhouse / Lever / Ashby / Rippling job links were on those search pages.");
        clearQueueState(); endRun(); return;
      }
      if (!(await findLazyApplyTab())) {
        log("\nJob links are saved. Open https://app.lazyapply.com/dashboard (Job Queue), then");
        log('click "Add to LazyApply Queue" to add them.');
        endRun(); return;
      }
    }

    await drainQueue();

    endRun();

    if (nextIndex >= masterList.length) {
      // Whole list finished — clear saved progress so the next upload starts clean.
      setProgress(1);
      clearQueueState();
      log(`\n✔ Done. Confirmed added: ${runAdded}.  Unconfirmed: ${runUnconfirmed.length}.  Failed: ${runFailed.length}.`);
      if (runUnconfirmed.length) {
        log("Unconfirmed (LazyApply never cleared the field — check the queue for these):");
        runUnconfirmed.forEach((u) => log(`  • ${u}`));
      }
    } else {
      setProgress(nextIndex / masterList.length);
    }
    if (runFailed.length) {
      log("Failed URLs:");
      runFailed.forEach((f) => log(`  • ${f.url}  (${f.error})`));
    }
  }

  // ---- Wiring ------------------------------------------------------------
  els.dropzone.addEventListener("click", () => { if (!running) els.fileInput.click(); });
  els.dropzone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && !running) { e.preventDefault(); els.fileInput.click(); }
  });
  els.fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

  ["dragenter", "dragover"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!running) els.dropzone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    els.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.remove("dragover");
    })
  );
  els.dropzone.addEventListener("drop", (e) => {
    if (running) return;
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) handleFiles(dt.files);
  });

  els.startBtn.addEventListener("click", runQueue);
  els.stopBtn.addEventListener("click", () => { stopRequested = true; els.stopBtn.disabled = true; });

  // Restore an interrupted run when the side panel reloads, so the list and the
  // resume point survive a teardown and the user can continue with one click.
  (async function restoreQueueState() {
    try {
      const stored = await chrome.storage.local.get(LA_STATE_KEY);
      const s = stored[LA_STATE_KEY];
      if (!s || !Array.isArray(s.master)) return;
      const searches = Array.isArray(s.searches) ? s.searches : [];
      const sIdx = Math.min(Math.max(0, s.searchIndex || 0), searches.length);
      const nIdx = Math.min(Math.max(0, s.nextIndex || 0), s.master.length);
      if (sIdx >= searches.length && nIdx >= s.master.length) { clearQueueState(); return; }
      if (!s.master.length && !searches.length) return;
      masterList = s.master; nextIndex = nIdx;
      searchList = searches; searchIndex = sIdx;
      sourceSig = s.sig || "";
      els.startBtn.disabled = false;
      setProgress(masterList.length ? nextIndex / masterList.length : 0);
      const sLeft = searchList.length - searchIndex;
      els.summary.textContent =
        `Restored a previous run.\nJob URLs: ${masterList.length}\nAlready added: ${nextIndex}` +
        (sLeft ? `\nSearch pages still to open: ${sLeft}` : "") +
        `\nClick "Add to LazyApply Queue" to continue.`;
      log(`Restored interrupted run — ${nextIndex}/${masterList.length} added` +
        (sLeft ? `, ${sLeft} search page(s) still to read` : "") + `. Click "Add to LazyApply Queue" to continue.`);
    } catch (_) {}
  })();
})();

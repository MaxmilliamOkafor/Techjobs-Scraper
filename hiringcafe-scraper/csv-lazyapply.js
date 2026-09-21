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
        [LA_STATE_KEY]: { sig: listSignature(masterList), master: masterList, nextIndex }
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

  // Returns the supported URLs AND what it turned away.
  //
  // "0 supported" on its own is a dead end: it looks identical whether
  // the file failed to parse, held no URLs at all, or held four hundred
  // perfectly good URLs from a platform this tool does not drive. Those
  // need three different answers, so the count is reported alongside the
  // hosts that produced it.
  function scanCsv(text) {
    const rows = parseCsv(text).filter((r) => r.some((c) => c && c.trim()));
    if (!rows.length) return { urls: [], rejected: 0, hosts: [], rows: 0, column: -1 };
    const col = findUrlColumn(rows[0]);
    const out = [];
    const seenHosts = new Map();
    let rejected = 0;
    const start = col === -1 ? 0 : 1; // no header match → scan every row/cell
    for (let r = start; r < rows.length; r++) {
      const cells = col === -1 ? rows[r] : [rows[r][col]];
      for (const cell of cells) {
        if (!cell) continue;
        const m = String(cell).match(/https?:\/\/[^\s",]+/);
        let url = (m ? m[0] : String(cell).trim()).replace(/[)\].,;]+$/, "");
        if (!url) continue;
        if (isSupported(url)) { out.push(url); continue; }
        if (!/^https?:\/\//i.test(url)) continue;  // not a URL at all, not a rejection
        rejected++;
        const h = hostOf(url) || "?";
        seenHosts.set(h, (seenHosts.get(h) || 0) + 1);
      }
    }
    const hosts = [...seenHosts.entries()].sort((a, b) => b[1] - a[1]);
    return { urls: out, rejected, hosts, rows: rows.length - (col === -1 ? 0 : 1), column: col };
  }

  function extractUrls(text) { return scanCsv(text).urls; }

  async function readFiles(fileList) {
    const files = Array.from(fileList);
    const perFile = [];
    const seen = new Set();
    const master = [];
    for (const f of files) {
      let scan = { urls: [], rejected: 0, hosts: [], rows: 0 };
      try { scan = scanCsv(await f.text()); }
      catch (e) { log(`⚠ Could not read ${f.name}: ${e?.message || e}`); }
      perFile.push({ name: f.name, count: scan.urls.length,
        rejected: scan.rejected, hosts: scan.hosts, rows: scan.rows });
      for (const u of scan.urls) if (!seen.has(u)) { seen.add(u); master.push(u); }
    }
    return { perFile, master };
  }

  async function handleFiles(fileList) {
    if (!fileList || !fileList.length || running) return;
    clearLog();
    setProgress(0);
    const { perFile, master } = await readFiles(fileList);
    masterList = master;
    // If this is the SAME list a previous (interrupted) run was working through,
    // resume from where it stopped rather than re-adding everything.
    let resumed = 0;
    try {
      const stored = await chrome.storage.local.get(LA_STATE_KEY);
      const s = stored[LA_STATE_KEY];
      if (s && s.sig === listSignature(master) && Number.isFinite(s.nextIndex)) {
        nextIndex = Math.min(Math.max(0, s.nextIndex), master.length);
        resumed = nextIndex;
      } else {
        nextIndex = 0;
      }
    } catch (_) { nextIndex = 0; }
    persistQueueState();
    const totalRaw = perFile.reduce((a, b) => a + b.count, 0);
    const lines = perFile.map((p) => {
      let line = `  • ${p.name}: ${p.count} supported`;
      if (p.rejected) line += `, ${p.rejected} skipped`;
      if (!p.count && !p.rejected && !p.rows) line += " (no rows read)";
      return line;
    });
    els.summary.textContent =
      `${perFile.length} file(s) scanned\n${lines.join("\n")}` +
      `\n\nSupported (pre-dedupe): ${totalRaw}\nUnique to add: ${master.length}` +
      (resumed > 0 ? `\nAlready added: ${resumed} — will resume from #${resumed + 1}` : "");
    els.startBtn.disabled = false;   // stays live; runQueue says what is missing
    setProgress(master.length ? nextIndex / master.length : 0);
    log(
      master.length
        ? (resumed > 0
            ? `Loaded ${master.length} URL(s). ${resumed} already added — click "Add to LazyApply Queue" to resume from #${resumed + 1}.`
            : `Loaded ${master.length} unique supported URL(s). Open the LazyApply Job Queue, then click "Add to LazyApply Queue".`)
        : ""   // the specific reason is logged just below; this said nothing
    );

    // Say WHY nothing came through. The three reasons need three
    // different fixes and the count alone distinguishes none of them.
    if (!master.length) {
      const allHosts = new Map();
      let anyRows = 0;
      for (const p of perFile) {
        anyRows += p.rows || 0;
        for (const [h, n] of p.hosts || []) allHosts.set(h, (allHosts.get(h) || 0) + n);
      }
      if (!anyRows) {
        log("The file had no readable rows. Check it is a CSV with a header row.");
      } else if (!allHosts.size) {
        log(`Read ${anyRows} row(s) but found no URLs in them. The column holding the`);
        log('links should be named "Job URL" or "url".');
      } else {
        const top = [...allHosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
        log(`Read ${anyRows} row(s) and found URLs, but none on a platform this tool drives.`);
        log("What was in the file: " + top.map(([h, n]) => `${h} (${n})`).join(", "));
        log("It queues job postings on: Greenhouse, Lever, Ashby, Rippling.");
        if (top.some(([h]) => /google\.|bing\.|duckduckgo\./i.test(h))) {
          log("Those are SEARCH pages, not job postings. Export the job URLs themselves");
          log("rather than the searches that find them.");
        }
      }
    }
  }

  // ---- Page automation (runs in the LazyApply tab) -----------------------
  // Serialized & injected via chrome.scripting.executeScript — must be a pure
  // (async) function with no closure over module scope. The page is a MUI/React
  // app: the "Add to Queue" button is disabled until a React-tracked `input`
  // event fires, and on a successful add MUI clears the field and re-disables
  // the button — which we use as a clean confirmation signal.
  async function addUrlToQueueInPage(url) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function findInput() {
      // The placeholder is the only stable, unique anchor (ids like ":r7:" and
      // css-hash classes are regenerated on every render/build).
      return (
        document.querySelector('input[placeholder^="https://company.greenhouse.io/jobs"]') ||
        document.querySelector('input[placeholder*="greenhouse.io/jobs"]') ||
        (function () {
          const inputs = Array.from(document.querySelectorAll("input, textarea"));
          return (
            inputs.find((i) =>
              /greenhouse|lever|ashby|rippling|job.*queue|queue|paste|job url|job posting/i.test(
                (i.getAttribute("placeholder") || "") + " " + (i.getAttribute("aria-label") || "")
              )
            ) ||
            inputs.find((i) => {
              if (i.type && !/^(text|url|search|)$/i.test(i.type)) return false;
              const r = i.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            }) ||
            null
          );
        })()
      );
    }
    function findAddButton(input) {
      const btns = Array.from(
        document.querySelectorAll('button, [role="button"], input[type="submit"]')
      );
      let b = btns.find((x) => /add to queue/i.test((x.textContent || "").trim()));
      if (b) return b;
      b = btns.find((x) => /add job|add url|^\s*\+?\s*add\s*$/i.test((x.textContent || x.value || "").trim()));
      if (b) return b;
      if (input) {
        const scope = input.closest("form, div");
        if (scope) {
          b = Array.from(scope.querySelectorAll('button, [role="button"]')).find(
            (x) => x.offsetParent !== null
          );
          if (b) return b;
        }
      }
      return null;
    }

    const input = findInput();
    if (!input) return { ok: false, error: "URL input field not found" };

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
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
      return { ok: true, via: "enter", confirmed: false };
    }
    if (btn.disabled) return { ok: false, error: "Add button stayed disabled (URL rejected by page)" };

    btn.click();

    // Confirmation: on a successful add MUI clears the field and the button
    // returns to disabled. Check the CHEAP signal (btn.disabled) before the
    // expensive findInput() scan, and back the interval off so a slow add costs
    // a handful of DOM scans rather than hundreds.
    let confirmed = false;
    const confDeadline = Date.now() + 2500;
    let civ = 10;
    for (;;) {
      if (btn.disabled) { confirmed = true; break; }
      const cur = findInput();
      if (cur && cur.value === "") { confirmed = true; break; }
      if (Date.now() >= confDeadline) break;
      await sleep(civ);
      if (civ < 120) civ = Math.min(120, Math.round(civ * 1.6));
    }
    return { ok: true, via: "click", confirmed };
  }

  async function findLazyApplyTab() {
    const tabs = await chrome.tabs.query({ url: LAZYAPPLY_MATCH });
    if (!tabs.length) return null;
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0];
  }

  async function runQueue() {
    if (running) return;

    // A DISABLED BUTTON EXPLAINS NOTHING.
    //
    // This used to return silently on an empty list, and the button was
    // disabled on top of that, so "click it and nothing happens" was the
    // entire experience -- with no way to tell an empty list from a
    // broken one. The button stays live and says which it is.
    if (!masterList.length) {
      log("Nothing loaded to add. Drop in a CSV of job URLs first \u2014 Greenhouse,");
      log("Lever, Ashby or Rippling postings. A file of search URLs will not do it.");
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
    if (nextIndex >= masterList.length) { nextIndex = 0; persistQueueState(); }

    running = true;
    stopRequested = false;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.fileInput.disabled = true;
    els.dropzone.classList.add("disabled");

    let pace = 1;        // ms between adds; adapts upward if the page struggles
    let injectFails = 0; // consecutive executeScript failures (crashed/reloading tab)
    let added = 0;
    const failed = [];
    const startAt = nextIndex;
    log(`\n▶ Adding ${masterList.length - startAt} URL(s) (from #${startAt + 1}).\n`);

    let i = startAt;
    for (; i < masterList.length; i++) {
      if (stopRequested) { nextIndex = i; persistQueueState(); log(`\n■ Stopped at ${i}/${masterList.length}. Click "Add to LazyApply Queue" to resume from #${i + 1}.`); break; }
      const url = masterList[i];
      setProgress(i / masterList.length);
      // Re-find the tab every iteration so a closed/re-opened LazyApply tab (a
      // common cause of the run halting) is picked up instead of killing the run.
      const tab = await findLazyApplyTab();
      if (!tab) {
        nextIndex = i; persistQueueState();
        log(`\n■ LazyApply tab not found — paused at ${i}/${masterList.length}. Open https://app.lazyapply.com/dashboard (Job Queue) and click "Add to LazyApply Queue" to resume from #${i + 1}.`);
        break;
      }
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: addUrlToQueueInPage,
          args: [url],
        });
        const r = res && res.result;
        if (r && r.ok) {
          added++;
          injectFails = 0;
          if (r.confirmed) pace = Math.max(1, pace - 5);
          else pace = Math.min(400, pace * 2 + 10);
          log(`Adding ${i + 1}/${masterList.length} ✓${r.confirmed ? "" : " (unconfirmed)"}  ${url}`);
        } else {
          injectFails = 0;
          failed.push({ url, error: (r && r.error) || "unknown" });
          log(`Adding ${i + 1}/${masterList.length} ✗  ${url}  — ${(r && r.error) || "failed"}`);
        }
      } catch (e) {
        // The tab crashed or is reloading. Previously this just marked the URL
        // failed and moved on, so a crash silently burned through the whole
        // remaining list — which is why it "stopped before adding all". Now we
        // retry, then PAUSE with the resume point saved.
        injectFails += 1;
        if (injectFails >= 4) {
          nextIndex = i; persistQueueState();
          log(`\n■ Lost the LazyApply tab at ${i}/${masterList.length} (${e?.message || e}).`);
          log(`  Reload https://app.lazyapply.com/dashboard, then click "Add to LazyApply Queue" to resume from #${i + 1}.`);
          break;
        }
        log(`⚠ Page busy, retrying ${i + 1}/${masterList.length}… (${injectFails}/3)`);
        await sleep(600 * injectFails);
        i -= 1;          // retry this same URL
        continue;
      }
      // Advance the resume pointer AFTER each URL is processed and persist it, so
      // a mid-run teardown resumes here instead of restarting from the top.
      nextIndex = i + 1;
      persistQueueState();
      await sleep(pace);
    }

    running = false;
    els.stopBtn.disabled = true;
    els.fileInput.disabled = false;
    els.dropzone.classList.remove("disabled");
    els.startBtn.disabled = false;

    if (nextIndex >= masterList.length) {
      // Whole list finished — clear saved progress so the next upload starts clean.
      setProgress(1);
      clearQueueState();
      log(`\n✔ Done. Added this run: ${added}.  Failed/skipped: ${failed.length}.`);
    } else {
      setProgress(nextIndex / masterList.length);
    }
    if (failed.length) {
      log("Failed URLs:");
      failed.forEach((f) => log(`  • ${f.url}  (${f.error})`));
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
      if (s && Array.isArray(s.master) && s.master.length && s.sig === listSignature(s.master)) {
        masterList = s.master;
        nextIndex = Math.min(Math.max(0, s.nextIndex || 0), masterList.length);
        if (nextIndex >= masterList.length) { clearQueueState(); return; }
        els.startBtn.disabled = false;
        setProgress(nextIndex / masterList.length);
        els.summary.textContent =
          `Restored a previous run.\nTotal: ${masterList.length}\nAlready added: ${nextIndex}` +
          `\nClick "Add to LazyApply Queue" to resume from #${nextIndex + 1}.`;
        log(`Restored interrupted run — ${nextIndex}/${masterList.length} already added. Click "Add to LazyApply Queue" to resume from #${nextIndex + 1}.`);
      }
    } catch (_) {}
  })();
})();

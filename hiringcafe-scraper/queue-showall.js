// queue-showall.js — Additive feature (does not touch the scraper, CSV add or delete flows).
// LazyApply's Job Queue shows 20 jobs at a time with a "Show More" button under
// the table. This keeps scrolling to the bottom and pressing "Show More" until
// every queued job is on screen, then reads each job's URL from the page's own
// data (the table itself only shows title / company / platform, never the URL)
// and lists them here, ready to copy or download.
//
// Observed on the live dashboard (Oct 2026): each press hides the button while
// loading and adds 20 rows (~0.8 s later); the URLs sit in the queue list the
// page keeps in React state as { jobUrl, companyName, jobTitle, platform, ... }.

(function () {
  const LAZYAPPLY_MATCH = ["https://app.lazyapply.com/*"];
  const CLICKS_PER_CALL = 10;   // presses per injected call (each call reports progress)
  const MAX_STALLS = 3;         // presses in a row that add nothing before giving up

  const els = {
    card: document.getElementById("showall-card"),
    startBtn: document.getElementById("showall-start-btn"),
    stopBtn: document.getElementById("showall-stop-btn"),
    copyBtn: document.getElementById("showall-copy-btn"),
    exportBtn: document.getElementById("showall-export-btn"),
    status: document.getElementById("showall-status"),
    urls: document.getElementById("showall-urls"),
  };
  if (!els.card) return;

  let running = false, stopRequested = false;
  let jobs = [];   // [{ url, company, title, platform, added, status }]

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setStatus = (t) => { els.status.textContent = t; };

  async function findLazyApplyTab() {
    const tabs = await chrome.tabs.query({ url: LAZYAPPLY_MATCH });
    if (!tabs.length) return null;
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0];
  }

  // ---- Injected: press "Show More" up to maxClicks times -------------------
  // Must be self-contained (serialized into the page).
  async function showMoreInPage(maxClicks) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rowCount = () => document.querySelectorAll("tbody tr").length;
    const findBtn = () => Array.from(document.querySelectorAll('button, [role="button"]')).find(
      (b) => /^\s*(show|load|view)\s+more\b/i.test(b.textContent || "") && b.offsetParent !== null
    );
    const toBottom = () => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      // Also any inner scroll box around the table, in case the layout changes.
      let n = document.querySelector("tbody");
      while (n && n !== document.body) {
        const oy = getComputedStyle(n).overflowY;
        if (/(auto|scroll|overlay)/.test(oy) && n.scrollHeight > n.clientHeight + 10) n.scrollTop = n.scrollHeight;
        n = n.parentElement;
      }
    };
    // The button vanishes while a page of jobs loads; give it time to come back.
    async function waitForButton(ms) {
      const end = Date.now() + ms;
      for (;;) {
        const b = findBtn();
        if (b && !b.disabled) return b;
        if (Date.now() >= end) return null;
        toBottom();
        await sleep(100);
      }
    }

    let clicks = 0, stalled = 0;
    for (;;) {
      toBottom();
      const before = rowCount();
      // The button is hidden while a page of jobs loads, so "no button" only
      // means "finished" once it has stayed away AND the row count stood still.
      const btn = await waitForButton(6000);
      if (!btn) {
        if (rowCount() !== before) continue;                       // a late load landed: keep going
        return { done: true, clicks, stalled, rows: rowCount() };  // nothing more to load
      }
      if (clicks >= maxClicks) return { done: false, clicks, stalled, rows: before };
      btn.click();
      clicks += 1;
      // Wait for the new rows (LazyApply answers in ~1 s; allow for a slow server).
      const end = Date.now() + 20000;
      let iv = 50;
      while (rowCount() <= before && Date.now() < end) { await sleep(iv); if (iv < 300) iv = Math.round(iv * 1.5); }
      if (rowCount() <= before) {
        stalled += 1;
        return { done: false, clicks, stalled, rows: rowCount() };
      }
    }
  }

  // ---- Injected (MAIN world): read every queued job's URL from React state ----
  function readQueueInPage() {
    const tr = document.querySelector("tbody tr");
    const pick = (o) => ({
      url: o.jobUrl || "", company: o.companyName || "", title: o.jobTitle || "",
      platform: o.platform || "", added: o.createdAt || "", status: o.status || ""
    });
    const isJobList = (v) => Array.isArray(v) && v.length && v[0] && typeof v[0] === "object" &&
      typeof v[0].jobUrl === "string";
    let best = null;
    const consider = (v) => { if (isJobList(v) && (!best || v.length > best.length)) best = v; };
    if (tr) {
      const fk = Object.keys(tr).find((k) => k.startsWith("__reactFiber$"));
      let f = fk ? tr[fk] : null;
      for (let d = 0; d < 80 && f; d++) {
        let s = f.memoizedState, i = 0;
        while (s && i < 40) {
          consider(s.memoizedState);
          if (s.memoizedState && typeof s.memoizedState === "object" && !Array.isArray(s.memoizedState)) {
            for (const k in s.memoizedState) { try { consider(s.memoizedState[k]); } catch (_) {} }
          }
          s = s.next; i += 1;
        }
        const p = f.memoizedProps;
        if (p && typeof p === "object") for (const k in p) { if (k !== "children") { try { consider(p[k]); } catch (_) {} } }
        f = f.return;
      }
    }
    return { rows: document.querySelectorAll("tbody tr").length, jobs: best ? best.map(pick) : null };
  }

  function renderJobs() {
    const withUrl = jobs.filter((j) => j.url);
    els.urls.textContent = withUrl.map((j) => j.url).join("\n");
    els.copyBtn.disabled = !withUrl.length;
    els.exportBtn.disabled = !withUrl.length;
  }

  async function run() {
    if (running) return;
    const tab = await findLazyApplyTab();
    if (!tab) { setStatus("⚠ Open https://app.lazyapply.com/dashboard on the Job Queue tab first."); return; }

    running = true; stopRequested = false;
    els.startBtn.disabled = true; els.stopBtn.disabled = false;
    els.copyBtn.disabled = true; els.exportBtn.disabled = true;
    jobs = []; els.urls.textContent = "";
    setStatus("▶ Scrolling down and pressing Show More…");

    let totalClicks = 0, stallStreak = 0, failStreak = 0, rows = 0, finished = false, problem = "";
    while (!stopRequested) {
      let res = null;
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, func: showMoreInPage, args: [CLICKS_PER_CALL]
        });
        res = r && r.result;
        failStreak = 0;
      } catch (e) {
        if (++failStreak >= 4) { problem = "Lost the LazyApply tab (" + (e?.message || e) + "). Reload it and try again."; break; }
        await sleep(700 * failStreak);
        continue;
      }
      if (!res) { problem = "The page did not answer."; break; }
      totalClicks += res.clicks; rows = res.rows;
      stallStreak = res.stalled ? stallStreak + res.stalled : 0;
      setStatus(`▶ Pressed Show More ${totalClicks}× — ${rows} jobs on screen…`);
      if (res.done) { finished = true; break; }
      if (stallStreak >= MAX_STALLS) { problem = `Show More stopped adding jobs after ${rows} (pressed ${MAX_STALLS}× with no change).`; break; }
    }

    // Read the URLs of everything now on screen (also after a Stop or a stall).
    let read = null;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readQueueInPage, world: "MAIN" });
      read = r && r.result;
    } catch (_) {}
    if (read && read.jobs) jobs = read.jobs;
    renderJobs();

    const n = jobs.filter((j) => j.url).length;
    const shown = (read && read.rows) || rows;
    let msg;
    if (!shown) msg = '⚠ No queued jobs on the page. Open the "Job Queue" tab on the dashboard, then try again.';
    else if (stopRequested) msg = `■ Stopped. ${shown} jobs on screen, ${n} job URLs below.`;
    else if (finished) msg = `✔ All ${shown} queued jobs are showing (pressed Show More ${totalClicks}×). ${n} job URLs below.`;
    else msg = `⚠ ${problem} ${n} job URLs below.`;
    if (shown && read && !read.jobs) msg += "\n(Couldn't read the URLs from the page — LazyApply may have changed its layout.)";
    setStatus(msg);

    running = false;
    els.startBtn.disabled = false; els.stopBtn.disabled = true;
  }

  els.startBtn.addEventListener("click", run);
  els.stopBtn.addEventListener("click", () => { stopRequested = true; els.stopBtn.disabled = true; setStatus("■ Stopping after the current press…"); });

  els.copyBtn.addEventListener("click", async () => {
    const text = jobs.filter((j) => j.url).map((j) => j.url).join("\n");
    try { await navigator.clipboard.writeText(text); els.copyBtn.textContent = "Copied ✓"; }
    catch (_) {
      // Clipboard blocked: select the list so Ctrl/Cmd+C works.
      const range = document.createRange(); range.selectNodeContents(els.urls);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      els.copyBtn.textContent = "Selected — press Ctrl/Cmd+C";
    }
    setTimeout(() => { els.copyBtn.textContent = "Copy URLs"; }, 2000);
  });

  els.exportBtn.addEventListener("click", () => {
    const esc = (v) => { const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim(); return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = ["Job URL,Company,Title,Platform,Date Added,Status"];
    for (const j of jobs) if (j.url) lines.push([j.url, j.company, j.title, j.platform, j.added, j.status].map(esc).join(","));
    const blob = new Blob(["﻿" + lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `lazyapply-queue-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
})();

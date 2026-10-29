// queue-cleanup.js — Additive feature (does not touch the scraper or the CSV add flow).
// Mass-delete jobs from the LazyApply "Job Queue". Pairs with csv-lazyapply.js:
// after you've applied to a batch, clear them out here, then add a fresh batch.
//
// Two modes:
//   • Delete ALL queued jobs.
//   • Delete only jobs whose platform/company/title matches a filter you type
//     (comma-separated substrings, case-insensitive).

(function () {
  const LAZYAPPLY_MATCH = ["https://app.lazyapply.com/*"];

  const els = {
    card: document.getElementById("cleanup-card"),
    modeAll: document.getElementById("cleanup-mode-all"),
    modeFilter: document.getElementById("cleanup-mode-filter"),
    filterInput: document.getElementById("cleanup-filter"),
    delayInput: document.getElementById("cleanup-delay"),
    maxInput: document.getElementById("cleanup-max"),
    startBtn: document.getElementById("cleanup-start-btn"),
    stopBtn: document.getElementById("cleanup-stop-btn"),
    progressBar: document.getElementById("cleanup-progress-bar"),
    log: document.getElementById("cleanup-log"),
  };
  if (!els.card) return;

  let running = false;
  let stopRequested = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function log(line) { els.log.textContent += line + "\n"; els.log.scrollTop = els.log.scrollHeight; }
  function clearLog() { els.log.textContent = ""; }
  function setProgress(frac) {
    if (els.progressBar) els.progressBar.style.width = Math.max(0, Math.min(1, frac)) * 100 + "%";
  }

  async function findLazyApplyTab() {
    const tabs = await chrome.tabs.query({ url: LAZYAPPLY_MATCH });
    if (!tabs.length) return null;
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return tabs[0];
  }

  // Injected into the LazyApply tab. Removes UP TO maxPerCall matching rows per
  // call. Speed: every matching "Remove" on screen is clicked in one go (the
  // clicks all land before the page re-renders, so each one hits its own row),
  // then the whole batch is awaited together — instead of one row, one wait,
  // one row. Waiting uses a cheap node-detached check with backoff, so a big
  // queue never pegs the CPU (an earlier 5ms full-table poll crashed the tab).
  async function removeRowsInPage(filters, maxPerCall) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // textContent, not innerText: no layout work, so scanning a big table is cheap.
    const rowText = (tr) => (tr.textContent || "").replace(/\s+/g, " ").trim();
    // A row's identity: React's key for it (the job), else its text. Runs in the
    // page's own world so React's fields on the row are visible.
    const rowId = (tr) => {
      const fk = Object.keys(tr).find((k) => k.startsWith("__reactFiber$"));
      for (let f = fk && tr[fk], i = 0; f && i < 4; f = f.return, i++) if (f.key != null) return "k:" + f.key;
      return "t:" + rowText(tr);
    };
    const labelCounts = () => {
      const m = new Map();
      for (const tr of document.querySelectorAll("tbody tr")) { const t = rowId(tr); m.set(t, (m.get(t) || 0) + 1); }
      return m;
    };
    const matches = (tr) => {
      if (!filters || !filters.length) return true;
      const t = rowText(tr).toLowerCase();
      return filters.some((f) => f && t.includes(f));
    };
    const removeButtons = () =>
      Array.from(document.querySelectorAll('button, [role="button"]')).filter(
        (b) => /^\s*remove\s*$/i.test(b.textContent || "") && !b.disabled && b.offsetParent !== null
      );
    const rowCount = () => document.querySelectorAll("tbody tr").length;

    // ONE scan, then click the whole batch before the page can re-render.
    const before = labelCounts();
    const clicked = [], want = new Map(), labels = new Map();   // row id -> how many we removed
    for (const b of removeButtons()) {
      if (clicked.length >= maxPerCall) break;
      const tr = b.closest("tr");
      if (!tr || !matches(tr)) continue;
      const id = rowId(tr);
      try { b.click(); } catch (_) { continue; }
      clicked.push(id);
      want.set(id, (want.get(id) || 0) + 1);
      labels.set(id, rowText(tr).slice(0, 80));
    }
    // A row is confirmed gone when fewer rows with its text remain — checked by
    // content, not by node, because the table may redraw every row. The whole
    // batch is awaited together, polling 10ms -> 150ms.
    const goneOf = (now) => {
      let n = 0;
      for (const [t, k] of want) n += Math.min(k, Math.max(0, (before.get(t) || 0) - (now.get(t) || 0)));
      return n;
    };
    const deadline = Date.now() + 2500 + clicked.length * 60;
    let iv = 10, gone = 0;
    while (clicked.length && Date.now() < deadline) {
      await sleep(iv);
      if (iv < 150) iv = Math.min(150, Math.round(iv * 1.6));
      gone = goneOf(labelCounts());
      if (gone >= clicked.length) break;
    }
    // Which labels to report: the first `gone` of each text that went.
    const removed = [];
    const now = labelCounts();
    for (const [t, k] of want) {
      const g = Math.min(k, Math.max(0, (before.get(t) || 0) - (now.get(t) || 0)));
      for (let i = 0; i < g; i++) removed.push(labels.get(t));
    }
    const unconfirmed = clicked.length - removed.length;

    if (clicked.length === 0) {
      // Nothing matched on screen — try to reveal more rows before declaring done.
      const showMore = Array.from(document.querySelectorAll("button")).find(
        (b) => /show more/i.test(b.textContent || "") && !b.disabled && b.offsetParent !== null
      );
      if (showMore) {
        const before = rowCount();
        showMore.click();
        const deadline = Date.now() + 4000;
        let iv = 20;
        while (Date.now() < deadline) {
          if (rowCount() > before) break;
          await sleep(iv);
          if (iv < 150) iv = Math.min(150, Math.round(iv * 1.6));
        }
        return { ok: true, done: false, removed: [], unconfirmed: 0, grew: rowCount() > before, remaining: rowCount() };
      }
      return { ok: true, done: true, removed: [], unconfirmed: 0, remaining: rowCount() };
    }
    return { ok: true, done: false, removed, unconfirmed, clicked: clicked.length, remaining: rowCount() };
  }

  function parseFilters() {
    if (!els.modeFilter.checked) return [];
    return (els.filterInput.value || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  async function run() {
    if (running) return;
    const tab = await findLazyApplyTab();
    if (!tab) { log('⚠ Open https://app.lazyapply.com/dashboard and select the "Job Queue" tab first.'); return; }

    const filters = parseFilters();
    if (els.modeFilter.checked && !filters.length) {
      log("⚠ Filter mode is on but no filter text was entered. Try: lever, dandy"); return;
    }

    let batchSize = 100;       // rows clicked per injected call; halves if LazyApply lags
    let pace = 0;              // ms between batches; adapts if the page struggles
    const rawMax = parseInt(els.maxInput?.value, 10);
    const maxDeletes = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Infinity;

    running = true; stopRequested = false;
    els.startBtn.disabled = true; els.stopBtn.disabled = false;
    [els.modeAll, els.modeFilter, els.filterInput, els.maxInput].forEach((e) => e && (e.disabled = true));
    clearLog(); setProgress(0);
    log(filters.length
      ? '\u25b6 Deleting queue jobs matching: ' + filters.join(", ") + '\n'
      : '\u25b6 Deleting ALL queued jobs\n');

    let removed = 0, emptyStreak = 0, failStreak = 0, stuckStreak = 0;
    while (!stopRequested && removed < maxDeletes) {
      const want = Math.min(batchSize, maxDeletes - removed);
      let res = null;
        try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, world: "MAIN", func: removeRowsInPage, args: [filters, want]
        });
        res = r && r.result;
        failStreak = 0;
      } catch (e) {
        // A crashed/reloading tab throws here. Back off and retry a few times
        // rather than aborting the whole run on one transient failure.
        failStreak += 1;
        if (failStreak >= 4) {
          log("\u2717 Lost the LazyApply tab (" + (e?.message || e) + ").");
          log("  Reload https://app.lazyapply.com/dashboard, then click Delete from Queue again.");
          break;
        }
        log("\u26a0 Page busy, retrying\u2026 (" + failStreak + "/3)");
        await sleep(600 * failStreak);
        continue;
      }
      if (!res || !res.ok) { log("\u2717 Unexpected page response \u2014 stopping."); break; }

      const batch = Array.isArray(res.removed) ? res.removed : [];
      if (!res.clicked) {
        if (res.grew) { emptyStreak = 0; await sleep(pace); continue; }  // Show More revealed rows
        if (++emptyStreak >= 2) break;
        await sleep(pace);
        continue;
      }
      emptyStreak = 0;
      // Rows that were clicked but never went away, call after call: give up
      // rather than clicking the same Remove buttons forever.
      if (!batch.length) {
        if (++stuckStreak >= 4) { log("\u2717 LazyApply is not removing jobs any more \u2014 stopping. Reload the dashboard and try again."); break; }
      } else stuckStreak = 0;
      // One log write per batch (appending line by line is slow on a big queue).
      const lines = batch.map((label, i) => (removed + i + 1) + ". \u2713 " + label +
        (Number.isFinite(maxDeletes) ? "   [" + (removed + i + 1) + "/" + maxDeletes + "]" : ""));
      removed += batch.length;
      if (res.unconfirmed) lines.push("  (" + res.unconfirmed + " still showing \u2014 retrying)");
      if (lines.length) log(lines.join("\n"));
      if (Number.isFinite(maxDeletes)) setProgress(removed / maxDeletes);

      // Adaptive: if LazyApply can't keep up (rows left behind), halve the
      // batch and add a pause; while it keeps up, grow back to full speed.
      if (res.unconfirmed > res.clicked / 2) { batchSize = Math.max(5, batchSize >> 1); pace = Math.min(1500, pace * 2 + 100); }
      else { batchSize = Math.min(100, batchSize * 2); pace = Math.max(0, pace >> 1); }
      if (pace) await sleep(pace);
    }

    setProgress(1); running = false; els.stopBtn.disabled = true;
    [els.modeAll, els.modeFilter, els.delayInput, els.maxInput].forEach((e) => e && (e.disabled = false));
    els.filterInput.disabled = !els.modeFilter.checked; els.startBtn.disabled = false;
    log("\n✔ Done. Removed " + removed + " job(s)" + (stopRequested ? " (stopped early)." : "."));
  }

  function syncFilterEnabled() { if (els.filterInput) els.filterInput.disabled = !els.modeFilter.checked || running; }
  els.modeAll && els.modeAll.addEventListener("change", syncFilterEnabled);
  els.modeFilter && els.modeFilter.addEventListener("change", syncFilterEnabled);
  syncFilterEnabled();

  els.startBtn.addEventListener("click", run);
  els.stopBtn.addEventListener("click", () => { stopRequested = true; els.stopBtn.disabled = true; log("\n■ Stop requested — finishing current item…"); });
})();

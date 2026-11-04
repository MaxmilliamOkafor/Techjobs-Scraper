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
  // call. Batching matters: scanning every button + every <tbody tr> is O(queue
  // size), so doing it once per row (with a 1ms gap) meant tens of thousands of
  // full-table scans on a large queue — which pegged the CPU and crashed the tab.
  // One scan now covers a whole batch, and waiting for a removal uses a cheap
  // node-detached check with backoff instead of re-counting rows every 5ms.
  async function removeRowsInPage(filters, maxPerCall) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rowText = (tr) => (tr.innerText || "").replace(/\s+/g, " ").trim();
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

    // Wait for a node to leave the DOM. document.body.contains() is a cheap
    // tree walk with no querySelectorAll, and the interval backs off so a slow
    // removal costs a handful of checks rather than hundreds.
    async function waitDetached(node, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let iv = 10;
      while (document.body.contains(node)) {
        if (Date.now() >= deadline) return false;
        await sleep(iv);
        if (iv < 120) iv = Math.min(120, Math.round(iv * 1.6));
      }
      return true;
    }

    const removed = [];
    let unconfirmed = 0;
    // ONE scan for the whole batch. Removing a row leaves the other rows' nodes
    // intact, so the snapshot stays valid; stale entries are simply skipped.
    const btns = removeButtons();
    for (const b of btns) {
      if (removed.length >= maxPerCall) break;
      if (!document.body.contains(b)) continue;
      const tr = b.closest("tr");
      if (!tr || !matches(tr)) continue;
      const label = rowText(tr).slice(0, 80);
      try { b.click(); } catch (_) { continue; }
      if (!(await waitDetached(b, 2500))) unconfirmed += 1;
      removed.push(label);
    }

    if (removed.length === 0) {
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
    return { ok: true, done: false, removed, unconfirmed, remaining: rowCount() };
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

    const DELETE_BATCH = 25;   // rows removed per injected call (amortises DOM scans)
    let pace = 10;             // ms between batches; adapts if the page struggles
    const rawMax = parseInt(els.maxInput?.value, 10);
    const maxDeletes = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Infinity;

    running = true; stopRequested = false;
    els.startBtn.disabled = true; els.stopBtn.disabled = false;
    [els.modeAll, els.modeFilter, els.filterInput, els.maxInput].forEach((e) => e && (e.disabled = true));
    clearLog(); setProgress(0);
    log(filters.length
      ? '\u25b6 Deleting queue jobs matching: ' + filters.join(", ") + '\n'
      : '\u25b6 Deleting ALL queued jobs\n');

    let removed = 0, emptyStreak = 0, failStreak = 0;
    while (!stopRequested && removed < maxDeletes) {
      const want = Math.min(DELETE_BATCH, maxDeletes - removed);
      let res = null;
      const t0 = Date.now();
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: tab.id }, func: removeRowsInPage, args: [filters, want]
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
      if (batch.length === 0) {
        if (res.grew) { emptyStreak = 0; await sleep(pace); continue; }  // Show More revealed rows
        if (++emptyStreak >= 2) break;
        await sleep(pace);
        continue;
      }
      emptyStreak = 0;
      for (const label of batch) {
        removed += 1;
        log(removed + ". \u2713 " + label +
          (Number.isFinite(maxDeletes) ? "   [" + removed + "/" + maxDeletes + "]" : ""));
      }
      if (res.unconfirmed) log("  (" + res.unconfirmed + " unconfirmed in this batch)");
      if (Number.isFinite(maxDeletes)) setProgress(removed / maxDeletes);

      // Adaptive pacing: if the page is slow to remove rows, give it more room;
      // if it is keeping up, tighten back toward the floor.
      const perRow = (Date.now() - t0) / batch.length;
      if (res.unconfirmed || perRow > 250) pace = Math.min(500, Math.round(pace * 2) + 10);
      else pace = Math.max(10, pace - 10);
      await sleep(pace);
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

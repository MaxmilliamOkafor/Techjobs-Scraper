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

  // Injected into the LazyApply tab. Removes ONE matching row per call.
  // filters = array of lowercased substrings ([] = match anything).
  async function removeOneRowInPage(filters) {
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
    const renderedRows = () => Array.from(document.querySelectorAll("tbody tr"));

    let target = null;
    for (const btn of removeButtons()) {
      const tr = btn.closest("tr");
      if (tr && matches(tr)) { target = { btn, tr }; break; }
    }

    if (!target) {
      const showMore = Array.from(document.querySelectorAll("button")).find(
        (b) => /show more/i.test(b.textContent || "") && !b.disabled && b.offsetParent !== null
      );
      if (showMore) {
        const before = renderedRows().length;
        showMore.click();
        // Poll fast for the newly rendered rows instead of fixed 150ms ticks.
        const smDeadline = Date.now() + 3000;
        while (Date.now() < smDeadline) { if (renderedRows().length > before) break; await sleep(5); }
        for (const btn of removeButtons()) {
          const tr = btn.closest("tr");
          if (tr && matches(tr)) { target = { btn, tr }; break; }
        }
        if (!target) return { ok: true, done: true, removed: null, remaining: renderedRows().length };
      } else {
        return { ok: true, done: true, removed: null, remaining: renderedRows().length };
      }
    }

    const label = rowText(target.tr).slice(0, 80);
    const before = renderedRows().length;
    target.btn.click();

    // Poll at 5ms so each delete returns the moment the row disappears rather
    // than waiting out a 100ms tick; same ~2.5s worst case as before.
    let confirmed = false;
    const delDeadline = Date.now() + 2500;
    for (;;) {
      if (!document.body.contains(target.btn) || renderedRows().length < before) { confirmed = true; break; }
      if (Date.now() >= delDeadline) break;
      await sleep(5);
    }
    return { ok: true, done: false, removed: label, confirmed, remaining: renderedRows().length };
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

    const delay = 1; // fixed 1ms between deletes (no user toggle)
    const rawMax = parseInt(els.maxInput?.value, 10);
    const maxDeletes = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : Infinity;

    running = true; stopRequested = false;
    els.startBtn.disabled = true; els.stopBtn.disabled = false;
    [els.modeAll, els.modeFilter, els.filterInput, els.delayInput, els.maxInput].forEach((e) => e && (e.disabled = true));
    clearLog(); setProgress(0);
    log(filters.length
      ? '▶ Deleting queue jobs matching: ' + filters.join(", ") + ' — ~' + delay + 'ms apart.\n'
      : '▶ Deleting ALL queued jobs — ~' + delay + 'ms apart.\n');

    let removed = 0, emptyStreak = 0;
    while (!stopRequested && removed < maxDeletes) {
      let res;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: removeOneRowInPage, args: [filters] });
        res = r && r.result;
      } catch (e) { log("✗ Injection failed: " + (e?.message || e)); break; }
      if (!res || !res.ok) { log("✗ Unexpected page response — stopping."); break; }

      if (res.done || res.removed === null) { if (++emptyStreak >= 2) break; await sleep(delay); continue; }
      emptyStreak = 0; removed++;
      log(removed + ". ✓" + (res.confirmed ? "" : " (unconfirmed)") + " " + res.removed +
        (Number.isFinite(maxDeletes) ? "   [" + removed + "/" + maxDeletes + "]" : ""));
      if (Number.isFinite(maxDeletes)) setProgress(removed / maxDeletes);
      await sleep(delay);
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

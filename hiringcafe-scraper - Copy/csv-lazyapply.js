// csv-lazyapply.js — Additive feature (does not touch the scraper).
// Upload / drag-drop one or more CSV files of job URLs, keep only the four
// supported ATS platforms, dedupe across all files, then auto-add every URL
// into the LazyApply "Add Job to Queue" field — one by one, fast.

(function () {
  // LazyApply dashboard. We drive whichever tab is open on this origin.
  const LAZYAPPLY_MATCH = ["https://app.lazyapply.com/*"];

  // A Job URL is kept ONLY if it contains one of these. Everything else
  // (LinkedIn, Workday, SmartRecruiters, Personio, Indeed, …) is ignored.
  const ATS_PATTERNS = [
    /job-boards\.greenhouse\.io/i,
    /job-boards\.eu\.greenhouse\.io/i,
    /jobs\.lever\.co/i,
    /jobs\.ashbyhq\.com/i,
    /ats\.rippling\.com/i,
  ];
  const isSupported = (url) => ATS_PATTERNS.some((re) => re.test(url));

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
  let running = false;
  let stopRequested = false;

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

  function extractUrls(text) {
    const rows = parseCsv(text).filter((r) => r.some((c) => c && c.trim()));
    if (!rows.length) return [];
    const col = findUrlColumn(rows[0]);
    const out = [];
    const start = col === -1 ? 0 : 1; // no header match → scan every row/cell
    for (let r = start; r < rows.length; r++) {
      const cells = col === -1 ? rows[r] : [rows[r][col]];
      for (const cell of cells) {
        if (!cell) continue;
        const m = String(cell).match(/https?:\/\/[^\s",]+/);
        let url = (m ? m[0] : String(cell).trim()).replace(/[)\].,;]+$/, "");
        if (url && isSupported(url)) out.push(url);
      }
    }
    return out;
  }

  async function readFiles(fileList) {
    const files = Array.from(fileList);
    const perFile = [];
    const seen = new Set();
    const master = [];
    for (const f of files) {
      let urls = [];
      try { urls = extractUrls(await f.text()); }
      catch (e) { log(`⚠ Could not read ${f.name}: ${e?.message || e}`); }
      perFile.push({ name: f.name, count: urls.length });
      for (const u of urls) if (!seen.has(u)) { seen.add(u); master.push(u); }
    }
    return { perFile, master };
  }

  async function handleFiles(fileList) {
    if (!fileList || !fileList.length || running) return;
    clearLog();
    setProgress(0);
    const { perFile, master } = await readFiles(fileList);
    masterList = master;
    const totalRaw = perFile.reduce((a, b) => a + b.count, 0);
    const lines = perFile.map((p) => `  • ${p.name}: ${p.count} supported`);
    els.summary.textContent =
      `${perFile.length} file(s) scanned\n${lines.join("\n")}` +
      `\n\nSupported (pre-dedupe): ${totalRaw}\nUnique to add: ${master.length}`;
    els.startBtn.disabled = master.length === 0;
    log(
      master.length
        ? `Loaded ${master.length} unique supported URL(s). Open the LazyApply Job Queue, then click "Add to LazyApply Queue".`
        : "No supported ATS URLs found in those file(s)."
    );
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

    // Wait for React to re-render and enable the button. A button that stays
    // disabled means the input event didn't register yet → re-fire and retry.
    let btn = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await sleep(150);
      btn = findAddButton(input);
      if (btn && !btn.disabled) break;
      fire("input"); // nudge React again
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
    // returns to disabled. Poll for that (up to ~2.5s) as the success signal.
    let confirmed = false;
    for (let i = 0; i < 25; i++) {
      await sleep(100);
      const cur = findInput();
      if ((cur && cur.value === "") || btn.disabled) { confirmed = true; break; }
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
    if (running || !masterList.length) return;
    const tab = await findLazyApplyTab();
    if (!tab) {
      log('⚠ Open https://app.lazyapply.com/dashboard and select the "Job Queue" tab first.');
      return;
    }

    running = true;
    stopRequested = false;
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    els.fileInput.disabled = true;
    els.dropzone.classList.add("disabled");

    const raw = parseInt(els.delayInput?.value, 10);
    const delay = Math.max(0, Number.isFinite(raw) ? raw : 250);
    let added = 0;
    const failed = [];
    log(`\n▶ Adding ${masterList.length} URL(s) — ~${delay}ms apart.\n`);

    for (let i = 0; i < masterList.length; i++) {
      if (stopRequested) { log(`\n■ Stopped at ${i}/${masterList.length}.`); break; }
      const url = masterList[i];
      setProgress(i / masterList.length);
      try {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: addUrlToQueueInPage,
          args: [url],
        });
        const r = res && res.result;
        if (r && r.ok) {
          added++;
          log(`Adding ${i + 1}/${masterList.length} ✓${r.confirmed ? "" : " (unconfirmed)"}  ${url}`);
        } else {
          failed.push({ url, error: (r && r.error) || "unknown" });
          log(`Adding ${i + 1}/${masterList.length} ✗  ${url}  — ${(r && r.error) || "failed"}`);
        }
      } catch (e) {
        failed.push({ url, error: e?.message || String(e) });
        log(`Adding ${i + 1}/${masterList.length} ✗  ${url}  — ${e?.message || e}`);
      }
      await sleep(delay);
    }

    setProgress(1);
    running = false;
    els.stopBtn.disabled = true;
    els.fileInput.disabled = false;
    els.dropzone.classList.remove("disabled");
    els.startBtn.disabled = masterList.length === 0;

    log(`\n✔ Done. Added: ${added}.  Failed/skipped: ${failed.length}.`);
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
})();

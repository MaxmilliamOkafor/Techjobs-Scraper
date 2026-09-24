// popup.js — UI for Tech Jobs Scraper (hiring.cafe + careerhound.io + eurotoptech, two-picker, single-line CSV)

const SETTINGS_KEY = "hiringcafe_settings";

// Both supported sites — used for tab discovery and validation.
const SITE_MATCH = [
  "https://hiring.cafe/*", "https://*.hiring.cafe/*",
  "https://jobright.ai/*", "https://*.jobright.ai/*",
  "https://careerhound.io/*", "https://*.careerhound.io/*",
  "https://eurotoptech.com/*", "https://*.eurotoptech.com/*",
  "https://simplify.jobs/*", "https://*.simplify.jobs/*",
  "https://hnhiring.com/*", "https://*.hnhiring.com/*"
];
const ON_SITE_RE = /(hiring\.cafe|jobright\.ai|careerhound\.io|eurotoptech\.com|simplify\.jobs|hnhiring\.com)/;

const els = {
  diagBtn: document.getElementById("diag-btn"),
  diagLog: document.getElementById("diag-log"),
  startBtn: document.getElementById("start-btn"),
  stopBtn: document.getElementById("stop-btn"),
  exportBtn: document.getElementById("export-btn"),
  clearBtn: document.getElementById("clear-btn"),
  pickBtn: document.getElementById("pick-btn"),
  pickClearBtn: document.getElementById("pick-clear-btn"),
  pickerResult: document.getElementById("picker-result"),
  pickPaginationBtn: document.getElementById("pick-pagination-btn"),
  pickPaginationClearBtn: document.getElementById("pick-pagination-clear-btn"),
  pickerPaginationResult: document.getElementById("picker-pagination-result"),
  statusPill: document.getElementById("status-pill"),
  pageProgress: document.getElementById("page-progress"),
  scrapedCount: document.getElementById("scraped-count"),
  pageCount: document.getElementById("page-count"),
  inflightCount: document.getElementById("inflight-count"),
  fastCount: document.getElementById("fast-count"),
  tabCount: document.getElementById("tab-count"),
  errorRow: document.getElementById("error-row"),
  progressBar: document.getElementById("progress-bar"),
  strategyRadios: document.querySelectorAll('input[name="strategy"]')
};

// Lean export: only decision-relevant columns. Internal/duplicate fields
// (Source URL, HiringCafe URL, Status, Method, Scraped at) and the noisy
// Description/Skills fields are intentionally omitted.
const CSV_COLUMNS = [
  { key: "url", label: "Job URL" },
  { key: "ats_provider", label: "ATS" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company" },
  { key: "location", label: "Location" },
  { key: "salary", label: "Salary" },
  { key: "work_mode", label: "Work Mode" },
  { key: "yoe", label: "Experience" },
  { key: "commitment", label: "Commitment" },
  { key: "posted_age", label: "Posted" }
];

// Single-line CSV cells (Ultimate-Web-Scraper style): collapse newlines to a
// single space inside each cell, RFC-4180 quote any cell containing comma /
// double-quote / leading-or-trailing whitespace. No BOM in output.
function csvEscape(v) {
  if (v == null) return "";
  const raw = String(v);
  let s = raw.replace(/\r\n|\r|\n/g, " ").replace(/\s{2,}/g, " ").trim();
  if (/[",]/.test(s) || s !== raw.trim()) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}
function rowsToCsv(rows) {
  const header = CSV_COLUMNS.map((c) => csvEscape(c.label)).join(",");
  const body = rows.map((r) => CSV_COLUMNS.map((c) => csvEscape(r[c.key])).join(",")).join("\n");
  return header + "\n" + body + "\n";
}
function downloadCsv(csv, filename) {
  // Prepend a UTF-8 BOM so Excel decodes €/£ and accented chars correctly.
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      void chrome.runtime.lastError; resolve(resp);
    });
  });
}

async function loadSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return r[SETTINGS_KEY] || { strategy: "pagination", columnSpec: null, paginationSpec: null };
}
async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

function setStatusPill(status) {
  const map = {
    idle:     ["pill-idle", "Idle"],
    running:  ["pill-running", "Running"],
    stopping: ["pill-stopping", "Stopping…"],
    done:     ["pill-done", "Done"],
    error:    ["pill-error", "Error"]
  };
  const [cls, label] = map[status] || map.idle;
  els.statusPill.className = "pill " + cls;
  els.statusPill.textContent = label;
}

function render(state, resultCount) {
  setStatusPill(state.status);
  if (state.totalPages) els.pageProgress.textContent = `${state.pageIndex || 0}/${state.totalPages}`;
  else if (state.pageIndex) els.pageProgress.textContent = `${state.pageIndex}`;
  else els.pageProgress.textContent = "—";
  els.scrapedCount.textContent = String(resultCount);
  els.pageCount.textContent = String(state.scrapedThisPage || 0);
  els.inflightCount.textContent = String(state.inFlight || 0);
  els.fastCount.textContent = String(state.fetchHits || 0);
  els.tabCount.textContent = String(state.tabHits || 0);
  if (state.lastError) { els.errorRow.textContent = state.lastError; els.errorRow.hidden = false; }
  else els.errorRow.hidden = true;
  if (els.progressBar) {
    let pct;
    if (state.status === "done") pct = 100;
    else if (state.totalPages && state.pageIndex) pct = Math.min(100, (state.pageIndex / state.totalPages) * 100);
    else if (state.status === "running" || state.status === "stopping") pct = 8;
    else pct = 0;
    els.progressBar.style.width = pct + "%";
  }
  const isRunning = state.status === "running" || state.status === "stopping";
  els.startBtn.disabled = isRunning;
  els.stopBtn.disabled = !isRunning;
  els.exportBtn.disabled = resultCount === 0;
  els.pickBtn.disabled = isRunning;
  els.pickPaginationBtn.disabled = isRunning;
  for (const r of els.strategyRadios) r.disabled = isRunning;
}

function renderSinglePicker(spec, resultEl, clearBtn) {
  if (spec) {
    const label = spec.label || spec.text || spec.ariaLabel || spec.tag || "element";
    resultEl.className = "picker-result picker-locked";
    resultEl.textContent = `Locked: ${label}`;
    clearBtn.disabled = false;
  } else {
    resultEl.className = "picker-result picker-empty";
    resultEl.textContent = "No element selected — auto-detect will be used.";
    clearBtn.disabled = true;
  }
}
function renderPickers(settings) {
  renderSinglePicker(settings.columnSpec, els.pickerResult, els.pickClearBtn);
  renderSinglePicker(settings.paginationSpec, els.pickerPaginationResult, els.pickPaginationClearBtn);
}

function setStrategy(value) {
  for (const r of els.strategyRadios) r.checked = r.value === value;
}

async function refresh() {
  const settings = await loadSettings();
  setStrategy(settings.strategy || "pagination");
  renderPickers(settings);
  const resp = await send("GET_STATE");
  if (!resp || !resp.ok) { setStatusPill("idle"); return; }
  render(resp.state, resp.resultCount);
}

els.strategyRadios.forEach((r) => {
  r.addEventListener("change", async () => { await saveSettings({ strategy: r.value }); });
});

async function startPickerMode(mode) {
  els.errorRow.hidden = true;
  const tabs = await chrome.tabs.query({ url: SITE_MATCH });
  if (!tabs.length) {
    els.errorRow.textContent = "Open hiring.cafe, jobright.ai, careerhound.io, eurotoptech.com, simplify.jobs, or hnhiring.com in a tab first.";
    els.errorRow.hidden = false;
    return;
  }
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const target = tabs[0];
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true });
  const resp = await send("START_PICKER", { tabId: target.id, mode });
  if (!resp || !resp.ok) {
    els.errorRow.textContent = (resp && resp.error) || "Could not start picker.";
    els.errorRow.hidden = false;
  }
}

els.pickBtn.addEventListener("click", () => startPickerMode("column"));
els.pickPaginationBtn.addEventListener("click", () => startPickerMode("pagination"));

els.pickClearBtn.addEventListener("click", async () => {
  const s = await saveSettings({ columnSpec: null });
  renderPickers(s);
});
els.pickPaginationClearBtn.addEventListener("click", async () => {
  const s = await saveSettings({ paginationSpec: null });
  renderPickers(s);
});

els.startBtn.addEventListener("click", async () => {
  els.errorRow.hidden = true;
  els.startBtn.disabled = true;
  const settings = await loadSettings();
  if (settings.strategy === "loadmore" && !settings.paginationSpec) {
    els.errorRow.textContent = "Pick the Load More button first (use the Pagination picker above).";
    els.errorRow.hidden = false;
    els.startBtn.disabled = false;
    return;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onSite = active && active.url && ON_SITE_RE.test(active.url);
  if (!onSite) {
    const tabs = await chrome.tabs.query({ url: SITE_MATCH });
    if (!tabs.length) {
      els.errorRow.textContent = "Open hiring.cafe, jobright.ai, careerhound.io, eurotoptech.com, simplify.jobs, or hnhiring.com in a tab first.";
      els.errorRow.hidden = false;
      els.startBtn.disabled = false;
      return;
    }
  }
  const resp = await send("START_SCRAPE", {
    options: {
      strategy: settings.strategy || "pagination",
      columnSpec: settings.columnSpec || null,
      paginationSpec: settings.paginationSpec || null
    }
  });
  if (!resp || !resp.ok) {
    els.errorRow.textContent = (resp && resp.error) || "Could not start scrape.";
    els.errorRow.hidden = false;
    els.startBtn.disabled = false;
  }
  await refresh();
});

els.stopBtn.addEventListener("click", async () => { els.stopBtn.disabled = true; await send("STOP_SCRAPE"); await refresh(); });
els.clearBtn.addEventListener("click", async () => { await send("CLEAR_RESULTS"); await refresh(); });
els.exportBtn.addEventListener("click", async () => {
  const resp = await send("GET_RESULTS");
  if (!resp || !resp.ok || !resp.results || resp.results.length === 0) {
    els.errorRow.textContent = "No results to export yet.";
    els.errorRow.hidden = false;
    return;
  }
  const csv = rowsToCsv(resp.results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadCsv(csv, `tech-jobs-${stamp}.csv`);
});

// ---- Diagnostics: capture the page structure for selector debugging --------
// Runs in the page and returns a compact, shareable snapshot: what job cards and
// apply controls actually look like right now. Avoids guessing at selectors.
function capturePageStructure() {
  const txt = (el) => ((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + " …[truncated]" : s || "");
  const hasFiber = (el) => !!(el && Object.keys(el).some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")));
  const APPLY_RE = /\b(apply\s+with\s+autofill|apply\s+now|apply|job\s+posting)\b/i;

  const applyControls = Array.from(document.querySelectorAll('a, button, [role="button"]'))
    .filter((el) => APPLY_RE.test(txt(el)))
    .slice(0, 4);

  // Climb from an apply control to something card-sized.
  const cardOf = (el) => {
    let n = el, i = 0;
    while (n && n !== document.body && i < 25) { if (txt(n).length > 60) return n; n = n.parentElement; i += 1; }
    return el;
  };
  const cards = [];
  const seen = new Set();
  for (const c of applyControls) {
    const card = cardOf(c);
    if (card && !seen.has(card)) { seen.add(card); cards.push(card); }
  }

  const lines = [];
  lines.push("URL: " + location.href);
  lines.push("Host: " + location.hostname);
  lines.push("Job-ish links: " + document.querySelectorAll('a[href*="/job/"], a[href*="/jobs/"], a[href*="job="]').length);
  lines.push("[data-testid] nodes: " + document.querySelectorAll("[data-testid]").length);
  const testids = Array.from(new Set(Array.from(document.querySelectorAll("[data-testid]"))
    .map((e) => e.getAttribute("data-testid")).filter(Boolean))).slice(0, 25);
  lines.push("data-testid values: " + (testids.join(", ") || "(none)"));
  lines.push("Apply-ish controls found: " + applyControls.length);
  lines.push("React fiber on first control: " + (applyControls[0] ? hasFiber(applyControls[0]) : "n/a"));
  lines.push("");
  applyControls.slice(0, 2).forEach((c, i) => {
    lines.push("--- APPLY CONTROL " + (i + 1) + " (<" + c.tagName.toLowerCase() + ">, text: " + JSON.stringify(txt(c)) + ") ---");
    lines.push(clip(c.outerHTML, 1200));
    lines.push("");
  });
  cards.slice(0, 2).forEach((c, i) => {
    lines.push("--- CARD " + (i + 1) + " ---");
    lines.push(clip(c.outerHTML, 3000));
    lines.push("");
  });
  return lines.join("\n");
}

if (els.diagBtn) {
  els.diagBtn.addEventListener("click", async () => {
    els.diagLog.textContent = "Capturing…";
    try {
      const tabs = await chrome.tabs.query({ url: SITE_MATCH });
      if (!tabs.length) { els.diagLog.textContent = "Open a supported job site in a tab first."; return; }
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id }, func: capturePageStructure, world: "MAIN"
      });
      const out = (res && res.result) || "(no output)";
      els.diagLog.textContent = out;
      try {
        await navigator.clipboard.writeText(out);
        els.diagLog.textContent = "✔ Copied to clipboard — paste it to whoever is fixing the selectors.\n\n" + out;
      } catch (_) {
        els.diagLog.textContent = "(Clipboard blocked — select the text below and copy manually.)\n\n" + out;
      }
    } catch (e) {
      els.diagLog.textContent = "Capture failed: " + (e?.message || e);
    }
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "STATE_UPDATE") refresh();
  if (msg && msg.type === "ELEMENT_PICKED") refresh();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SETTINGS_KEY]) refresh();
});

refresh();

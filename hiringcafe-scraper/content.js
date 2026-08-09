// content.js — hiring.cafe + eurotoptech.com + simplify.jobs
// v2.3.0 — the exported "Job URL" column now only ever holds a resolved external
//          ATS link; aggregator links (hiring.cafe/job/...) are never stored —
//          unresolved rows are left blank and flagged in the status column.
// v2.1.0 — fixed card boundary, title/company extraction, "X or Y" locations,
//          multi-currency (€/£/$) salary; single clean copy (duplicate removed).

(() => {
  if (window.__hiringCafeScraperInjected__) return;
  window.__hiringCafeScraperInjected__ = true;

  const PAGE_RENDER_TIMEOUT_MS = 12000;
  const PAGE_RENDER_POLL_MS = 150;
  const PAGE_QUIET_MS = 350;
  const POST_CLICK_GRACE_MS = 200;
  const APPEND_WAIT_TIMEOUT_MS = 12000;
  const SCROLL_STEP_PX = 1200;
  const SCROLL_PAUSE_MS = 250;
  const APPEND_NO_GROWTH_TRIES = 4;

  let aborted = false;
  let pickerActive = false;
  let pickerMode = "pagination"; // or "column"

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Aggregator hosts that must NEVER survive into the exported "Job URL" column —
  // a real ATS link (greenhouse/lever/workday/etc.) is the only acceptable value.
  // If resolution returns one of these (or fails), the URL is treated as unresolved.
  const AGGREGATOR_HOST_RE = /(^|\.)(hiring\.cafe|careerhound\.io|eurotoptech\.com|simplify\.jobs|hnhiring\.com)$/i;
  function isResolvedExternalUrl(u) {
    if (!u || !/^https?:\/\//i.test(u)) return false;
    try { return !AGGREGATOR_HOST_RE.test(new URL(u).host); } catch (_) { return false; }
  }
  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
          void chrome.runtime.lastError; resolve(resp);
        });
      } catch (e) { resolve(null); }
    });
  }
  function visibleText(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  }
  function looksLikeChip(el) {
    if (!el) return false;
    const t = visibleText(el);
    if (!t || t.length > 80) return false;
    if (t.includes("\n")) return false;
    return true;
  }
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    return true;
  }

  function findJobCards() {
    const anchors = Array.from(document.querySelectorAll("a, button")).filter(
      (el) => /^Job Posting\b/i.test(visibleText(el))
    );
    const cards = [];
    const seen = new Set();
    for (const a of anchors) {
      let node = a.parentElement, card = null, safety = 0;
      while (node && node !== document.body && safety < 30) {
        // Use rendered text (collapsed whitespace) so the tiny button wrapper
        // ("Job Posting View all", ~20 chars) is rejected and we climb to the
        // real card that holds title/company/location/etc.
        const txt = visibleText(node);
        if (txt.length > 120 && /Job Posting/i.test(txt) && /View all/i.test(txt)
            && node.querySelectorAll("a").length < 30) {
          card = node; break;
        }
        node = node.parentElement;
        safety += 1;
      }
      if (card && !seen.has(card)) { seen.add(card); cards.push(card); }
    }
    return cards;
  }

  const TIME_AGO_RE = /^\d+\s*[smhdw]$/i;
  const YOE_RE = /^(?:\?|\d+\+?)\s*YOE\b/i;
  // Multi-currency: matches euro/pound/dollar amounts (and ranges) so non-USD
  // salaries are no longer silently dropped.
  const SALARY_RE = /[€£$]\s?[\d.,]+\s*(?:k|K|M)?(?:\s*[-–to]+\s*[€£$]?\s?[\d.,]+\s*(?:k|K|M)?)?\s*\/?\s*(?:yr|hr|mo|year|hour|month)?/i;
  const MODE_VALUES = new Set(["onsite", "remote", "hybrid", "in-person", "in person", "field"]);
  const COMMITMENT_VALUES = new Set([
    "full time", "full-time", "fulltime", "part time", "part-time", "parttime",
    "contract", "contractor", "internship", "intern",
    "temporary", "temp", "seasonal", "seasonal, temporary",
    "multiple commitments available"
  ]);
  // Words that are never a job title (actions + meta labels).
  const TITLE_SKIP_RE = /^(Job Posting|View all|Apply|Save|Mark Applied|Hide|views?|saves?|applications?)\b/i;
  // Alt strings that are not a usable company name. On hiring.cafe the logo is a
  // favicon whose alt IS the company (e.g. "Boots", "Remote", "Vodafone"), so we
  // only reject genuinely structural/decorative alts here.
  const GENERIC_ALT = new Set(["logo", "company", "favicon", "icon", ""]);

  function getJobPostingAnchor(card) {
    for (const a of card.querySelectorAll("a")) {
      if (/^Job Posting\b/i.test(visibleText(a)) && a.href && !/^javascript:/i.test(a.href)) return a;
    }
    return null;
  }
  function getViewAllAnchor(card) {
    for (const a of card.querySelectorAll("a")) {
      if (/^View all\b/i.test(visibleText(a))) return a;
    }
    return null;
  }
  // Stable identity for a job card, used to dedupe across pages so a relevance
  // reshuffle (same jobs, new order) can't make pagination loop forever.
  function cardKey(card) {
    const a = getJobPostingAnchor(card);
    if (a && a.href) return a.href;
    const t = (getTitle(card) + "|" + getCompanyName(card)).trim();
    return t === "|" ? "" : t;
  }
  // Title = largest non-company, non-action, non-meta text leaf.
  // hiring.cafe cards have no h1-h6, so the font-size heuristic carries the
  // load - but we now exclude the company name and time/YOE chips so the
  // company can no longer win the "title" slot.
  function getTitle(card) {
    const company = getCompanyName(card);
    const headings = card.querySelectorAll("h1, h2, h3, h4, h5, h6");
    for (const h of headings) {
      const t = visibleText(h);
      if (t && t.length > 2 && !TITLE_SKIP_RE.test(t) && t !== company) return t;
    }
    let best = null, bestSize = 0;
    for (const el of card.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = visibleText(el);
      if (!t || t.length < 3 || t.length > 200) continue;
      if (TITLE_SKIP_RE.test(t) || TIME_AGO_RE.test(t) || YOE_RE.test(t)) continue;
      if (company && t === company) continue;
      const cs = window.getComputedStyle(el);
      const size = parseFloat(cs.fontSize) || 0;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const score = size + (weight >= 600 ? 4 : 0);
      if (score > bestSize) { bestSize = score; best = t; }
    }
    return best || "";
  }
  // Company = the logo favicon's alt attribute, which hiring.cafe derives from the
  // employer domain (boots.com -> "Boots", remote.com -> "Remote"). This is the
  // authoritative source, so we trust it directly and only reject decorative alts.
  function getCompanyName(card) {
    const img = card.querySelector("img");
    const alt = img && img.alt ? img.alt.trim() : "";
    if (alt && !GENERIC_ALT.has(alt.toLowerCase())) return alt;
    // Fallback: legacy "Company: ..." pattern in the card text.
    const cardText = card.innerText || "";
    const m = cardText.match(/^\s*([A-Z][^\n:]{1,80})\s*:\s*[A-Z]/m);
    return m ? m[1].trim() : "";
  }
  function classifyChips(card) {
    const result = { location: [], salary: [], mode: [], commitment: [], yoe: [], timeAgo: [], other: [] };
    for (const el of card.querySelectorAll("*")) {
      if (el.children.length) continue;
      const t = visibleText(el);
      if (!t || !looksLikeChip(el)) continue;
      const lower = t.toLowerCase();
      if (TIME_AGO_RE.test(t)) { result.timeAgo.push(t); continue; }
      if (YOE_RE.test(t)) { result.yoe.push(t); continue; }
      if (SALARY_RE.test(t) && /[€£$]/.test(t)) { result.salary.push(t); continue; }
      if (MODE_VALUES.has(lower)) { result.mode.push(t); continue; }
      if (COMMITMENT_VALUES.has(lower)) { result.commitment.push(t); continue; }
      // Accept "Paris, France" AND hiring.cafe's "London or United Kingdom or Europe".
      if (/^[A-Z][\w. ]+(?:,|\s+or\s+)[A-Z][\w. ]+/.test(t)
          || /\b(United States|United Kingdom|Remote|Worldwide|Europe)\b/i.test(t)) {
        if (t.length <= 120 && !/[.;:]/.test(t)) { result.location.push(t); continue; }
      }
      result.other.push(t);
    }
    return result;
  }
  const dedupe = (a) => Array.from(new Set(a));
  function getDescription(card) {
    let best = "";
    for (const el of card.querySelectorAll("p, span, div")) {
      if (el.children.length > 1) continue;
      const t = visibleText(el);
      if (!t || t.length < 40) continue;
      if (/Job Posting|View all|Apply Directly|Apply now/i.test(t)) continue;
      if (t.length > best.length) best = t;
    }
    return best;
  }
  function getSkills(card) {
    let best = null;
    for (const el of card.querySelectorAll("div, span, p, li")) {
      const t = visibleText(el);
      if (!t || t.length > 250 || !t.includes(",")) continue;
      if (/Job Posting|View all|YOE|Apply/i.test(t)) continue;
      if (/[.;:]\s/.test(t)) continue;
      const parts = t.split(/\s*,\s*/).filter(Boolean);
      if (parts.length < 2) continue;
      if (parts.every((p) => p.length > 0 && p.length < 50)) best = t;
    }
    return best || "";
  }

  function buildRowMeta(card) {
    const jobAnchor = getJobPostingAnchor(card);
    const viewAllAnchor = getViewAllAnchor(card);
    const jobPostingUrl = jobAnchor ? jobAnchor.href : "";
    const viewAllUrl = viewAllAnchor ? viewAllAnchor.href : "";
    const chips = classifyChips(card);
    return {
      url: "",
      title: getTitle(card),
      company: getCompanyName(card),
      location: dedupe(chips.location).join(" | "),
      salary: dedupe(chips.salary).join(" | "),
      work_mode: dedupe(chips.mode).join(" | "),
      commitment: dedupe(chips.commitment).join(" | "),
      yoe: dedupe(chips.yoe).join(" | "),
      posted_age: dedupe(chips.timeAgo).join(" | "),
      description: getDescription(card),
      skills: getSkills(card),
      job_posting_initial_url: jobPostingUrl,
      hiringcafe_viewall_url: viewAllUrl,
      status: jobPostingUrl ? "pending" : "no job posting url on card",
      method: "",
      scraped_at: new Date().toISOString()
    };
  }

  // ---- picker (smart) ----
  function nearestClickable(el) {
    let node = el, safety = 0;
    while (node && node !== document.body && safety < 12) {
      if (!(node instanceof Element)) { node = node.parentElement; safety++; continue; }
      const tag = node.tagName.toLowerCase();
      if (tag === "button" || tag === "a") return node;
      const role = node.getAttribute && node.getAttribute("role");
      if (role === "button" || role === "link" || role === "tab" || role === "menuitem") return node;
      if (node.hasAttribute && node.hasAttribute("onclick")) return node;
      try { const cs = window.getComputedStyle(node); if (cs.cursor === "pointer") return node; } catch (_) {}
      node = node.parentElement; safety += 1;
    }
    return el;
  }
  // For COLUMN picking, snap to the repeated "card" element so the highlight and
  // the stored spec target a whole card (like the picker feels on hiring.cafe),
  // not the inner cursor:pointer box that nearestClickable lands on for MUI cards.
  function cardContainerOf(el) {
    if (!el || !el.closest) return null;
    if (typeof sjIsTarget === "function" && sjIsTarget()) {
      const c = el.closest('[data-testid="job-card"]');
      return c ? (c.closest("button") || c) : null;
    }
    if (typeof ettIsTarget === "function" && ettIsTarget()) {
      return el.closest(".MuiCard-root");
    }
    let node = el, safety = 0;
    while (node && node !== document.body && safety < 30) {
      const txt = visibleText(node);
      if (txt.length > 120 && /Job Posting/i.test(txt) && /View all/i.test(txt)
          && node.querySelectorAll("a").length < 30) return node;
      node = node.parentElement; safety += 1;
    }
    return null;
  }
  function pickerTargetFor(raw) {
    if (pickerMode === "column") {
      const card = cardContainerOf(raw);
      if (card) return card;
    }
    return nearestClickable(raw);
  }
  function structuralPath(el) {
    const path = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const parent = node.parentElement; if (!parent) break;
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      const idx = same.indexOf(node) + 1;
      path.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${idx})`);
      node = parent;
    }
    return path.join(" > ");
  }
  function buildElementSpec(el) {
    const text = visibleText(el).slice(0, 100);
    const ariaLabel = (el.getAttribute && el.getAttribute("aria-label")) || "";
    const title = (el.getAttribute && el.getAttribute("title")) || "";
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    const tag = el.tagName.toLowerCase();
    const id = el.id || "";
    return { tag, text, ariaLabel, title, role, id, path: structuralPath(el),
      label: ariaLabel || text || title || tag };
  }
  function findByElementSpec(spec) {
    if (!spec) return null;
    if (spec.id) { const el = document.getElementById(spec.id); if (el && isVisible(el)) return el; }
    if (spec.ariaLabel) {
      const escaped = spec.ariaLabel.replace(/"/g, '\\"');
      const candidates = document.querySelectorAll(`[aria-label="${escaped}"]`);
      for (const c of candidates) if (isVisible(c)) return c;
    }
    if (spec.text) {
      const candidates = document.querySelectorAll(spec.tag || "*");
      for (const c of candidates) if (visibleText(c) === spec.text && isVisible(c)) return c;
    }
    if (spec.path) {
      try { const el = document.querySelector(spec.path); if (el && isVisible(el)) return el; } catch (_) {}
    }
    return null;
  }

  let pickerOverlay = null, pickerLabel = null, pickerTip = null, pickerHovered = null;
  function ensurePickerOverlay() {
    if (pickerOverlay) return;
    pickerOverlay = document.createElement("div");
    pickerOverlay.style.cssText = "position:fixed;top:0;left:0;pointer-events:none;z-index:2147483646;border:2px solid #d946ef;background:rgba(217,70,239,0.12);transition:all 0.05s linear;box-sizing:border-box;border-radius:4px";
    pickerLabel = document.createElement("div");
    pickerLabel.style.cssText = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:8px 14px;background:#0f1014;color:#fff;border:1px solid #d946ef;border-radius:8px;font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;letter-spacing:0.2px;box-shadow:0 6px 24px rgba(0,0,0,0.5);pointer-events:none;white-space:nowrap";
    pickerLabel.textContent = pickerMode === "column"
      ? "Picking JOBS COLUMN — hover a card / row. Click to lock. Esc to cancel."
      : "Picking PAGINATION BUTTON — hover Next / Load More / › . Click to lock. Esc to cancel.";
    pickerTip = document.createElement("div");
    pickerTip.style.cssText = "position:fixed;top:0;left:0;z-index:2147483647;padding:5px 9px;background:#0f1014;color:#e6e6f0;border:1px solid #d946ef;border-radius:6px;font:600 11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;box-shadow:0 4px 14px rgba(0,0,0,0.5);pointer-events:none;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
    pickerTip.textContent = "";
    document.documentElement.appendChild(pickerOverlay);
    document.documentElement.appendChild(pickerLabel);
    document.documentElement.appendChild(pickerTip);
  }
  function destroyPickerOverlay() {
    if (pickerOverlay) { pickerOverlay.remove(); pickerOverlay = null; }
    if (pickerLabel) { pickerLabel.remove(); pickerLabel = null; }
    if (pickerTip) { pickerTip.remove(); pickerTip = null; }
    pickerHovered = null;
  }
  function pickerTipText(el) {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute && el.getAttribute("aria-label");
    const text = visibleText(el).slice(0, 40);
    const role = el.getAttribute && el.getAttribute("role");
    const parts = [tag];
    if (role) parts.push(`[role=${role}]`);
    if (aria) parts.push(`"${aria}"`); else if (text) parts.push(`"${text}"`);
    return "✨ " + parts.join(" ") + "  — click to lock";
  }
  function onPickerMove(e) {
    if (!pickerActive) return;
    const raw = document.elementFromPoint(e.clientX, e.clientY); if (!raw) return;
    const target = pickerTargetFor(raw);
    if (target !== pickerHovered) {
      pickerHovered = target;
      const r = target.getBoundingClientRect();
      pickerOverlay.style.left = r.left + "px"; pickerOverlay.style.top = r.top + "px";
      pickerOverlay.style.width = r.width + "px"; pickerOverlay.style.height = r.height + "px";
      pickerTip.textContent = pickerTipText(target);
    }
    pickerTip.style.left = Math.min(e.clientX + 14, window.innerWidth - 340) + "px";
    pickerTip.style.top = Math.max(e.clientY + 18, 0) + "px";
  }
  function onPickerClick(e) {
    if (!pickerActive) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const raw = document.elementFromPoint(e.clientX, e.clientY); if (!raw) return;
    const target = pickerTargetFor(raw);
    const spec = buildElementSpec(target);
    chrome.storage.local.get("hiringcafe_settings").then((r) => {
      const cur = r.hiringcafe_settings || { strategy: "pagination", columnSpec: null, paginationSpec: null };
      if (pickerMode === "column") cur.columnSpec = spec;
      else cur.paginationSpec = spec;
      chrome.storage.local.set({ hiringcafe_settings: cur }).then(() => {
        send("ELEMENT_PICKED", { spec, mode: pickerMode });
        stopPicker();
      });
    });
  }
  function onPickerSwallow(e) {
    if (!pickerActive) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
  }
  function onPickerKey(e) { if (pickerActive && e.key === "Escape") { e.preventDefault(); stopPicker(); } }
  function startPicker(mode) {
    if (pickerActive) return;
    pickerMode = mode === "column" ? "column" : "pagination";
    pickerActive = true;
    ensurePickerOverlay();
    document.addEventListener("mousemove", onPickerMove, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("mousedown", onPickerSwallow, true);
    document.addEventListener("mouseup", onPickerSwallow, true);
    document.addEventListener("pointerdown", onPickerSwallow, true);
    document.addEventListener("pointerup", onPickerSwallow, true);
    document.addEventListener("keydown", onPickerKey, true);
  }
  function stopPicker() {
    pickerActive = false;
    document.removeEventListener("mousemove", onPickerMove, true);
    document.removeEventListener("click", onPickerClick, true);
    document.removeEventListener("mousedown", onPickerSwallow, true);
    document.removeEventListener("mouseup", onPickerSwallow, true);
    document.removeEventListener("pointerdown", onPickerSwallow, true);
    document.removeEventListener("pointerup", onPickerSwallow, true);
    document.removeEventListener("keydown", onPickerKey, true);
    destroyPickerOverlay();
  }

  // ---- pagination ----
  function findPagination() {
    const allButtons = Array.from(document.querySelectorAll("button, a"));
    const numbered = allButtons.filter((b) => /^\d+$/.test(visibleText(b)));
    if (numbered.length < 2) return null;
    let ancestor = numbered[0].parentElement;
    while (ancestor && !numbered.every((b) => ancestor.contains(b))) ancestor = ancestor.parentElement;
    return ancestor || null;
  }
  function getCurrentPageNumber(paginationEl) {
    if (!paginationEl) return null;
    const numbered = Array.from(paginationEl.querySelectorAll("button, a")).filter(
      (b) => /^\d+$/.test(visibleText(b))
    );
    for (const b of numbered) {
      if (b.getAttribute("aria-current")) return parseInt(visibleText(b), 10);
      if (b.getAttribute("aria-selected") === "true") return parseInt(visibleText(b), 10);
    }
    const bgCounts = new Map();
    for (const b of numbered) {
      const cs = window.getComputedStyle(b);
      const key = cs.backgroundColor + "|" + cs.color;
      bgCounts.set(key, (bgCounts.get(key) || 0) + 1);
    }
    let oddKey = null, oddCount = Infinity;
    for (const [k, c] of bgCounts) if (c < oddCount) { oddCount = c; oddKey = k; }
    for (const b of numbered) {
      const cs = window.getComputedStyle(b);
      if (cs.backgroundColor + "|" + cs.color === oddKey) return parseInt(visibleText(b), 10);
    }
    return null;
  }
  function getTotalPages(paginationEl) {
    if (!paginationEl) return null;
    const numbers = Array.from(paginationEl.querySelectorAll("button, a"))
      .map((b) => parseInt(visibleText(b), 10))
      .filter((n) => Number.isFinite(n));
    return numbers.length ? Math.max(...numbers) : null;
  }
  function autoDetectNextButton(paginationEl) {
    if (!paginationEl) return null;
    const current = getCurrentPageNumber(paginationEl);
    if (current != null) {
      const target = String(current + 1);
      for (const b of paginationEl.querySelectorAll("button, a"))
        if (visibleText(b) === target && !b.disabled) return b;
    }
    const ariaNext = paginationEl.querySelector('button[aria-label*="next" i], a[aria-label*="next" i], button[title*="next" i]');
    if (ariaNext && !ariaNext.disabled) return ariaNext;
    const buttons = Array.from(paginationEl.querySelectorAll("button, a")).filter(
      (b) => !/^\d+$/.test(visibleText(b)) && !b.disabled
    );
    if (buttons.length) return buttons[buttons.length - 1];
    return null;
  }
  function clickAt(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "auto" });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("mousedown", opts)); } catch (_) {}
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("mouseup", opts)); } catch (_) {}
    try { el.dispatchEvent(new MouseEvent("click", opts)); } catch (_) {}
    try { if (typeof el.click === "function") el.click(); } catch (_) {}
  }

  function cardSignature(cards) {
    const titles = cards.slice(0, 3).map((c) => getTitle(c));
    return cards.length + "|" + titles.join("||");
  }
  async function waitForCardsToChange(prevSignature) {
    const start = Date.now();
    let lastSig = prevSignature, lastChange = Date.now();
    while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS) {
      if (aborted) return false;
      await sleep(PAGE_RENDER_POLL_MS);
      const cards = findJobCards();
      const sig = cardSignature(cards);
      if (sig !== prevSignature) {
        if (sig === lastSig) { if (Date.now() - lastChange >= PAGE_QUIET_MS) return true; }
        else { lastSig = sig; lastChange = Date.now(); }
      }
    }
    return false;
  }
  async function waitForCardsToExist() {
    const start = Date.now();
    while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS) {
      if (aborted) return false;
      if (findJobCards().length > 0) return true;
      await sleep(PAGE_RENDER_POLL_MS);
    }
    return false;
  }
  async function waitForCardCountToGrow(prevCount) {
    const start = Date.now();
    while (Date.now() - start < APPEND_WAIT_TIMEOUT_MS) {
      if (aborted) return false;
      await sleep(PAGE_RENDER_POLL_MS);
      if (findJobCards().length > prevCount) return true;
    }
    return false;
  }

  async function scrapeCards(cards, currentPage, totalPages) {
    const rows = cards.map((c) => buildRowMeta(c));
    await send("PAGE_PROGRESS", {
      pageIndex: currentPage, totalPages, scrapedThisPage: 0, status: "running"
    });
    let completed = 0;
    await Promise.all(rows.map(async (row) => {
      if (aborted) return;
      if (row.job_posting_initial_url) {
        const r = await send("RESOLVE_URL", { url: row.job_posting_initial_url });
        if (r) {
          row.method = r.method || "";
          if (r.ok && isResolvedExternalUrl(r.finalUrl)) {
            row.url = r.finalUrl;
            row.status = "ok";
          } else {
            // Resolution failed (or returned an aggregator link) — never fall back
            // to the hiring.cafe URL. Leave url blank and flag it for review.
            row.url = "";
            row.status = "unresolved: " + (r.error || "no external url");
          }
        } else { row.status = "no response"; }
      }
      await send("JOB_SCRAPED", { row });
      completed += 1;
      if (completed % 4 === 0 || completed === rows.length) {
        await send("PAGE_PROGRESS", {
          pageIndex: currentPage, totalPages, scrapedThisPage: completed, status: "running"
        });
      }
    }));
  }

  // Hard safety cap so a misbehaving "next" control can never scrape forever.
  const MAX_PAGINATION_PAGES = 100;
  async function runPagination(options) {
    const seen = new Set();          // job keys captured this run (cross-page dedup)
    let page = 0;                    // how many pages we've visited (1-based once inside)
    let totalPages = getTotalPages(findPagination()); // e.g. 3 — reliable (max numbered btn)
    let emptyStreak = 0;             // consecutive pages that produced no new jobs
    while (!aborted && page < MAX_PAGINATION_PAGES) {
      page += 1;
      // Make sure cards for this page have actually rendered before scraping.
      await waitForCardsToExist();
      const allCards = findJobCards();
      const sigBefore = cardSignature(allCards);
      // Only scrape jobs we haven't already captured — a relevance reshuffle of
      // the same jobs (hiring.cafe does this) must not be re-scraped or recounted.
      const newCards = allCards.filter((c) => {
        const k = cardKey(c);
        if (!k) return true;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (newCards.length) { emptyStreak = 0; await scrapeCards(newCards, page, totalPages); }
      else emptyStreak += 1;
      if (aborted) break;
      // Keep totalPages current — the control may reveal more pages as we go.
      const tpNow = getTotalPages(findPagination());
      if (tpNow) totalPages = Math.max(totalPages || 0, tpNow);
      // PRIMARY stop: we've visited every numbered page. Driven by our own page
      // counter (one click per loop), NOT the flaky "current page" heuristic that
      // was stopping a page early.
      if (totalPages && page >= totalPages) return;
      // SAFETY stop: several pages in a row yielded nothing new (true end of list,
      // or a control that only reshuffles). Higher threshold so a single
      // overlap-heavy page can't end the run prematurely.
      if (emptyStreak >= 3) return;
      let nextEl = null;
      if (options.paginationSpec) nextEl = findByElementSpec(options.paginationSpec);
      if (!nextEl) nextEl = autoDetectNextButton(findPagination());
      if (!nextEl) return;            // no next control -> last page reached
      clickAt(nextEl);
      await sleep(POST_CLICK_GRACE_MS);
      // Wait for the page to turn over. Even if this times out (slow page 3), we
      // do NOT bail — the next loop re-reads cards and dedup handles any overlap.
      await waitForCardsToChange(sigBefore);
    }
  }

  async function runLoadMore(options) {
    if (!options.paginationSpec) {
      await send("SCRAPE_DONE", { error: "No Load More element selected. Use the Pagination picker." });
      return;
    }
    const seenUrls = new Set();
    let pageIndex = 0, noGrowth = 0;
    while (!aborted) {
      pageIndex += 1;
      const cards = findJobCards();
      const newCards = cards.filter((c) => {
        const a = getJobPostingAnchor(c);
        const k = a ? a.href : "";
        if (k && seenUrls.has(k)) return false;
        if (k) seenUrls.add(k);
        return true;
      });
      await send("PAGE_PROGRESS", { pageIndex, totalPages: null, scrapedThisPage: 0, status: "running" });
      await scrapeCards(newCards, pageIndex, null);
      if (aborted) break;
      const before = findJobCards().length;
      const btn = findByElementSpec(options.paginationSpec);
      if (!btn) { await send("SCRAPE_DONE", {}); return; }
      clickAt(btn);
      await sleep(POST_CLICK_GRACE_MS);
      const grew = await waitForCardCountToGrow(before);
      if (!grew) {
        noGrowth += 1;
        if (noGrowth >= APPEND_NO_GROWTH_TRIES) { await send("SCRAPE_DONE", {}); return; }
      } else noGrowth = 0;
    }
  }

  async function runAutoScroll() {
    const seenUrls = new Set();
    let pageIndex = 0, noGrowth = 0;
    while (!aborted) {
      pageIndex += 1;
      const cards = findJobCards();
      const newCards = cards.filter((c) => {
        const a = getJobPostingAnchor(c);
        const k = a ? a.href : "";
        if (k && seenUrls.has(k)) return false;
        if (k) seenUrls.add(k);
        return true;
      });
      await send("PAGE_PROGRESS", { pageIndex, totalPages: null, scrapedThisPage: 0, status: "running" });
      await scrapeCards(newCards, pageIndex, null);
      if (aborted) break;
      const before = findJobCards().length;
      window.scrollBy({ top: SCROLL_STEP_PX, behavior: "auto" });
      await sleep(SCROLL_PAUSE_MS);
      if (findJobCards().length === before) {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
        await sleep(SCROLL_PAUSE_MS);
      }
      const grew = await waitForCardCountToGrow(before);
      if (!grew) {
        noGrowth += 1;
        if (noGrowth >= APPEND_NO_GROWTH_TRIES) { await send("SCRAPE_DONE", {}); return; }
      } else noGrowth = 0;
    }
  }

  
// ===================== eurotoptech.com adapter =====================
// eurotoptech renders MUI job cards; clicking a card opens a [role="dialog"]
// modal whose "Apply Now" anchor href is already the final destination URL.
// We iterate cards on each page, open each modal, read fields + apply URL,
// close it, then advance via the MUI pagination "Go to next page" button.
const ETT_OPEN_DIALOG_TIMEOUT_MS = 6000;
const ETT_CLOSE_DIALOG_TIMEOUT_MS = 4000;
const ETT_PAGE_CHANGE_TIMEOUT_MS = 10000;
const ETT_BETWEEN_CARDS_MS = 120;

function ettIsTarget() {
  return /(^|\.)eurotoptech\.com$/i.test(location.hostname);
}
function ettGetCards(columnSpec) {
  // If the user picked a "Jobs Column" element, scope scraping to that element's
  // grid/container so only the list they pointed at is scraped.
  if (columnSpec) {
    const picked = findByElementSpec(columnSpec);
    if (picked) {
      // Always resolve to the GRID the picked element belongs to, so locking a
      // single card still scrapes that whole list/group (never just one card).
      const card = picked.closest(".MuiCard-root");
      const grid = (card && card.closest(".MuiGrid-container"))
                 || picked.closest(".MuiGrid-container")
                 || (picked.querySelector && picked.querySelector(".MuiCard-root") ? picked : null);
      if (grid) {
        const within = Array.from(grid.querySelectorAll(".MuiCard-root")).filter(isVisible);
        if (within.length) return within;
      }
    }
    // Picked element isn't tied to a card grid -> fall through to all visible cards.
  }
  // Default: scope to the grid that follows the "Showing N jobs sorted by ..."
  // header — i.e. the main Posted-Date list the user is looking at — NOT every
  // grid (there is a separate secondary/"Remote Tech Jobs" grid on the page).
  const mainGrid = ettMainJobsGrid();
  if (mainGrid) {
    const within = Array.from(mainGrid.querySelectorAll(".MuiCard-root")).filter(isVisible);
    if (within.length) return within;
  }
  // Last resort: all visible cards across all grids.
  const all = [];
  document.querySelectorAll(".MuiGrid-container").forEach(
    (g) => g.querySelectorAll(".MuiCard-root").forEach((c) => all.push(c))
  );
  const cards = all.length ? all : Array.from(document.querySelectorAll(".MuiCard-root"));
  return Array.from(new Set(cards)).filter(isVisible);
}
// The main jobs grid = the first .MuiGrid-container that appears AFTER the
// "Showing N jobs sorted by ..." header in document order. This isolates the
// Posted-Date list and excludes the separate Remote/secondary grid.
function ettMainJobsGrid() {
  const leaves = Array.from(document.querySelectorAll("p, span, div")).filter((e) => e.children.length === 0);
  const header = leaves.find((e) => /Showing\s[\d,]+\sjobs\ssorted/i.test(visibleText(e)));
  if (!header) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let passed = false, cur;
  while ((cur = walker.nextNode())) {
    if (cur === header) passed = true;
    else if (passed && cur.classList && cur.classList.contains("MuiGrid-container")) return cur;
  }
  return null;
}
function ettGetDialog() {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return null;
  const apply = Array.from(dlg.querySelectorAll("a")).find((a) => /apply now/i.test(visibleText(a)));
  return apply ? dlg : null;
}
async function ettWaitDialog() {
  const start = Date.now();
  while (Date.now() - start < ETT_OPEN_DIALOG_TIMEOUT_MS) {
    if (aborted) return null;
    const dlg = ettGetDialog();
    if (dlg) return dlg;
    await sleep(50);
  }
  return null;
}
function ettCloseDialog() {
  const dlg = document.querySelector('[role="dialog"]');
  if (!dlg) return;
  const btn = dlg.querySelector('button[aria-label="Close job details"]') ||
              Array.from(dlg.querySelectorAll("button")).find((b) => /^close$/i.test(visibleText(b)));
  if (btn) clickAt(btn);
}
async function ettWaitNoDialog() {
  const start = Date.now();
  while (Date.now() - start < ETT_CLOSE_DIALOG_TIMEOUT_MS) {
    if (!document.querySelector('[role="dialog"]')) return true;
    await sleep(50);
  }
  return false;
}
function ettFieldByLabel(dlg, label) {
  const leaves = Array.from(dlg.querySelectorAll("*")).filter((e) => e.children.length === 0);
  for (let i = 0; i < leaves.length; i++) {
    if (visibleText(leaves[i]).toLowerCase() === label.toLowerCase()) {
      for (let j = i + 1; j < Math.min(i + 6, leaves.length); j++) {
        const v = visibleText(leaves[j]);
        if (v && v.toLowerCase() !== label.toLowerCase()) return v;
      }
    }
  }
  return "";
}
function ettCompany(dlg) {
  const chip = dlg.querySelector(".MuiChip-label");
  return chip ? visibleText(chip) : "";
}
function ettTitle(dlg) {
  const h5 = dlg.querySelector("h1.MuiTypography-h5, h2.MuiTypography-h5, h3.MuiTypography-h5, .MuiTypography-h5");
  if (h5) return visibleText(h5);
  const h = dlg.querySelector("h1, h2, h3, h4");
  return h ? visibleText(h) : "";
}
function ettDescription(dlg) {
  const leaves = Array.from(dlg.querySelectorAll("p, span, div")).filter((e) => e.children.length <= 1);
  let best = "";
  for (const el of leaves) {
    const t = visibleText(el);
    if (t.length > best.length && !/Job Description|Apply Now|Report expired|Track/i.test(t)) best = t;
  }
  return best;
}
function ettBuildRow(dlg) {
  const apply = Array.from(dlg.querySelectorAll("a")).find((a) => /apply now/i.test(visibleText(a)));
  const applyUrl = apply ? apply.href : "";
  return {
    url: applyUrl,
    title: ettTitle(dlg),
    company: ettCompany(dlg),
    location: ettFieldByLabel(dlg, "Location"),
    salary: ettFieldByLabel(dlg, "Total Compensation"),
    work_mode: ettFieldByLabel(dlg, "Workplace Type"),
    commitment: "",
    yoe: ettFieldByLabel(dlg, "Seniority"),
    posted_age: ettFieldByLabel(dlg, "Posted Date"),
    description: ettDescription(dlg),
    skills: ettFieldByLabel(dlg, "Yearly Savings"),
    job_posting_initial_url: applyUrl,
    hiringcafe_viewall_url: location.href,
    status: applyUrl ? "ok" : "no apply url found",
    method: "apply-now-href",
    scraped_at: new Date().toISOString()
  };
}
function ettGetPagination() {
  return {
    next: document.querySelector('button[aria-label="Go to next page"]'),
    current: (() => {
      const c = document.querySelector('button[aria-current="true"], button[aria-current="page"]');
      const n = c ? parseInt(visibleText(c), 10) : null;
      return Number.isFinite(n) ? n : null;
    })(),
    total: (() => {
      let max = null;
      for (const b of document.querySelectorAll('button[aria-label^="Go to page"], button[aria-label^="page"]')) {
        const m = (b.getAttribute("aria-label") || "").match(/(\d+)/);
        if (m) { const n = parseInt(m[1], 10); if (max == null || n > max) max = n; }
      }
      return max;
    })()
  };
}
async function ettWaitForCardChange(prevFirstTitle, columnSpec) {
  const start = Date.now();
  while (Date.now() - start < ETT_PAGE_CHANGE_TIMEOUT_MS) {
    if (aborted) return false;
    await sleep(150);
    const cards = ettGetCards(columnSpec);
    const first = cards[0];
    const t = first ? visibleText(first.querySelector("h1,h2,h3,h4") || first) : "";
    if (t && t !== prevFirstTitle) return true;
  }
  return false;
}
async function ettScrapePage(pageIndex, totalPages, columnSpec) {
  const cards = ettGetCards(columnSpec);
  await send("PAGE_PROGRESS", { pageIndex, totalPages, scrapedThisPage: 0, status: "running" });
  let completed = 0;
  for (let i = 0; i < cards.length; i++) {
    if (aborted) return;
    const card = cards[i];
    try { card.scrollIntoView({ block: "center", behavior: "auto" }); } catch (_) {}
    const clickTarget = card.querySelector(".MuiCardActionArea-root") || card;
    clickAt(clickTarget);
    const dlg = await ettWaitDialog();
    if (dlg) {
      const row = ettBuildRow(dlg);
      await send("JOB_SCRAPED", { row });
      ettCloseDialog();
      await ettWaitNoDialog();
    } else {
      await send("JOB_SCRAPED", { row: {
        url: "", title: visibleText(card.querySelector("h1,h2,h3,h4") || card), company: "",
        location: "", salary: "", work_mode: "", commitment: "", yoe: "", posted_age: "",
        description: "", skills: "", job_posting_initial_url: "", hiringcafe_viewall_url: location.href,
        status: "error: dialog did not open", method: "apply-now-href", scraped_at: new Date().toISOString()
      }});
    }
    completed += 1;
    if (completed % 4 === 0 || completed === cards.length) {
      await send("PAGE_PROGRESS", { pageIndex, totalPages, scrapedThisPage: completed, status: "running" });
    }
    await sleep(ETT_BETWEEN_CARDS_MS);
  }
}
async function ettRun(options) {
  options = options || {};
  const columnSpec = options.columnSpec || null;
  aborted = false;
  if (!ettGetCards(columnSpec).length) {
    // wait briefly for cards to render
    const start = Date.now();
    while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS && !ettGetCards(columnSpec).length) await sleep(150);
  }
  if (!ettGetCards(columnSpec).length) { await send("SCRAPE_DONE", { error: "No job cards found on eurotoptech page." }); return; }
  let guard = 0;
  while (!aborted) {
    guard += 1;
    const pag = ettGetPagination();
    const pageIndex = pag.current ?? guard;
    const totalPages = pag.total;
    const cards = ettGetCards(columnSpec);
    const prevFirstTitle = cards[0] ? visibleText(cards[0].querySelector("h1,h2,h3,h4") || cards[0]) : "";
    await ettScrapePage(pageIndex, totalPages, columnSpec);
    if (aborted) break;
    // Honor a picked pagination button (e.g. you pointed at "Next"/"›") before
    // falling back to the auto-detected "Go to next page" control.
    let next = options.paginationSpec ? findByElementSpec(options.paginationSpec) : null;
    if (!next) next = ettGetPagination().next;
    if (!next || next.disabled || next.getAttribute("aria-disabled") === "true") break;
    clickAt(next);
    await sleep(POST_CLICK_GRACE_MS);
    const changed = await ettWaitForCardChange(prevFirstTitle, columnSpec);
    if (!changed) break;
  }
  await send("SCRAPE_DONE", aborted ? { error: "stopped by user" } : {});
}
// =================== end eurotoptech.com adapter ===================

// ===================== simplify.jobs adapter =====================
// simplify.jobs renders job cards as <button data-testid="job-card">, but the
// job UUID + fields live ONLY in each card's React fiber, which this isolated
// content script can't read. So sj-main.js (a MAIN-world content script) reads
// the fibers and returns serialized rows over postMessage. The external ATS URL
// is reachable via https://simplify.jobs/jobs/click/{id}, which background.js
// follows in a tab and strips of Simplify tracking. The list is infinite-scroll
// inside an inner overflow container (NOT window).
const SJ_SCROLL_PAUSE_MS = 900;
const SJ_NO_GROWTH_TRIES = 5;

function sjIsTarget() {
  return /(^|\.)simplify\.jobs$/i.test(location.hostname);
}
function sjGetCardButtons() {
  return Array.from(document.querySelectorAll('[data-testid="job-card"]'))
    .map((c) => c.closest("button") || c)
    .filter(isVisible);
}
function sjRequestRows() {
  return new Promise((resolve) => {
    const nonce = Date.now() + ":" + Math.random();
    function onMsg(e) {
      if (e.source !== window || !e.data || e.data.__sjRes !== nonce) return;
      window.removeEventListener("message", onMsg);
      resolve(Array.isArray(e.data.rows) ? e.data.rows : []);
    }
    window.addEventListener("message", onMsg);
    window.postMessage({ __sjReq: nonce }, "*");
    setTimeout(() => { window.removeEventListener("message", onMsg); resolve([]); }, 3000);
  });
}
function sjCurrencySym(c) { return c === "USD" ? "$" : c === "GBP" ? "£" : c === "EUR" ? "€" : (c ? c + " " : ""); }
function sjSalary(r) {
  if (!r.min_salary && !r.max_salary) return "";
  const sym = sjCurrencySym(r.currency_type);
  const fmt = (n) => sym + Number(n).toLocaleString("en-US");
  let s = (r.min_salary && r.max_salary) ? (fmt(r.min_salary) + " - " + fmt(r.max_salary)) : fmt(r.min_salary || r.max_salary);
  if (r.salary_period === 4) s += " /yr";
  return s;
}
function sjBuildRow(r) {
  const id = r.id || "";
  const clickUrl = id ? ("https://simplify.jobs/jobs/click/" + id) : "";
  return {
    url: "",
    title: r.title || "",
    company: r.company || "",
    location: (r.locations || []).filter(Boolean).join(" | "),
    salary: sjSalary(r),
    work_mode: r.travel || "",
    commitment: r.type || "",
    yoe: (r.experience || []).filter(Boolean).join(" | "),
    posted_age: "",
    description: (r.functions || []).filter(Boolean).join(" | "),
    skills: (r.majors || []).filter(Boolean).join(" | "),
    job_posting_initial_url: clickUrl,
    hiringcafe_viewall_url: id ? (location.origin + "/jobs?jobId=" + id) : location.href,
    status: clickUrl ? "pending" : "no job posting url on card",
    method: "",
    scraped_at: new Date().toISOString()
  };
}
function sjGetScroller() {
  return Array.from(document.querySelectorAll("*")).find(
    (el) => el.scrollHeight > el.clientHeight + 20
      && el.querySelector && el.querySelector('[data-testid="job-card"]')
      && /overflow-y-auto/.test((el.className || "").toString())
  ) || null;
}
function sjScrollToLoadMore() {
  const scroller = sjGetScroller();
  const cards = sjGetCardButtons();
  const last = cards[cards.length - 1];
  try { if (last) last.scrollIntoView({ block: "end" }); } catch (_) {}
  if (scroller) {
    scroller.scrollTop = scroller.scrollHeight;
    try { scroller.dispatchEvent(new Event("scroll", { bubbles: true })); } catch (_) {}
    try { scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 1000, bubbles: true })); } catch (_) {}
  } else {
    window.scrollTo({ top: document.documentElement.scrollHeight });
    window.dispatchEvent(new Event("scroll", { bubbles: true }));
  }
}
async function sjRun() {
  aborted = false;
  const start = Date.now();
  while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS && !sjGetCardButtons().length) await sleep(150);
  if (!sjGetCardButtons().length) { await send("SCRAPE_DONE", { error: "No job cards found on simplify.jobs." }); return; }

  const seen = new Set();
  let pageIndex = 0, noGrowth = 0;
  while (!aborted) {
    pageIndex += 1;
    const rawRows = await sjRequestRows();
    const newRows = [];
    for (const r of rawRows) {
      if (r.id && seen.has(r.id)) continue;
      if (r.id) seen.add(r.id);
      newRows.push(sjBuildRow(r));
    }
    await send("PAGE_PROGRESS", { pageIndex, totalPages: null, scrapedThisPage: 0, status: "running" });
    let completed = 0;
    await Promise.all(newRows.map(async (row) => {
      if (aborted) return;
      if (row.job_posting_initial_url) {
        const resp = await send("RESOLVE_URL", { url: row.job_posting_initial_url });
        if (resp) {
          row.method = resp.method || "";
          if (resp.ok && isResolvedExternalUrl(resp.finalUrl)) {
            row.url = resp.finalUrl;
            row.status = "ok";
          } else {
            row.url = "";
            row.status = "unresolved: " + (resp.error || "no external url");
          }
        } else row.status = "no response";
      }
      await send("JOB_SCRAPED", { row });
      completed += 1;
      if (completed % 4 === 0 || completed === newRows.length)
        await send("PAGE_PROGRESS", { pageIndex, totalPages: null, scrapedThisPage: completed, status: "running" });
    }));
    if (aborted) break;

    const before = sjGetCardButtons().length;
    sjScrollToLoadMore();
    await sleep(SJ_SCROLL_PAUSE_MS);

    if (sjGetCardButtons().length <= before) {
      noGrowth += 1;
      if (noGrowth >= SJ_NO_GROWTH_TRIES) { await send("SCRAPE_DONE", {}); return; }
    } else noGrowth = 0;
  }
  await send("SCRAPE_DONE", aborted ? { error: "stopped by user" } : {});
}
// =================== end simplify.jobs adapter ===================

//                       careerhound.io adapter                       
// careerhound.io renders job listings as a responsive grid of cards. Each card
// is a <div class="[content-visibility:auto] ..."> that contains an <a target=
// "_blank"> whose href is ALREADY the final external employer / ATS URL (Oracle
// Cloud, Comeet, BambooHR, Taleo, Greenhouse, gov.uk, ...) — no redirect needs
// resolving. All fields (title, company, work mode, commitment, salary,
// posted age, description) are visible directly on the card, so we read them in
// place without opening any detail view. Pagination is a classic Prev/Next pager
// with a button[aria-label="Next page"]; cards fully replace on each page.
function chIsTarget() {
  return /(^|\.)careerhound\.io$/i.test(location.hostname);
}
const CH_MODE_VALUES = new Set(["on-site", "onsite", "remote", "hybrid", "in-person", "in person", "field"]);
const CH_COMMIT_VALUES = new Set(["full time", "part time", "contract", "internship", "temporary", "full-time", "part-time"]);
const CH_SALARY_RE = /[\u20ac\u00a3$]\s?\d/;
const CH_AGE_RE = /^\d+\s*[smhdw]$/i;
function chGetCards() {
  return Array.from(document.querySelectorAll('div.\\[content-visibility\\:auto\\]'))
    // Accept any card carrying a link — not only target="_blank" — so a card
    // whose Apply control renders differently is still picked up.
    .filter((c) => c.querySelector('a[href]'))
    .filter(isVisible);
}
function chCardTitle(card) {
  const h = card.querySelector("h1,h2,h3,h4,h5,h6");
  if (h) return visibleText(h);
  const links = Array.from(card.querySelectorAll('a[href]'));
  const nonApply = links.find((a) => {
    const t = visibleText(a);
    return t && !/^apply\b/i.test(t) && !/more from this company/i.test(t);
  });
  return nonApply ? visibleText(nonApply) : "";
}
function chCardCompany(card, title) {
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  const texts = [];
  let n;
  while ((n = walker.nextNode())) {
    const v = (n.textContent || "").replace(/\s+/g, " ").trim();
    if (v) texts.push(v);
  }
  let ti = texts.findIndex((t) => t === title || (title && title.startsWith(t)));
  if (ti < 0) ti = 0;
  for (let i = ti + 1; i < texts.length; i++) {
    const t = texts[i], lc = t.toLowerCase();
    if (CH_MODE_VALUES.has(lc) || CH_COMMIT_VALUES.has(lc) || CH_SALARY_RE.test(t) ||
        CH_AGE_RE.test(t) || /^apply$/i.test(t) || /more from this company/i.test(t)) continue;
    return t;
  }
  return "";
}
function chCardDescription(card) {
  const leaves = Array.from(card.querySelectorAll("p, div, span")).filter((e) => e.children.length <= 1);
  let best = "";
  for (const el of leaves) {
    const t = visibleText(el);
    if (t.length > best.length && !/more from this company/i.test(t)) best = t;
  }
  return best;
}
// The job URL lives on the card's "Apply" control. Resolve it defensively:
// never return an internal careerhound.io link (e.g. "More from this company"),
// because the exported Job URL column must only ever hold the external ATS URL.
function chApplyUrl(card) {
  const isExternal = (a) => {
    if (!a || !a.href || !/^https?:/i.test(a.href)) return false;
    try { return !/(^|\.)careerhound\.io$/i.test(new URL(a.href).host); }
    catch (_) { return false; }
  };
  const anchors = Array.from(card.querySelectorAll("a"));
  // 1) The anchor labelled "Apply" (tolerates "Apply now", trailing icon text).
  const apply = anchors.find((a) => /^apply\b/i.test(visibleText(a)) && isExternal(a));
  if (apply) return apply.href;
  // 2) Any other external anchor, skipping the internal "More from this company".
  const ext = anchors.find((a) => isExternal(a) && !/more from this company/i.test(visibleText(a)));
  if (ext) return ext.href;
  // 3) Apply rendered as a <button> — check common data-* attributes.
  for (const b of card.querySelectorAll("button, [role='button']")) {
    if (!/^apply\b/i.test(visibleText(b))) continue;
    for (const k of ["data-url", "data-href", "data-apply-url", "data-link"]) {
      const v = b.getAttribute(k);
      if (v && /^https?:/i.test(v)) {
        try { if (!/(^|\.)careerhound\.io$/i.test(new URL(v).host)) return v; } catch (_) {}
      }
    }
  }
  return "";
}
function chBuildRow(card) {
  const url = chApplyUrl(card);
  const title = chCardTitle(card);
  const chips = Array.from(card.querySelectorAll("span, div, button")).map(visibleText).filter(Boolean);
  let work_mode = "", commitment = "", salary = "", posted_age = "";
  for (const c of chips) {
    const lc = c.toLowerCase();
    if (!work_mode && CH_MODE_VALUES.has(lc)) work_mode = c;
    else if (!commitment && CH_COMMIT_VALUES.has(lc)) commitment = c;
    else if (!salary && CH_SALARY_RE.test(c) && c.length < 40) salary = c;
    else if (!posted_age && CH_AGE_RE.test(c)) posted_age = c;
  }
  return {
    url: url,
    title: title,
    company: chCardCompany(card, title),
    location: "",
    salary: salary,
    work_mode: work_mode,
    commitment: commitment,
    yoe: "",
    posted_age: posted_age,
    description: chCardDescription(card),
    skills: "",
    job_posting_initial_url: url,
    hiringcafe_viewall_url: location.href,
    status: url ? "ok" : "no apply url found",
    method: "apply-href",
    scraped_at: new Date().toISOString()
  };
}
function chGetPagination() {
  return {
    next: document.querySelector('button[aria-label="Next page"], a[aria-label="Next page"]'),
    current: (() => {
      const nodes = Array.from(document.querySelectorAll("*"));
      const p = nodes.find((e) => /^Page\s+\d+$/.test(visibleText(e)) && e.children.length === 0);
      const m = p ? visibleText(p).match(/(\d+)/) : null;
      return m ? parseInt(m[1], 10) : null;
    })(),
    total: null
  };
}
async function chWaitForCardChange(prevFirstTitle) {
  const start = Date.now();
  while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS) {
    if (aborted) return false;
    await sleep(150);
    const cards = chGetCards();
    const first = cards[0];
    const t = first ? chCardTitle(first) : "";
    if (t && t !== prevFirstTitle) return true;
  }
  return false;
}
async function chScrapePage(pageIndex, totalPages) {
  const cards = chGetCards();
  await send("PAGE_PROGRESS", { pageIndex, totalPages, scrapedThisPage: 0, status: "running" });
  let completed = 0;
  for (let i = 0; i < cards.length; i++) {
    if (aborted) return;
    const card = cards[i];
    try { card.scrollIntoView({ block: "center", behavior: "auto" }); } catch (_) {}
    const row = chBuildRow(card);
    await send("JOB_SCRAPED", { row });
    completed += 1;
    if (completed % 4 === 0 || completed === cards.length)
      await send("PAGE_PROGRESS", { pageIndex, totalPages, scrapedThisPage: completed, status: "running" });
  }
}
async function chRun(options) {
  options = options || {};
  aborted = false;
  if (!chGetCards().length) {
    const start = Date.now();
    while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS && !chGetCards().length) await sleep(150);
  }
  if (!chGetCards().length) { await send("SCRAPE_DONE", { error: "No job cards found on careerhound.io page." }); return; }
  let guard = 0;
  while (!aborted) {
    guard += 1;
    const pag = chGetPagination();
    const pageIndex = pag.current || guard;
    const cards = chGetCards();
    const prevFirstTitle = cards[0] ? chCardTitle(cards[0]) : "";
    await chScrapePage(pageIndex, pag.total);
    if (aborted) break;
    let next = options.paginationSpec ? findByElementSpec(options.paginationSpec) : null;
    if (!next) next = chGetPagination().next;
    if (!next || next.disabled || next.getAttribute("aria-disabled") === "true") break;
    clickAt(next);
    await sleep(POST_CLICK_GRACE_MS);
    const changed = await chWaitForCardChange(prevFirstTitle);
    if (!changed) break;
  }
  await send("SCRAPE_DONE", aborted ? { error: "stopped by user" } : {});
}
//                     end careerhound.io adapter                     

// ===================== jobright.ai adapter =====================
// jobright.ai/jobs/recommend is a React SPA: an infinite-scrolling list of job
// cards, each exposing "APPLY WITH AUTOFILL" and/or "APPLY NOW". The employer
// ATS URL sits on those controls, so we anchor on the CONTROL rather than any
// CSS class (class names here are hashed and change between builds). Two shapes
// are handled: the control is an <a href> (read directly), or it is a <button>
// carrying the URL in a data-* attribute. Internal jobright.ai links are never
// returned, so the exported Job URL column only ever holds an external link.
function jrIsTarget() {
  return /(^|\.)jobright\.ai$/i.test(location.hostname);
}
const JR_APPLY_RE = /\b(apply\s+with\s+autofill|apply\s+now|autofill|apply)\b/i;
const JR_SKIP_RE = /(save|hide|not interested|report|more from|similar|feedback|upgrade|sign in|log in)/i;
function jrIsExternalUrl(u) {
  if (!u || !/^https?:\/\//i.test(u)) return false;
  try { return !/(^|\.)jobright\.ai$/i.test(new URL(u, location.href).host); }
  catch (_) { return false; }
}
// Pull an apply URL out of a scope (a card, or the detail pane).
function jrApplyUrl(scope) {
  if (!scope) return "";
  const controls = Array.from(scope.querySelectorAll('a, button, [role="button"]'));
  const applyish = controls.filter((el) => {
    const t = visibleText(el);
    return t && JR_APPLY_RE.test(t) && !JR_SKIP_RE.test(t);
  });
  // 1) Apply control that is itself a link.
  for (const el of applyish) {
    if (el.tagName === "A" && jrIsExternalUrl(el.href)) return el.href;
  }
  // 2) Apply control carrying the URL in a data-* attribute.
  for (const el of applyish) {
    for (const k of ["data-url", "data-href", "data-apply-url", "data-link", "data-external-url", "href"]) {
      const v = el.getAttribute && el.getAttribute(k);
      if (v && jrIsExternalUrl(v)) return v;
    }
  }
  // 3) An apply control wrapping (or wrapped by) an external anchor.
  for (const el of applyish) {
    const inner = el.querySelector && el.querySelector("a[href]");
    if (inner && jrIsExternalUrl(inner.href)) return inner.href;
    const outer = el.closest && el.closest("a[href]");
    if (outer && jrIsExternalUrl(outer.href)) return outer.href;
  }
  // 4) Last resort: any external anchor inside the scope.
  const ext = Array.from(scope.querySelectorAll("a[href]"))
    .find((a) => jrIsExternalUrl(a.href) && !JR_SKIP_RE.test(visibleText(a)));
  return ext ? ext.href : "";
}
// Cards are derived by climbing from each apply control to the smallest
// ancestor that looks like a whole listing (enough text, not the entire page).
function jrGetCards() {
  const controls = Array.from(document.querySelectorAll('a, button, [role="button"]'))
    .filter((el) => {
      const t = visibleText(el);
      return t && JR_APPLY_RE.test(t) && !JR_SKIP_RE.test(t) && isVisible(el);
    });
  const cards = [];
  const seen = new Set();
  for (const ctl of controls) {
    let node = ctl.parentElement, card = null, safety = 0;
    while (node && node !== document.body && safety < 25) {
      const txt = visibleText(node);
      if (txt.length > 60 && node.querySelectorAll("a, button").length < 40) { card = node; break; }
      node = node.parentElement; safety += 1;
    }
    if (card && !seen.has(card)) { seen.add(card); cards.push(card); }
  }
  return cards;
}
function jrCardTitle(card) {
  const h = card.querySelector("h1,h2,h3,h4,h5,h6");
  if (h && visibleText(h)) return visibleText(h);
  let best = "", bestScore = 0;
  for (const el of card.querySelectorAll("*")) {
    if (el.children.length) continue;
    const t = visibleText(el);
    if (!t || t.length < 3 || t.length > 200) continue;
    if (JR_APPLY_RE.test(t) || JR_SKIP_RE.test(t)) continue;
    const cs = window.getComputedStyle(el);
    const score = (parseFloat(cs.fontSize) || 0) + ((parseInt(cs.fontWeight, 10) || 400) >= 600 ? 4 : 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best;
}
function jrCardCompany(card, title) {
  const img = card.querySelector("img[alt]");
  const alt = img && img.alt ? img.alt.trim() : "";
  if (alt && !/logo|icon|avatar|^$/i.test(alt)) return alt;
  for (const el of card.querySelectorAll("*")) {
    if (el.children.length) continue;
    const t = visibleText(el);
    if (!t || t === title || t.length > 80) continue;
    if (JR_APPLY_RE.test(t) || JR_SKIP_RE.test(t)) continue;
    if (/^\d+\s*[smhdw]$/i.test(t) || /[€£$]\s?\d/.test(t)) continue;
    return t;
  }
  return "";
}
function jrBuildRow(card) {
  const url = jrApplyUrl(card);
  const title = jrCardTitle(card);
  const chips = Array.from(card.querySelectorAll("span, div, button")).map(visibleText).filter(Boolean);
  let work_mode = "", commitment = "", salary = "", posted_age = "";
  for (const c of chips) {
    const lc = c.toLowerCase();
    if (!work_mode && CH_MODE_VALUES.has(lc)) work_mode = c;
    else if (!commitment && CH_COMMIT_VALUES.has(lc)) commitment = c;
    else if (!salary && CH_SALARY_RE.test(c) && c.length < 40) salary = c;
    else if (!posted_age && CH_AGE_RE.test(c)) posted_age = c;
  }
  return {
    url: url,
    title: title,
    company: jrCardCompany(card, title),
    location: "",
    salary: salary,
    work_mode: work_mode,
    commitment: commitment,
    yoe: "",
    posted_age: posted_age,
    description: "",
    skills: "",
    job_posting_initial_url: url,
    hiringcafe_viewall_url: location.href,
    status: url ? "ok" : "no apply url found on card",
    method: "jobright-apply-href",
    scraped_at: new Date().toISOString()
  };
}
// The recommend feed is infinite scroll: scrape what's rendered, scroll, repeat
// until no new cards appear. Dedupe by URL (falling back to title|company) so a
// re-render can't produce duplicate rows or an endless loop.
async function jrRun(options) {
  options = options || {};
  aborted = false;
  const start = Date.now();
  while (Date.now() - start < PAGE_RENDER_TIMEOUT_MS && !jrGetCards().length) await sleep(150);
  if (!jrGetCards().length) {
    await send("SCRAPE_DONE", { error: 'No job cards found on jobright.ai — make sure the job list with "Apply now" / "Apply with autofill" buttons is visible.' });
    return;
  }
  const seen = new Set();
  let pageIndex = 0, noGrowth = 0, total = 0;
  while (!aborted) {
    pageIndex += 1;
    const cards = jrGetCards();
    let newThisPass = 0;
    for (const card of cards) {
      if (aborted) break;
      const row = jrBuildRow(card);
      const key = row.url || (row.title + "|" + row.company);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try { card.scrollIntoView({ block: "center", behavior: "auto" }); } catch (_) {}
      await send("JOB_SCRAPED", { row });
      newThisPass += 1; total += 1;
      if (total % 4 === 0)
        await send("PAGE_PROGRESS", { pageIndex, totalPages: null, scrapedThisPage: total, status: "running" });
    }
    await send("PAGE_PROGRESS", { pageIndex, totalPages: null, scrapedThisPage: total, status: "running" });
    if (aborted) break;
    if (newThisPass === 0) {
      noGrowth += 1;
      if (noGrowth >= APPEND_NO_GROWTH_TRIES) break;
    } else noGrowth = 0;
    const before = jrGetCards().length;
    window.scrollBy({ top: SCROLL_STEP_PX, behavior: "auto" });
    await sleep(SCROLL_PAUSE_MS);
    if (jrGetCards().length === before) {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
      await sleep(SCROLL_PAUSE_MS);
    }
  }
  await send("SCRAPE_DONE", aborted ? { error: "stopped by user" } : {});
}
//                     end jobright.ai adapter

async function runScrape(options) {
  if (jrIsTarget()) { return jrRun(options); }
  if (chIsTarget()) { return chRun(options); }
  if (sjIsTarget()) { return sjRun(options); }
  if (ettIsTarget()) { return ettRun(options); }
    aborted = false;
    if (!(await waitForCardsToExist())) {
      await send("SCRAPE_DONE", { error: "No job cards found on this page." });
      return;
    }
    const strategy = (options && options.strategy) || "pagination";
    try {
      if (strategy === "loadmore") await runLoadMore(options);
      else if (strategy === "autoscroll") await runAutoScroll(options);
      else await runPagination(options);
    } catch (e) {
      await send("SCRAPE_DONE", { error: e?.message || String(e) });
      return;
    }
    if (aborted) await send("SCRAPE_DONE", { error: "stopped by user" });
    else await send("SCRAPE_DONE", {});
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "BEGIN_SCRAPE") {
      runScrape(msg.options || {}).catch((e) => send("SCRAPE_DONE", { error: e?.message || String(e) }));
      sendResponse({ ok: true }); return;
    }
    if (msg.type === "ABORT_SCRAPE") { aborted = true; sendResponse({ ok: true }); return; }
    if (msg.type === "START_PICKER") { startPicker(msg.mode); sendResponse({ ok: true }); return; }
    if (msg.type === "STOP_PICKER")  { stopPicker();  sendResponse({ ok: true }); return; }
    if (msg.type === "PING") { sendResponse({ ok: true }); return; }
  });
})();

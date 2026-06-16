// content.js — hiring.cafe + eurotoptech.com + simplify.jobs
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
          if (r.ok) {
            row.url = r.finalUrl || row.job_posting_initial_url;
            row.status = "ok";
            row.method = r.method || "";
          } else {
            row.url = r.finalUrl || row.job_posting_initial_url;
            row.status = "error: " + (r.error || "unknown");
            row.method = r.method || "";
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

  async function runPagination(options) {
    let pageIndex = 0;
    while (!aborted) {
      pageIndex += 1;
      const paginationEl = findPagination();
      const totalPages = getTotalPages(paginationEl);
      const currentPage = getCurrentPageNumber(paginationEl) ?? pageIndex;
      const cardsBefore = findJobCards();
      const sigBefore = cardSignature(cardsBefore);
      await scrapeCards(cardsBefore, currentPage, totalPages);
      if (aborted) break;
      let nextEl = null;
      if (options.paginationSpec) nextEl = findByElementSpec(options.paginationSpec);
      if (!nextEl) nextEl = autoDetectNextButton(paginationEl);
      if (!nextEl) return;
      clickAt(nextEl);
      await sleep(POST_CLICK_GRACE_MS);
      const changed = await waitForCardsToChange(sigBefore);
      if (!changed) return;
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
          row.url = resp.finalUrl || row.job_posting_initial_url;
          row.status = resp.ok ? "ok" : ("error: " + (resp.error || "unknown"));
          row.method = resp.method || "";
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

async function runScrape(options) {
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

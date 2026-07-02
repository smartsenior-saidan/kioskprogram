// search.js — fuzzy Firestore search by first name, last name, family name.
//
// Firestore has no native fuzzy/full-text search, so for a single tenant's
// memorial directory we fetch the tenant-scoped person list and rank it
// client-side with a forgiving matcher (substring + token + Levenshtein).
// Results are cached for the session to keep typing snappy.

import {
  getDocs,
  tenantQuery,
  COLLECTIONS,
} from "./firebase.js";

// --- Result mode: family (browse the whole family) vs individual (go straight
// to that person's own profile) -----------------------------------------------

let searchMode = sessionStorage.getItem('kiosk_search_mode') || 'family';

// --- Fuzzy matching utilities ----------------------------------------------

/** Detect whether the string contains Japanese characters. */
function isJapanese(str) {
  return /[\u3040-\u30ff\u4e00-\u9fff\uf900-\ufaff]/.test(str);
}

/**
 * Normalize for matching.
 * - Latin input: lowercase, strip accents, collapse whitespace.
 * - Japanese input: collapse whitespace only (preserve kana/kanji).
 */
function normalize(str) {
  const s = (str || "").toString().trim();
  if (isJapanese(s)) {
    // Keep kanji/kana; remove full-width spaces and collapse whitespace
    return s.replace(/[\u3000\s]+/g, " ").trim();
  }
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Classic Levenshtein edit distance (iterative, O(n*m) space-optimized). */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Similarity 0..1 from edit distance, normalized by the longer string. */
function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * Score a person against a normalized query. Higher is better; 0 means no
 * match. Handles both Latin (fuzzy) and Japanese (substring) queries.
 */
function scorePerson(person, qTokens, qFull) {
  const first  = normalize(person.first_name);
  const last   = normalize(person.last_name);
  const family = normalize(person.family_name);
  // Support optional hiragana reading fields (e.g. name_kana, reading)
  const kana   = normalize(person.name_kana || person.reading || "");
  const full   = `${last} ${first}`.trim();
  const haystackTokens = [first, last, family, kana].filter(Boolean);

  const jp = isJapanese(qFull);
  let score = 0;

  if (jp) {
    // Japanese: substring-based matching (no fuzzy — kana are exact)
    const targets = [...haystackTokens, full, normalize(`${first} ${last}`)].filter(Boolean);
    for (const t of targets) {
      if (t === qFull)           score = Math.max(score, 10);
      else if (t.startsWith(qFull)) score = Math.max(score, 7);
      else if (t.includes(qFull))   score = Math.max(score, 4);
    }
    // Per-token bonus
    for (const qt of qTokens) {
      for (const ht of haystackTokens) {
        if (!ht) continue;
        if (ht === qt)           score += 4;
        else if (ht.startsWith(qt)) score += 2;
        else if (ht.includes(qt))   score += 1;
      }
    }
  } else {
    // Latin: existing fuzzy logic
    if (full) {
      if (full.includes(qFull)) score += 6;
      score += similarity(full, qFull) * 4;
    }
    for (const qt of qTokens) {
      let best = 0;
      for (const ht of haystackTokens) {
        if (!ht) continue;
        if (ht === qt)              best = Math.max(best, 5);
        else if (ht.startsWith(qt)) best = Math.max(best, 3.5);
        else if (ht.includes(qt))   best = Math.max(best, 2.5);
        else {
          const sim = similarity(ht, qt);
          if (sim >= 0.6) best = Math.max(best, sim * 3);
        }
      }
      score += best;
    }
  }

  return score;
}

// --- Data loading (session cache) ------------------------------------------

let _personCache = null;

/** Fetch all persons for the active tenant once, then reuse. */
export async function loadPersons(forceRefresh = false) {
  if (_personCache && !forceRefresh) return _personCache;

  const snap = await getDocs(tenantQuery(COLLECTIONS.persons));
  _personCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return _personCache;
}

// --- Public search API ------------------------------------------------------

/**
 * Fuzzy-search the tenant's persons.
 * @param {string} queryText raw user input
 * @param {object} [opts] { maxResults = 12 }
 * @returns {Promise<Array>} ranked person objects with a `_score` field
 */
export async function searchPersons(queryText, opts = {}) {
  const { maxResults = 12 } = opts;
  const qFull = normalize(queryText);

  if (!qFull) return [];

  const qTokens = qFull.split(" ").filter(Boolean);
  const persons = await loadPersons();

  return persons
    .map((p) => ({ ...p, _score: scorePerson(p, qTokens, qFull) }))
    .filter((p) => p._score > 1.2) // drop weak/no matches
    .sort((a, b) => b._score - a._score)
    .slice(0, maxResults);
}

// --- UI wiring (index.html) -------------------------------------------------

function renderResults(results, container) {
  container.innerHTML = "";

  if (!results.length) {
    const msg = '該当する方が見つかりませんでした。<br>別のお名前や姓のみでお試しください。';
    container.innerHTML = `<div class="results-empty">${msg}</div>`;
    return;
  }

  // Count summary
  const n = results.length;
  const summary = `${n}件の家族が見つかりました。`;
  container.innerHTML = `<p class="results-count">${summary}</p>`;

  for (const person of results) {
    const card = document.createElement("div");
    card.className = "family-card";

    const fullName = `${person.last_name || ''} ${person.first_name || ''}`.trim();
    const plotLabel  = '区画：';
    const detailBtn  = '詳細';
    const plotRow = person.plot ? `<span>${plotLabel}<strong>${person.plot}</strong></span>` : '';

    // Lead with the person's own name (not "<last name>家") — the row/column
    // (plot) underneath is enough context without grouping by family.
    card.innerHTML = `
      <div class="fc-name">${fullName}</div>
      <div class="fc-meta">
        ${plotRow}
      </div>
      <div class="fc-actions">
        <button class="fc-btn-detail">${detailBtn}</button>
      </div>`;

    card.querySelector('.fc-btn-detail').addEventListener('click', () => {
      sessionStorage.setItem('kiosk_person', person.id);
      const q = document.getElementById('searchInput');
      sessionStorage.setItem('kiosk_last_query', q?.value || '');
      const dest = searchMode === 'individual'
        ? `profile.html?person=${encodeURIComponent(person.id)}`
        : `family.html?person=${encodeURIComponent(person.id)}`;
      window.location.href = dest;
    });

    container.appendChild(card);
  }
}

/**
 * Attach live + submit search behavior to the search screen.
 * Expects #searchInput, #searchButton, #results in the DOM.
 */
export function initSearchScreen() {
  const input = document.getElementById("searchInput");
  const button = document.getElementById("searchButton");
  const results = document.getElementById("results");
  if (!input || !results) return;

  let debounce;
  const run = async () => {
    const text = input.value;
    if (!text.trim()) {
      results.innerHTML = "";
      return;
    }
    try {
      const matches = await searchPersons(text);
      renderResults(matches, results);
    } catch (err) {
      console.error("[search] failed:", err);
      results.innerHTML =
        '<div class="results-empty">現在検索を利用できません。</div>';
    }
  };

  // Live search while typing.
  input.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(run, 220);
  });

  // Explicit submit/search button.
  const submit = () => {
    clearTimeout(debounce);
    run();
  };
  if (button) button.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  // Warm the cache so the first keystroke is instant.
  loadPersons().catch((err) => console.warn("[search] preload failed:", err));
  input.focus();

  // Family vs individual result mode toggle.
  const modeButtons = document.querySelectorAll('#searchModeSwitcher [data-mode]');
  modeButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === searchMode);
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === searchMode) return;
      searchMode = btn.dataset.mode;
      sessionStorage.setItem('kiosk_search_mode', searchMode);
      modeButtons.forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
}

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
  // Hiragana reading fields, entered separately per name in the admin so
  // guests who don't know the kanji can still search (falls back to the
  // older combined name_kana/reading field for any legacy data).
  const firstKana = normalize(person.first_name_kana || "");
  const lastKana  = normalize(person.last_name_kana || "");
  const legacyKana = normalize(person.name_kana || person.reading || "");
  const full   = `${last} ${first}`.trim();
  const fullKana = `${lastKana} ${firstKana}`.trim();
  const haystackTokens = [first, last, firstKana, lastKana, legacyKana].filter(Boolean);

  const jp = isJapanese(qFull);
  let score = 0;

  if (jp) {
    // Japanese: prefix-based matching. Guests type from the start of a name
    // (surname first, per convention), so we require the query to be the
    // *start* of a name field rather than a substring anywhere inside it —
    // a bare "includes" check meant common single characters (e.g. a kana
    // that happens to appear mid-name) matched almost every profile.
    const targets = [
      ...haystackTokens, full, normalize(`${first} ${last}`),
      fullKana, normalize(`${firstKana} ${lastKana}`),
    ].filter(Boolean);
    for (const t of targets) {
      if (t === qFull)              score = Math.max(score, 10);
      else if (t.startsWith(qFull)) score = Math.max(score, 7);
    }
    // Per-token bonus. For multi-word queries (e.g. last + first name typed
    // separately), every token must match something on this person — otherwise
    // a query like "やまだ はな" would also match other 山田 family members
    // whose first name never matched the "はな" token at all.
    if (qTokens.length > 1) {
      let tokenScore = 0;
      let allTokensMatched = true;
      for (const qt of qTokens) {
        let best = 0;
        for (const ht of haystackTokens) {
          if (!ht) continue;
          if (ht === qt)              best = Math.max(best, 4);
          else if (ht.startsWith(qt)) best = Math.max(best, 2);
        }
        if (best === 0) { allTokensMatched = false; break; }
        tokenScore += best;
      }
      if (allTokensMatched) score = Math.max(score, tokenScore);
    } else {
      for (const qt of qTokens) {
        for (const ht of haystackTokens) {
          if (!ht) continue;
          if (ht === qt)           score += 4;
          else if (ht.startsWith(qt)) score += 2;
        }
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

/**
 * Collapse ranked person matches into one entry per family (surname), keeping
 * the highest-scoring member of each family as the representative used for
 * the card's plot and for the family.html link (any member's ID works there
 * since related_persons is bidirectional). People with no related_persons
 * aren't part of any family group, so they're dropped before grouping —
 * they only ever show up under Individual mode.
 */
function groupByFamily(results) {
  const seen = new Set();
  const groups = [];
  for (const person of results) {
    if (!(person.related_persons || []).length) continue;
    const key = person.last_name || person.id;
    if (seen.has(key)) continue;
    seen.add(key);
    groups.push(person);
  }
  return groups;
}

function renderResults(results, container) {
  container.innerHTML = "";

  const isFamily = searchMode === 'family';
  const items = isFamily ? groupByFamily(results) : results;

  if (!items.length) {
    const msg = '該当する方が見つかりませんでした。<br>別のお名前や姓のみでお試しください。';
    container.innerHTML = `<div class="results-empty">${msg}</div>`;
    return;
  }

  // Count summary
  const n = items.length;
  const summary = isFamily ? `${n}件の家族が見つかりました。` : `${n}件の方が見つかりました。`;
  container.innerHTML = `<p class="results-count">${summary}</p>`;

  for (const person of items) {
    const card = document.createElement("div");
    card.className = "family-card";

    // Family mode: just the family name + plot, one box per family.
    // Individual mode: the matching person's own name + plot.
    const nameLabel = isFamily
      ? `${person.last_name || ''}家`
      : `${person.last_name || ''} ${person.first_name || ''}`.trim();
    const plotRow = person.plot ? `<span>区画：<strong>${person.plot}</strong></span>` : '';

    card.innerHTML = `
      <div class="fc-name">${nameLabel}</div>
      <div class="fc-meta">
        ${plotRow}
      </div>
      <div class="fc-actions">
        <button class="fc-btn-detail">詳細</button>
      </div>`;

    card.querySelector('.fc-btn-detail').addEventListener('click', () => {
      sessionStorage.setItem('kiosk_person', person.id);
      const q = document.getElementById('searchInput');
      sessionStorage.setItem('kiosk_last_query', q?.value || '');
      const dest = isFamily
        ? `family.html?person=${encodeURIComponent(person.id)}`
        : `profile.html?person=${encodeURIComponent(person.id)}`;
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
      // Re-render with the new mode's grouping so existing results update
      // immediately instead of waiting for the next keystroke.
      if (input.value.trim()) submit();
    });
  });
}

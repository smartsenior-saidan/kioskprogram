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
} from "./firebase.js?v=1";

// --- Fuzzy matching utilities ----------------------------------------------

/** Detect whether the string contains Japanese characters. */
function isJapanese(str) {
  return /[\u3040-\u30ff\u4e00-\u9fff\uf900-\ufaff]/.test(str);
}

// Fold a kana character to its plainest form so small differences in
// diacritics don't block a match. Voiced (dakuten) and semi-voiced
// (handakuten) marks are removed (\u304c\u2192\u304b, \u3071\u2192\u306f) and small kana are enlarged
// (\u3063\u2192\u3064, \u3083\u2192\u3084). This is what lets a guest who types "\u3084\u307e\u305f" still find
// "\u3084\u307e\u3060" without having to hunt for the \u309b key on the kana keyboard.
const KANA_FOLD = {
  \u304c: "\u304b", \u304e: "\u304d", \u3050: "\u304f", \u3052: "\u3051", \u3054: "\u3053",
  \u3056: "\u3055", \u3058: "\u3057", \u305a: "\u3059", \u305c: "\u305b", \u305e: "\u305d",
  \u3060: "\u305f", \u3062: "\u3061", \u3065: "\u3064", \u3067: "\u3066", \u3069: "\u3068",
  \u3070: "\u306f", \u3073: "\u3072", \u3076: "\u3075", \u3079: "\u3078", \u307c: "\u307b",
  \u3071: "\u306f", \u3074: "\u3072", \u3077: "\u3075", \u307a: "\u3078", \u307d: "\u307b",
  \u3094: "\u3046",
  \u3041: "\u3042", \u3043: "\u3044", \u3045: "\u3046", \u3047: "\u3048", \u3049: "\u304a",
  \u3063: "\u3064", \u3083: "\u3084", \u3085: "\u3086", \u3087: "\u3088", \u308e: "\u308f",
};

/** Fold a whole string: katakana\u2192hiragana, then strip diacritics / enlarge small kana. */
function foldKana(str) {
  let out = "";
  for (const ch of str) {
    const code = ch.codePointAt(0);
    // Katakana (\u30a1\u2013\u30f6) \u2192 hiragana, so \u30e4\u30de\u30c0 matches \u3084\u307e\u3060 too.
    const c = code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
    out += KANA_FOLD[c] || c;
  }
  return out;
}

/**
 * Normalize for matching.
 * - Latin input: lowercase, strip accents, collapse whitespace.
 * - Japanese input: fold kana (see foldKana) + collapse whitespace.
 */
function normalize(str) {
  const s = (str || "").toString().trim();
  if (isJapanese(s)) {
    // Fold kana so dakuten/handakuten/small-kana differences don't block a
    // match, then remove full-width spaces and collapse whitespace.
    return foldKana(s.replace(/[\u3000\s]+/g, " ").trim());
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
    // Guests often forget the space between surname and given name (e.g.
    // "山田太郎" instead of "山田 太郎") — compare space-stripped forms too
    // so those queries still match the combined name fields.
    if (!qFull.includes(" ")) {
      const qCompact = qFull.replace(/\s+/g, "");
      for (const t of targets) {
        const tCompact = t.replace(/\s+/g, "");
        if (!tCompact || tCompact === t) continue; // no space to strip, already checked above
        if (tCompact === qCompact)              score = Math.max(score, 10);
        else if (tCompact.startsWith(qCompact)) score = Math.max(score, 7);
      }
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

// Key a person by their kana reading for あいうえお ordering (surname, then
// given name). Falls back to the kanji name when a reading isn't recorded, so
// incomplete records still sort somewhere sensible rather than jumping around.
// The   separator keeps a shorter surname sorting before a longer one that
// starts with the same characters (やま before やまだ).
function readingKey(p) {
  const last = foldKana((p.last_name_kana || p.last_name || "").trim());
  const first = foldKana((p.first_name_kana || p.first_name || "").trim());
  return `${last} ${first}`;
}

/**
 * Fuzzy-search the tenant's persons.
 * @param {string} queryText raw user input
 * @param {object} [opts] { maxResults = 12 }
 * @returns {Promise<Array>} matched person objects (each with a `_score`),
 *   displayed in あいうえお order.
 */
export async function searchPersons(queryText, opts = {}) {
  const { maxResults = 12 } = opts;
  const qFull = normalize(queryText);

  if (!qFull) return [];

  const qTokens = qFull.split(" ").filter(Boolean);
  const persons = await loadPersons();

  // Pick the most relevant matches by score first (so the closest names are
  // never dropped when there are many hits)…
  const matches = persons
    .map((p) => ({ ...p, _score: scorePerson(p, qTokens, qFull) }))
    .filter((p) => p._score > 1.2) // drop weak/no matches
    .sort((a, b) => b._score - a._score)
    .slice(0, maxResults);

  // …then present that set in あいうえお (kana reading) order, as requested,
  // rather than by relevance.
  matches.sort((a, b) => readingKey(a).localeCompare(readingKey(b), "ja"));
  return matches;
}

// --- UI wiring (index.html) -------------------------------------------------

/** "YYYY-MM-DD" → "YYYY年M月D日" for the result card. */
function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${y}年${m}月${d}日`;
}

function renderResults(results, container) {
  container.innerHTML = "";

  if (!results.length) {
    const msg = '該当する方が見つかりませんでした。<br>別のお名前や姓のみでお試しください。';
    container.innerHTML = `<div class="results-empty">${msg}</div>`;
    return;
  }

  // Count summary
  const n = results.length;
  container.innerHTML = `<p class="results-count">${n}件の方が見つかりました。</p>`;

  for (const person of results) {
    const card = document.createElement("div");
    card.className = "family-card";

    const nameLabel = `${person.last_name || ''} ${person.first_name || ''}`.trim();
    const birth = formatDate(person.birth_date);
    const death = formatDate(person.death_date);
    const metaRow = [
      birth ? `<span>生年月日：<strong>${birth}</strong></span>` : '',
      death ? `<span>没年月日：<strong>${death}</strong></span>` : '',
      person.plot ? `<span>区画：<strong>${person.plot}</strong></span>` : '',
    ].join('');

    const inFamily = (person.related_persons || []).length > 0;
    const actionsHtml = inFamily
      ? `<button class="fc-btn-detail fc-btn-individual">個人ページ</button>
         <button class="fc-btn-detail fc-btn-family">家族ページ</button>`
      : `<button class="fc-btn-detail">個人ページ</button>`;

    card.innerHTML = `
      <div class="fc-name-row">
        <div class="fc-name">${nameLabel}</div>
      </div>
      <div class="fc-meta">
        ${metaRow}
      </div>
      <div class="fc-actions">
        ${actionsHtml}
      </div>`;

    const goTo = (dest) => {
      sessionStorage.setItem('kiosk_person', person.id);
      const q = document.getElementById('searchInput');
      sessionStorage.setItem('kiosk_last_query', q?.value || '');
      window.location.href = dest;
    };

    if (inFamily) {
      card.querySelector('.fc-btn-individual').addEventListener('click', () => {
        goTo(`profile.html?person=${encodeURIComponent(person.id)}`);
      });
      card.querySelector('.fc-btn-family').addEventListener('click', () => {
        goTo(`family.html?person=${encodeURIComponent(person.id)}`);
      });
    } else {
      card.querySelector('.fc-btn-detail').addEventListener('click', () => {
        goTo(`profile.html?person=${encodeURIComponent(person.id)}`);
      });
    }

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
}

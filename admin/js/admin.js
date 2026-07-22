// admin.js — SmartSenior admin portal: dashboard, profile management, media upload.

import {
  db,
  storage,
  auth,
  onAuthStateChanged,
  signOut,
  doc,
  getDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  collection,
  where,
  tenantQuery,
  withTenant,
  serverTimestamp,
  arrayRemove,
  arrayUnion,
  storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  COLLECTIONS,
  TENANT_ID,
  personMediaCollection,
  personMediaDoc,
} from "./firebase.js?v=7";
import { t, getLang, setLang, applyStaticI18n, onLangChange } from "./i18n.js?v=30";

// ── State ───────────────────────────────────────────────────────────────────

let stagedFiles = [];       // { file, type, previewUrl } — new gallery uploads
let stagedCover = null;    // { file, previewUrl } — new cover upload
let existingCover = null;  // { id, storage_url, storage_path } — loaded from Firestore
let existingGallery = [];  // [{ id, storage_url, storage_path, file_type }] — loaded from Firestore
let removedMediaIds = [];  // Firestore media doc IDs queued for deletion on save
let bgPresets = [];         // [{ path, url }] — this tenant's 5 shared backgrounds, resolved once
let selectedBgPath = null;  // path of the chosen preset (matches an entry in bgPresets), or null
let editingPersonId = null;
let editingPerson = null;   // full person object while editing (for re-translation)
let allProfiles = [];       // cached for client-side filtering

// Escape user-entered text before interpolating it into innerHTML templates.
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Matches a person against a free-text name query, first name or last name
// alone, or both together in either order (Japanese convention is last-then-
// first, e.g. "山田 太郎"; Western order and no-space full names also match).
function matchesNameQuery(person, rawQuery) {
  const q = (rawQuery || "").trim().toLowerCase();
  if (!q) return true;

  const first = (person.first_name || "").toLowerCase();
  const last = (person.last_name || "").toLowerCase();
  const firstKana = (person.first_name_kana || "").toLowerCase();
  const lastKana = (person.last_name_kana || "").toLowerCase();

  const wholes = [
    `${last}${first}`, `${first}${last}`, `${last} ${first}`, `${first} ${last}`,
    `${lastKana}${firstKana}`, `${firstKana}${lastKana}`, `${lastKana} ${firstKana}`, `${firstKana} ${lastKana}`,
  ];
  if (wholes.some((w) => w && w.includes(q))) return true;

  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length > 1) {
    const fields = [first, last, firstKana, lastKana];
    return tokens.every((tok) => fields.some((f) => f.includes(tok)));
  }
  return false;
}

// Matches a person against a query on their posthumous name (kaimyo). Kept
// separate from matchesNameQuery so it can be opted into only where wanted
// (the family-link picker), not applied to every name search.
function matchesKaimyoQuery(person, rawQuery) {
  const q = (rawQuery || "").trim().toLowerCase();
  if (!q) return false;
  const kaimyo = (person.kaimyo || person.posthumous_name || "").toLowerCase();
  return !!kaimyo && kaimyo.includes(q);
}

// The search used by the profile lists (dashboard, family, individual):
// matches on name (first/last, kanji or kana) OR posthumous name (kaimyo).
function matchesProfileQuery(person, rawQuery) {
  return matchesNameQuery(person, rawQuery) || matchesKaimyoQuery(person, rawQuery);
}
let dashboardPersons = [];  // cached for the family/individual panel search
let familyRecords = [];     // named family docs (the `families` collection)
let selectedFamilyKey = null; // Family page: which family is drilled into (null = families list)
let activeSearchTab = "family"; // Search section: "family" | "individual" — family shown first
let entityIds = { family: new Map(), person: new Map() }; // display IDs (KDR-F0001, KDR-F0001-01, KDR-I0001)
let currentSection = "dashboard";
let sortField = "last_name"; // last_name | first_name | death_date | created_at
let sortDir   = "asc";       // asc | desc
let selectedRelated = [];   // array of { id, first_name, last_name, kaimyo }
let familyBuilder = [];     // "New Family" tab: { id, first_name, last_name, kaimyo }

// ── Section navigation ───────────────────────────────────────────────────────

/** Page title for the current section — "Edit — {name}" while editing, else the section label. */
function currentPageTitle() {
  if (currentSection === "new-profile" && editingPersonId && editingPerson) {
    return t("formTitle.edit", { name: `${editingPerson.first_name} ${editingPerson.last_name}` });
  }
  return t(`section.${currentSection}`);
}

function showSection(name, opts = {}) {
  currentSection = name;
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));

  const sec = document.getElementById(`sec-${name}`);
  if (sec) sec.classList.add("active");

  // While editing, the "new-profile" form is shown but "Profiles" stays highlighted —
  // editing isn't the same action as starting a brand new profile.
  const activeNav = opts.activeNav || name;
  document.querySelectorAll(`[data-section="${activeNav}"]`).forEach((el) =>
    el.classList.add("active")
  );

  const titleEl = document.getElementById("pageTitle");
  if (titleEl) titleEl.textContent = currentPageTitle();
  const subEl = document.getElementById("pageSubtitle");
  if (subEl) subEl.textContent = name === "dashboard" ? t(`sub.${activeSearchTab}`) : t(`sub.${name}`);

  // Search holds both the Family and Individual tabs — load once and render
  // whichever tab is currently active.
  if (name === "dashboard") loadSearchData();

  // Give this section its own browser-history entry so Back/Forward moves
  // between in-app sections instead of leaving the app. Skipped when we're
  // here *because* of a Back/Forward press (popstate already moved history).
  if (!opts.skipPush) pushHistory(name, { activeNav, personId: opts.personId || null });
}

// ── Browser history (Back/Forward moves between sections, not out of the app) ──

let _historyInitialized = false;

function pushHistory(name, { activeNav, personId } = {}) {
  const state = { section: name, activeNav: activeNav || name, personId: personId || null };
  if (!_historyInitialized) {
    // First section shown after load — replace so there's no extra "blank" entry to Back into.
    history.replaceState(state, "", `#${name}`);
    _historyInitialized = true;
  } else {
    history.pushState(state, "", `#${name}`);
  }
}

window.addEventListener("popstate", async (e) => {
  const state = e.state || { section: "dashboard" };

  if (state.section === "new-profile" && state.personId) {
    let person = allProfiles.find((p) => p.id === state.personId);
    if (!person) {
      try {
        const snap = await getDoc(doc(db, COLLECTIONS.persons, state.personId));
        if (snap.exists()) person = { id: snap.id, ...snap.data() };
      } catch (err) { console.warn("[admin] history restore failed:", err); }
    }
    if (person) {
      await loadForEdit(person);
      showSection("new-profile", { activeNav: "dashboard", personId: person.id, skipPush: true });
      return;
    }
  }

  if (state.section === "new-profile" && !state.personId) resetForm();
  showSection(state.section || "dashboard", { activeNav: state.activeNav, skipPush: true });
});

// ── Status helpers ───────────────────────────────────────────────────────────

const TOAST_ICONS = {
  info:    '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>',
  success: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>',
  error:   '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-5a1 1 0 00-1 1v4a1 1 0 002 0V6a1 1 0 00-1-1zm0 10a1.25 1.25 0 100-2.5 1.25 1.25 0 000 2.5z" clip-rule="evenodd"/></svg>',
};

function setStatus(msg, kind = "info") {
  const el = document.getElementById("topStatus");
  if (!el) return;
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[kind] || TOAST_ICONS.info}</span><span class="toast-msg">${esc(msg)}</span>`;
  el.classList.remove("hidden");
  // Restart the slide-in animation on repeat calls
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add("hidden"), 4000);
}

function setFormStatus(msg, kind = "info") {
  const el = document.getElementById("formStatus");
  if (!el) return;
  el.className = `form-status ${kind}`;
  el.textContent = msg;
  el.classList.remove("hidden");
}

function clearFormStatus() {
  const el = document.getElementById("formStatus");
  if (el) el.classList.add("hidden");
}

// ── Search tabs (Family groups / Individuals) ─────────────────────────────────
// Family and Individual are two panels of the same Search section, switched
// client-side (not separate history-tracked sections) — Family shown first.

/** Reflects `tab` in the tab bar / panel visibility, without touching which
 *  family (if any) is drilled into — used both for a deliberate tab click and
 *  for restoring state (e.g. the Back button from Edit Profile). */
function setActiveSearchTab(tab) {
  activeSearchTab = tab;
  document.querySelectorAll(".search-tab").forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.tab === tab)
  );
  document.getElementById("panel-family")?.classList.toggle("hidden", tab !== "family");
  document.getElementById("panel-individual")?.classList.toggle("hidden", tab !== "individual");
  if (currentSection === "dashboard") {
    const subEl = document.getElementById("pageSubtitle");
    if (subEl) subEl.textContent = t(`sub.${tab}`);
  }
}

/** A deliberate switch to `tab` (tab click or fresh entry into Search) — always
 *  lands on that tab's top level, unlike setActiveSearchTab alone. */
function switchSearchTab(tab) {
  if (tab === "family") selectedFamilyKey = null;
  setActiveSearchTab(tab);
  renderFamilyIndividualPanel();
}

function updateSearchTabCounts() {
  const famCount = document.getElementById("tabCountFamily");
  const indCount = document.getElementById("tabCountIndividual");
  if (famCount) famCount.textContent = buildFamilies().length;
  if (indCount) indCount.textContent = dashboardPersons.length;
}

async function loadSearchData() {
  try {
    const snap = await getDocs(tenantQuery(COLLECTIONS.persons));
    allProfiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dashboardPersons = allProfiles;
    await loadFamilies();
    recomputeEntityIds();
    renderFamilyIndividualPanel();
    updateSearchTabCounts();
  } catch (err) {
    console.error("[search] load failed:", err);
    if (err.message?.includes("index")) {
      setStatus(t("status.indexNeeded"), "error");
    }
  }
}

// Named family records for this tenant. Failures (e.g. rules not yet deployed)
// degrade gracefully to an empty list rather than breaking the page.
async function loadFamilies() {
  try {
    const snap = await getDocs(tenantQuery(COLLECTIONS.families));
    familyRecords = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Oldest first so each family keeps a stable F-number as new ones are added.
    familyRecords.sort((a, b) => (a.created_at?.seconds ?? 0) - (b.created_at?.seconds ?? 0));
  } catch (err) {
    console.warn("[families] load failed (is the families security rule deployed?):", err.message || err);
    familyRecords = [];
  }
}

// ── Family / individual tab panels ────────────────────────────────────────────
// Family groups people who are linked via related_persons (or a named family
// record); Individuals lists every person at this site, flat, regardless of
// family links. Both panels render the same profiles table, just pre-filtered
// differently.

function renderFamilyIndividualPanel() {
  renderFamilySection();
  renderIndividualSection();
}

// The set of person ids that belong to a named family record.
function familyMemberIdSet() {
  const s = new Set();
  for (const rec of familyRecords) for (const id of (rec.member_ids || [])) s.add(id);
  return s;
}

// The unified family list shown on the Family page: named records (which may be
// empty) plus "legacy" families still derived from related_persons for anyone
// not already in a record. Each family has { key, name, members }.
function buildFamilies() {
  const covered = familyMemberIdSet();

  const recordFamilies = familyRecords.map((rec) => ({
    key: `rec:${rec.id}`,
    name: rec.name || "—",
    members: (rec.member_ids || [])
      .map((id) => dashboardPersons.find((p) => p.id === id))
      .filter(Boolean),
  }));

  const legacy = new Map();
  for (const p of dashboardPersons) {
    if (!(p.related_persons || []).length || covered.has(p.id)) continue;
    const key = p.last_name || "—";
    if (!legacy.has(key)) legacy.set(key, []);
    legacy.get(key).push(p);
  }
  const legacyFamilies = [...legacy.entries()].map(([lastName, members]) => ({
    key: `last:${lastName}`,
    name: `${lastName}家`,
    members,
  }));

  return [...recordFamilies, ...legacyFamilies];
}

// Short tenant prefix for the display IDs (e.g. "Kodaira Reien" → "KDR").
// Consonants of the name first (so vowels don't dominate); fall back to the
// plain letters. A tenant can override this later with an explicit code field.
function tenantCode() {
  const name = (TENANT_ID || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  const letters = name.replace(/[^A-Za-z]/g, "");
  const consonants = letters.replace(/[AEIOUaeiou]/g, "");
  const base = (consonants.length >= 3 ? consonants : letters).toUpperCase();
  return base.slice(0, 3) || "TEN";
}

// Build the display-ID maps for the current data:
//   family key   → "KDR-F0001"
//   person id    → "KDR-I0001-01" (family member — reuses their family's
//                  number, since a person is an individual record even when
//                  nested inside a family) or "KDR-I0002" (standalone individual)
// Families are numbered in their stable list order; individuals by age. IDs are
// derived for display only (admin) — not persisted.
function recomputeEntityIds() {
  const code = tenantCode();
  const family = new Map();
  const person = new Map();

  buildFamilies().forEach((f, i) => {
    const famNum = String(i + 1).padStart(4, "0");
    family.set(f.key, `${code}-F${famNum}`);
    f.members.forEach((p, j) => {
      person.set(p.id, `${code}-I${famNum}-${String(j + 1).padStart(2, "0")}`);
    });
  });

  const covered = familyMemberIdSet();
  dashboardPersons
    .filter((p) => !(p.related_persons || []).length && !covered.has(p.id))
    .sort((a, b) => (a.created_at?.seconds ?? 0) - (b.created_at?.seconds ?? 0))
    .forEach((p, i) => {
      person.set(p.id, `${code}-I${String(i + 1).padStart(4, "0")}`);
    });

  entityIds = { family, person };
}

// Individual tab: every person at this site, flat (not grouped by family) —
// matches the Individuals tab's count badge.
function renderIndividualSection() {
  const el = document.getElementById("fiIndividualList");
  if (!el) return;
  const q = document.getElementById("individualSearchInput")?.value || "";
  let pool = dashboardPersons;
  if (q.trim()) pool = pool.filter((p) => matchesProfileQuery(p, q));
  renderPersonsTable(el, pool, dashboardPersons);
}

// Family view is two levels: a list of families, and — once a family is
// clicked — that family's members shown as the dashboard table.
function renderFamilySection() {
  const el = document.getElementById("fiFamilyList");
  if (!el) return;

  let families = buildFamilies();

  const q = (document.getElementById("familySearchInput")?.value || "").trim().toLowerCase();
  if (q) {
    // Match the family name itself ("山田家") or any member's name/kaimyo.
    families = families.filter(
      (f) => f.name.toLowerCase().includes(q) || f.members.some((p) => matchesProfileQuery(p, q))
    );
  }
  families.sort((a, b) => a.name.localeCompare(b.name));

  // Level 2 — a family is open: its members as the same table as the dashboard.
  const open = selectedFamilyKey && families.find((f) => f.key === selectedFamilyKey);
  if (open) {
    // Adding a member always works, even for a "legacy" family with no
    // Firestore record yet (grouped purely by matching related_persons +
    // surname) — addMemberToFamily promotes it to a named record on first add.
    el.innerHTML = `
      <div class="drill-header">
        <button type="button" class="btn-secondary" id="familyBackBtn">${t("fi.backToFamilies")}</button>
        <span class="drill-title">${esc(open.name)}</span>
        <span class="entity-id">${esc(entityIds.family.get(open.key) || "")}</span>
      </div>
      <div class="family-picker family-add-picker">
        <p class="field-hint">${esc(t("fi.addMemberLabel"))}</p>
        <div class="family-search-row">
          <input id="famAddSearch" type="search" placeholder="${esc(t("fi.addMemberPh"))}" autocomplete="off" />
        </div>
        <ul class="family-suggestions hidden" id="famAddSuggestions"></ul>
      </div>
      <div id="familyMembersTable"></div>`;
    const tableEl = document.getElementById("familyMembersTable");
    if (open.members.length) {
      renderPersonsTable(tableEl, open.members, dashboardPersons);
    } else {
      tableEl.innerHTML = `<p class="empty-state">${t("fi.emptyFamily")}</p>`;
    }
    document.getElementById("familyBackBtn")?.addEventListener("click", () => {
      selectedFamilyKey = null;
      renderFamilySection();
    });
    wireFamilyAddPicker(open.key, open.members);
    return;
  }

  // Level 1 — the list of families. Each row drills into its members.
  if (!families.length) {
    el.innerHTML = `<p class="empty-state">${t("empty.noProfiles")}</p>`;
    return;
  }

  const rows = families
    .map((f) => `
      <tr data-key="${esc(f.key)}">
        <td>
          <div class="avatar-cell">
            <div class="avatar">${esc((f.name.charAt(0) || "✦").toUpperCase())}</div>
            <div>
              <div class="profile-name">${esc(f.name)}</div>
              <div class="profile-meta entity-id">${esc(entityIds.family.get(f.key) || "")}</div>
            </div>
          </div>
        </td>
        <td>${f.members.length}${t("fi.peopleSuffix")}</td>
        <td>
          <div class="fam-row-actions">
            <button class="btn-danger" data-fam-delete="${esc(f.key)}">${t("btn.delete")}</button>
            <span class="drill-chevron">›</span>
          </div>
        </td>
      </tr>`)
    .join("");

  el.innerHTML = `
    <div class="profiles-table-wrap">
      <table class="profiles-table">
        <thead>
          <tr>
            <th>${t("fi.familyCol")}</th>
            <th>${t("fi.membersCol")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  el.querySelectorAll("tr[data-key]").forEach((tr) => {
    tr.style.cursor = "pointer";
    tr.addEventListener("click", () => {
      selectedFamilyKey = tr.dataset.key;
      renderFamilySection();
    });
  });

  // Delete button must not also drill into the family row.
  el.querySelectorAll("[data-fam-delete]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteFamily(btn.dataset.famDelete);
    });
  });
}

// Remove a family: delete the named record (if any) and dissolve the grouping
// by stripping the members' mutual related_persons links. The profiles remain
// as individuals — only the family grouping goes away.
async function deleteFamily(key) {
  const fam = buildFamilies().find((f) => f.key === key);
  if (!fam) return;

  const ok = await confirmDialog({
    title: t("confirm.deleteFamilyTitle"),
    body: t("confirm.deleteFamily", { name: fam.name }),
    confirmLabel: t("btn.confirmDeleteFamily"),
  });
  if (!ok) return;

  setStatus(t("status.deleting"), "info");
  try {
    if (key.startsWith("rec:")) {
      await deleteDoc(doc(db, COLLECTIONS.families, key.slice(4)));
    }

    // Dissolve the clique — remove only the links pointing at other members of
    // this family (any link to someone outside it is left intact).
    const memberIds = fam.members.map((m) => m.id);
    for (const m of fam.members) {
      const remaining = (m.related_persons || []).filter((id) => !memberIds.includes(id));
      if (remaining.length !== (m.related_persons || []).length) {
        await updateDoc(doc(db, COLLECTIONS.persons, m.id), {
          related_persons: remaining,
          updated_at: serverTimestamp(),
        });
      }
    }

    // Refresh caches: reload family records, and mirror the unlink in memory.
    await loadFamilies();
    for (const list of [dashboardPersons, allProfiles]) {
      for (const p of list) {
        if (memberIds.includes(p.id) && p.related_persons?.length) {
          p.related_persons = p.related_persons.filter((id) => !memberIds.includes(id));
        }
      }
    }

    selectedFamilyKey = null;
    recomputeEntityIds();
    renderFamilyIndividualPanel();
    updateSearchTabCounts();
    setStatus(t("status.familyDeleted", { name: fam.name }), "success");
  } catch (err) {
    console.error("[admin] delete family failed:", err);
    setStatus(t("status.deleteFailed", { msg: err.message }), "error");
  }
}

// Search-and-add picker inside an open family's drill-down — lets an admin
// add existing profiles to a family after it's been created, not just at
// creation time. Re-wired on every render since the drill view's markup is
// rebuilt from scratch each time (innerHTML). Uses blur (not a document-level
// click listener) to close suggestions, so old listeners never pile up across
// re-renders.
function wireFamilyAddPicker(famKey, existingMembers) {
  const input = document.getElementById("famAddSearch");
  const suggestions = document.getElementById("famAddSuggestions");
  if (!input || !suggestions) return;
  const excludeIds = new Set(existingMembers.map((m) => m.id));

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { suggestions.classList.add("hidden"); return; }

    const matches = allProfiles.filter((p) => {
      if (excludeIds.has(p.id)) return false;
      return matchesNameQuery(p, q) || matchesKaimyoQuery(p, q);
    }).slice(0, 6);

    if (!matches.length) { suggestions.classList.add("hidden"); return; }

    suggestions.innerHTML = matches.map((p) => {
      const initials = ((p.last_name || "").charAt(0) + (p.first_name || "").charAt(0)) || "✦";
      const kaimyo = p.kaimyo || p.posthumous_name || "";
      return `
      <li class="family-suggestion-item" data-id="${p.id}">
        <span class="suggestion-avatar">${esc(initials)}</span>
        <span class="suggestion-body">
          <span class="suggestion-name">${esc(p.first_name)} ${esc(p.last_name)}${p.death_date ? ` <span class="suggestion-year">(${esc(p.death_date.slice(0, 4))})</span>` : ""}</span>
          ${kaimyo ? `<span class="suggestion-kaimyo">${esc(kaimyo)}</span>` : ""}
        </span>
      </li>`;
    }).join("");
    suggestions.classList.remove("hidden");

    suggestions.querySelectorAll(".family-suggestion-item").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus so the blur-hide below doesn't beat the click
        addMemberToFamily(famKey, item.dataset.id);
      });
    });
  });

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  input.addEventListener("blur", () => {
    setTimeout(() => suggestions.classList.add("hidden"), 150);
  });
}

// Add an existing profile to a family. Named records just extend member_ids;
// a "legacy" family (grouped only by matching related_persons + surname, no
// Firestore doc) is promoted to a named record first, since otherwise a new
// member with a different surname wouldn't show up in the group at all — the
// legacy grouping in buildFamilies() keys purely off each person's own
// last_name. Either way, the person is linked bidirectionally with every
// current member (related_persons) so kiosk family navigation still works.
async function addMemberToFamily(key, personId) {
  const fam = buildFamilies().find((f) => f.key === key);
  const person = allProfiles.find((p) => p.id === personId);
  if (!fam || !person) return;

  setStatus(t("status.saving"), "info");
  try {
    const existingIds = fam.members.map((m) => m.id);
    let recordId = key.startsWith("rec:") ? key.slice(4) : null;

    if (recordId) {
      await updateDoc(doc(db, COLLECTIONS.families, recordId), {
        member_ids: arrayUnion(personId),
        updated_at: serverTimestamp(),
      });
    } else {
      const ref = await addDoc(collection(db, COLLECTIONS.families), withTenant({
        name: fam.name,
        member_ids: [...existingIds, personId],
        updated_at: serverTimestamp(),
      }));
      recordId = ref.id;
    }

    if (existingIds.length) {
      await updateDoc(doc(db, COLLECTIONS.persons, personId), {
        related_persons: arrayUnion(...existingIds),
        updated_at: serverTimestamp(),
      });
      for (const id of existingIds) {
        await updateDoc(doc(db, COLLECTIONS.persons, id), {
          related_persons: arrayUnion(personId),
          updated_at: serverTimestamp(),
        });
      }
    }

    await loadFamilies();
    const snap = await getDocs(tenantQuery(COLLECTIONS.persons));
    allProfiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dashboardPersons = allProfiles;
    recomputeEntityIds();
    selectedFamilyKey = `rec:${recordId}`; // legacy families get a new key once promoted
    renderFamilySection();
    updateSearchTabCounts();
    setStatus(t("status.memberAdded", { name: `${person.last_name || ""}${person.first_name || ""}`.trim() }), "success");
  } catch (err) {
    console.error("[admin] add member failed:", err);
    setStatus(t("status.saveFailed", { msg: err.message }), "error");
  }
}

// ── Full profile list ─────────────────────────────────────────────────────────

function sortProfiles(list) {
  return [...list].sort((a, b) => {
    let av = (a[sortField] || "").toString().toLowerCase();
    let bv = (b[sortField] || "").toString().toLowerCase();
    if (sortField === "created_at") {
      av = a.created_at?.seconds ?? 0;
      bv = b.created_at?.seconds ?? 0;
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === "asc" ? cmp : -cmp;
  });
}

function sortIcon(field) {
  if (sortField !== field) return '<span class="sort-icon">↕</span>';
  return `<span class="sort-icon active">${sortDir === "asc" ? "↑" : "↓"}</span>`;
}

/**
 * Render the full profiles table (avatar, name, year, section, row, actions)
 * into any container. Shared by the dashboard's "All Profiles" list and the
 * Family / Individual drill-down sections — same structure, different data pool.
 *   container   — element to render into
 *   persons     — already-filtered rows to show
 *   actionPool  — list the QR/Edit/Delete buttons resolve their id against
 */
function renderPersonsTable(container, persons, actionPool) {
  if (!container) return;

  if (!persons.length) {
    container.innerHTML = `<p class="empty-state">${t("empty.noProfiles")}</p>`;
    return;
  }

  const sorted = sortProfiles(persons);

  container.innerHTML = `
    <div class="profiles-table-wrap">
      <table class="profiles-table">
        <thead>
          <tr>
            <th>${t("table.id")}</th>
            <th class="sortable" data-sort="last_name">${t("table.lastName")} ${sortIcon("last_name")}</th>
            <th class="sortable" data-sort="first_name">${t("table.firstName")} ${sortIcon("first_name")}</th>
            <th class="sortable" data-sort="death_date">${t("table.passed")} ${sortIcon("death_date")}</th>
            <th>${t("table.section")}</th>
            <th>${t("table.row")}</th>
            <th>${t("table.actions")}</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map((p) => profileRow(p, true)).join("")}
        </tbody>
      </table>
    </div>`;

  // Sortable column headers — re-render this same container/pool on toggle.
  container.querySelectorAll("th.sortable").forEach((th) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (sortField === field) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortField = field;
        sortDir = "asc";
      }
      renderPersonsTable(container, persons, actionPool);
    });
  });

  wireProfileActions(container, actionPool);
}

function profileRow(p, full = false) {
  const initials = ((p.last_name || "").charAt(0) + (p.first_name || "").charAt(0)).toUpperCase() || "✦";
  const birth = (p.birth_date || "").slice(0, 4) || "—";
  const death = (p.death_date || "").slice(0, 4) || "—";

  if (full) {
    return `
      <tr data-id="${p.id}">
        <td><span class="entity-id">${esc(entityIds.person.get(p.id) || "—")}</span></td>
        <td>
          <div class="avatar-cell">
            <div class="avatar">${esc(initials)}</div>
            <div>
              <div class="profile-name">${esc(p.last_name || "—")}</div>
            </div>
          </div>
        </td>
        <td>${esc(p.first_name || "—")}</td>
        <td>${esc(death)}</td>
        <td>${esc(p.plot_section || "—")}</td>
        <td>${esc(p.plot_row || "—")}</td>
        <td>
          <div class="table-actions">
            <button class="btn-secondary" data-action="qr"     data-id="${p.id}" data-name="${esc(p.last_name || p.first_name || '')}" title="QR Code">QR</button>
            <button class="btn-secondary" data-action="edit"   data-id="${p.id}">${t("btn.edit")}</button>
            <button class="btn-danger"    data-action="delete" data-id="${p.id}">${t("btn.delete")}</button>
          </div>
        </td>
      </tr>`;
  }

  // Mini table (dashboard)
  return `
    <tr data-id="${p.id}">
      <td>
        <div class="avatar-cell">
          <div class="avatar">${esc(initials)}</div>
          <div class="profile-name">${esc(p.last_name || "")} ${esc(p.first_name || "")}</div>
        </div>
      </td>
      <td>${esc(birth)} – ${esc(death)}</td>
      <td>${esc(p.plot || "—")}</td>
      <td>
        <div class="table-actions">
          <button class="btn-secondary" data-action="edit" data-id="${p.id}">${t("btn.edit")}</button>
          <button class="btn-danger"    data-action="delete" data-id="${p.id}">${t("btn.delete")}</button>
        </div>
      </td>
    </tr>`;
}

function wireProfileActions(container, localProfiles) {
  const pool = localProfiles || allProfiles;
  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const person = pool.find((p) => p.id === id);

      if (action === "qr"     && person) showQrModal(person);
      if (action === "edit"   && person) { loadForEdit(person); showSection("new-profile", { activeNav: "dashboard", personId: person.id }); }
      if (action === "delete" && person) await deleteProfile(person);
    });
  });
}

// ── QR Code modal ────────────────────────────────────────────────────────────

function showQrModal(person) {
  const tenantId = TENANT_ID || '';
  // Solo individuals (no related_persons) have no family group to browse —
  // their QR code should open their own profile directly, not family.html.
  const hasFamily = (person.related_persons || []).length > 0;
  const page = hasFamily ? 'family.html' : 'profile.html';
  const url = `https://kiosk.saidans.org/${page}?person=${encodeURIComponent(person.id)}&site=${encodeURIComponent(tenantId)}`;
  const label = hasFamily
    ? (person.last_name ? `${person.last_name}家` : (person.first_name || 'Family'))
    : `${person.last_name || ''} ${person.first_name || ''}`.trim();

  document.getElementById('qrModalTitle').textContent = hasFamily ? t('qr.familyTitle') : t('qr.profileTitle');
  document.getElementById('qrFamilyLabel').textContent = label;
  document.getElementById('qrUrl').textContent = url;

  const modal = document.getElementById('qrModal');
  modal.style.display = 'flex';

  const canvas = document.getElementById('qrCanvas');
  const QR = window.QRCode;
  if (!QR) {
    canvas.getContext('2d').fillText('QR library not loaded', 10, 120);
    console.error('[QR] window.QRCode not available — check CDN script loaded');
    return;
  }
  QR.toCanvas(canvas, url, { width: 240, margin: 2, color: { dark: '#1a1a1a', light: '#ffffff' } })
    .catch(err => console.error('[QR] toCanvas error:', err));

  document.getElementById('qrModalClose').onclick = () => { modal.style.display = 'none'; };
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

  document.getElementById('qrPrintBtn').onclick = () => {
    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html><html><head><title>${esc(label)} QR</title>
      <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;gap:16px}
      h1{font-size:1.8rem;margin:0}p{color:#888;font-size:0.75rem;word-break:break-all;max-width:280px;text-align:center}</style>
      </head><body>
      <h1>${esc(label)}</h1>
      <img src="${canvas.toDataURL()}" width="240" height="240" />
      <p>${esc(url)}</p>
      <script>window.onload=()=>{window.print();}<\/script>
      </body></html>`);
    win.document.close();
  };

  document.getElementById('qrDownloadBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${label}-qr.png`;
    a.click();
  };
}

// ── Profile form ─────────────────────────────────────────────────────────────

function readForm() {
  const get = (id) => (document.getElementById(id)?.value || "").trim();
  const section = get("plotSection");
  const row     = get("plotRow");
  const plot    = [section, row].filter(Boolean).join("-");
  const bgPreset = bgPresets.find((p) => p.path === selectedBgPath) || null;
  return {
    first_name: get("firstName"),
    last_name: get("lastName"),
    first_name_kana: get("firstNameKana"),
    last_name_kana: get("lastNameKana"),
    kaimyo: get("kaimyo"),
    birth_date: get("birthDate"),
    death_date: get("deathDate"),
    manual_age: get("manualAge") ? Number(get("manualAge")) : null,
    plot_section: section,
    plot_row: row,
    plot,          // combined for backward-compat display/search
    biography: get("biography"),
    related_persons: selectedRelated.map((p) => p.id),
    background_url: bgPreset ? bgPreset.url : null,
    background_path: bgPreset ? bgPreset.path : null,
  };
}

/** Live preview of the combined plot label ("A-12") exactly as saved/shown. */
function updatePlotPreview() {
  const el = document.getElementById("plotPreview");
  if (!el) return;
  const section = (document.getElementById("plotSection")?.value || "").trim();
  const row     = (document.getElementById("plotRow")?.value || "").trim();
  const plot    = [section, row].filter(Boolean).join("-");
  el.textContent = plot || "—";
  el.classList.toggle("empty", !plot);
}

// ── Family picker ─────────────────────────────────────────────────────────────

function renderFamilySelected() {
  const list = document.getElementById("familySelected");
  if (!list) return;
  list.innerHTML = selectedRelated.map((p) => `
    <li class="family-tag">
      <span class="family-tag-text">
        <span class="family-tag-name">${esc(p.first_name)} ${esc(p.last_name)}</span>
        ${p.kaimyo ? `<span class="family-tag-kaimyo">${esc(p.kaimyo)}</span>` : ""}
      </span>
      <button type="button" class="family-tag-remove" data-id="${p.id}" aria-label="Remove">✕</button>
    </li>`).join("");
  list.querySelectorAll(".family-tag-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedRelated = selectedRelated.filter((p) => p.id !== btn.dataset.id);
      renderFamilySelected();
    });
  });
}

function initFamilyPicker() {
  const input = document.getElementById("familySearch");
  const suggestions = document.getElementById("familySuggestions");
  if (!input || !suggestions) return;

  let activeIndex = -1; // keyboard-highlighted suggestion

  function pick(id) {
    const p = allProfiles.find((x) => x.id === id);
    if (p && !selectedRelated.find((r) => r.id === p.id)) {
      selectedRelated.push({ id: p.id, first_name: p.first_name, last_name: p.last_name, kaimyo: p.kaimyo || p.posthumous_name || "" });
      renderFamilySelected();
    }
    input.value = "";
    suggestions.classList.add("hidden");
    activeIndex = -1;
  }

  function highlight() {
    suggestions.querySelectorAll(".family-suggestion-item").forEach((el, i) =>
      el.classList.toggle("active", i === activeIndex)
    );
  }

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    activeIndex = -1;
    if (!q) { suggestions.classList.add("hidden"); return; }

    // Also match on the posthumous name (kaimyo) — two people can share the
    // same first + last name, and the kaimyo is what tells them apart when
    // linking a family, so it's searchable here too.
    const matches = allProfiles.filter((p) => {
      if (p.id === editingPersonId) return false;
      if (selectedRelated.find((r) => r.id === p.id)) return false;
      return matchesNameQuery(p, q) || matchesKaimyoQuery(p, q);
    }).slice(0, 6);

    if (!matches.length) { suggestions.classList.add("hidden"); return; }

    suggestions.innerHTML = matches.map((p) => {
      const initials = ((p.last_name || "").charAt(0) + (p.first_name || "").charAt(0)) || "✦";
      const kaimyo = p.kaimyo || p.posthumous_name || "";
      return `
      <li class="family-suggestion-item" data-id="${p.id}">
        <span class="suggestion-avatar">${esc(initials)}</span>
        <span class="suggestion-body">
          <span class="suggestion-name">${esc(p.first_name)} ${esc(p.last_name)}${p.death_date ? ` <span class="suggestion-year">(${esc(p.death_date.slice(0, 4))})</span>` : ""}</span>
          ${kaimyo ? `<span class="suggestion-kaimyo">${esc(kaimyo)}</span>` : ""}
        </span>
      </li>`;
    }).join("");
    suggestions.classList.remove("hidden");

    suggestions.querySelectorAll(".family-suggestion-item").forEach((item) => {
      item.addEventListener("click", () => pick(item.dataset.id));
    });
  });

  // Arrow keys move the highlight, Enter picks, Escape closes — so linking a
  // family member never requires leaving the keyboard.
  input.addEventListener("keydown", (e) => {
    // Enter in this search box must never submit the whole profile form.
    if (e.key === "Enter") e.preventDefault();
    const items = suggestions.querySelectorAll(".family-suggestion-item");
    if (suggestions.classList.contains("hidden") || !items.length) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      highlight();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      highlight();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = items[activeIndex >= 0 ? activeIndex : 0];
      if (target) pick(target.dataset.id);
    } else if (e.key === "Escape") {
      suggestions.classList.add("hidden");
      activeIndex = -1;
    }
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !suggestions.contains(e.target)) {
      suggestions.classList.add("hidden");
    }
  });
}

// ── "New Family" tab — group existing profiles into one family ────────────────
// A "family" is just a set of profiles that all reference each other via
// related_persons (a clique). This tab lets an admin build that set directly —
// searching existing profiles and adding them — instead of opening each profile
// and linking one-by-one. Adding someone who's already in a family pulls their
// whole family in too, so an individual can be dropped straight into an
// existing family (or two families merged). Saving is purely additive: it only
// adds the mutual links, never removes any existing one.

function renderFamilyBuilder() {
  const list = document.getElementById("nfSelected");
  const saveBtn = document.getElementById("nfSaveBtn");
  if (!list) return;
  list.innerHTML = familyBuilder.map((p) => `
    <li class="family-tag">
      <span class="family-tag-text">
        <span class="family-tag-name">${esc(p.first_name)} ${esc(p.last_name)}</span>
        ${p.kaimyo ? `<span class="family-tag-kaimyo">${esc(p.kaimyo)}</span>` : ""}
      </span>
      <button type="button" class="family-tag-remove" data-id="${p.id}" aria-label="Remove">✕</button>
    </li>`).join("");
  list.querySelectorAll(".family-tag-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      familyBuilder = familyBuilder.filter((p) => p.id !== btn.dataset.id);
      renderFamilyBuilder();
    });
  });
  // A family only needs a name — members are optional (an empty family is fine).
  const name = (document.getElementById("nfName")?.value || "").trim();
  if (saveBtn) saveBtn.disabled = !name;
}

function addToFamilyBuilder(id) {
  const p = allProfiles.find((x) => x.id === id);
  if (!p) return;
  const push = (person) => {
    if (person && !familyBuilder.find((r) => r.id === person.id)) {
      familyBuilder.push({
        id: person.id, first_name: person.first_name,
        last_name: person.last_name, kaimyo: person.kaimyo || person.posthumous_name || "",
      });
      return true;
    }
    return false;
  };
  push(p);
  // Pull in the person's existing family so moving someone into a family (or
  // merging two families) links the whole group, not just this one person.
  let pulled = 0;
  for (const rid of (p.related_persons || [])) {
    if (push(allProfiles.find((x) => x.id === rid))) pulled++;
  }
  renderFamilyBuilder();
  if (pulled) {
    const name = `${p.last_name || ""}${p.first_name || ""}`.trim() || "—";
    setStatus(t("nf.pulledIn", { name, n: pulled }), "info");
  }
}

function initFamilyBuilder() {
  const input = document.getElementById("nfSearch");
  const suggestions = document.getElementById("nfSuggestions");
  const saveBtn = document.getElementById("nfSaveBtn");
  if (!input || !suggestions) return;

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { suggestions.classList.add("hidden"); return; }

    const matches = allProfiles.filter((p) => {
      if (familyBuilder.find((r) => r.id === p.id)) return false;
      return matchesNameQuery(p, q) || matchesKaimyoQuery(p, q);
    }).slice(0, 6);

    if (!matches.length) { suggestions.classList.add("hidden"); return; }

    suggestions.innerHTML = matches.map((p) => {
      const initials = ((p.last_name || "").charAt(0) + (p.first_name || "").charAt(0)) || "✦";
      const kaimyo = p.kaimyo || p.posthumous_name || "";
      const inFamily = (p.related_persons || []).length
        ? `<span class="suggestion-fam">${esc(p.last_name || "")}家</span>` : "";
      return `
      <li class="family-suggestion-item" data-id="${p.id}">
        <span class="suggestion-avatar">${esc(initials)}</span>
        <span class="suggestion-body">
          <span class="suggestion-name">${esc(p.first_name)} ${esc(p.last_name)}${p.death_date ? ` <span class="suggestion-year">(${esc(p.death_date.slice(0, 4))})</span>` : ""}${inFamily}</span>
          ${kaimyo ? `<span class="suggestion-kaimyo">${esc(kaimyo)}</span>` : ""}
        </span>
      </li>`;
    }).join("");
    suggestions.classList.remove("hidden");

    suggestions.querySelectorAll(".family-suggestion-item").forEach((item) => {
      item.addEventListener("click", () => {
        addToFamilyBuilder(item.dataset.id);
        input.value = "";
        suggestions.classList.add("hidden");
        input.focus();
      });
    });
  });

  // Enter here must never bubble anywhere that would navigate away.
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !suggestions.contains(e.target)) {
      suggestions.classList.add("hidden");
    }
  });

  // Typing a name enables "Create family" (members stay optional).
  const nameInput = document.getElementById("nfName");
  nameInput?.addEventListener("input", renderFamilyBuilder);
  nameInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !nameInput.value.trim()) e.preventDefault();
  });

  saveBtn?.addEventListener("click", saveFamilyBuilder);
  renderFamilyBuilder();
}

async function saveFamilyBuilder() {
  const nameEl = document.getElementById("nfName");
  const raw = (nameEl?.value || "").trim();
  if (!raw) { setStatus(t("nf.needName"), "error"); nameEl?.focus(); return; }
  // Every family name ends in 家 (山田 → 山田家); don't double it if already there.
  const name = raw.endsWith("家") ? raw : `${raw}家`;

  const saveBtn = document.getElementById("nfSaveBtn");
  const ids = familyBuilder.map((p) => p.id);
  if (saveBtn) saveBtn.disabled = true;
  setStatus(t("nf.saving"), "info");

  try {
    // Create the family record. Members are optional — an empty family is fine.
    await addDoc(collection(db, COLLECTIONS.families), withTenant({
      name,
      member_ids: ids,
      updated_at: serverTimestamp(),
    }));

    // Keep the kiosk working without any kiosk change: link members to each
    // other via related_persons (additive) so a 2+ member family still
    // navigates on the visitor-facing kiosk, which reads those links.
    for (const id of ids) {
      const others = ids.filter((x) => x !== id);
      if (!others.length) continue;
      const snap = await getDoc(doc(db, COLLECTIONS.persons, id));
      const existing = snap.exists() ? (snap.data().related_persons || []) : [];
      const merged = [...new Set([...existing, ...others])];
      if (merged.length !== existing.length) {
        await updateDoc(doc(db, COLLECTIONS.persons, id), {
          related_persons: merged,
          updated_at: serverTimestamp(),
        });
      }
    }

    // Refresh caches so the new family shows everywhere.
    const snap = await getDocs(tenantQuery(COLLECTIONS.persons));
    allProfiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    dashboardPersons = allProfiles;
    await loadFamilies();

    familyBuilder = [];
    if (nameEl) nameEl.value = "";
    renderFamilyBuilder();
    setStatus(t("nf.created", { name }), "success");

    // Jump to the Family tab so the new family is visible right away.
    switchSearchTab("family");
    showSection("dashboard", { activeNav: "dashboard" });
  } catch (err) {
    console.error("[admin] create family failed:", err);
    setStatus(t("nf.createFailed", { msg: err.message || err }), "error");
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function handleSave(e) {
  e.preventDefault();
  clearFormStatus();

  const data = readForm();
  if (!data.first_name || !data.last_name) {
    setFormStatus(t("status.nameRequired"), "error");
    return;
  }

  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.disabled = true;
  setFormStatus(t("status.saving"), "info");

  try {
    let personId = editingPersonId;
    if (personId) {
      await updateDoc(doc(db, COLLECTIONS.persons, personId), {
        ...data,
        updated_at: serverTimestamp(),
      });
    } else {
      const ref = await addDoc(collection(db, COLLECTIONS.persons), withTenant(data));
      personId = ref.id;
    }

    // Keep related_persons bidirectional — each linked profile also points back
    for (const relId of (data.related_persons || [])) {
      try {
        const relSnap = await getDoc(doc(db, COLLECTIONS.persons, relId));
        if (relSnap.exists()) {
          const existing = relSnap.data().related_persons || [];
          if (!existing.includes(personId)) {
            await updateDoc(doc(db, COLLECTIONS.persons, relId), {
              related_persons: [...existing, personId],
              updated_at: serverTimestamp(),
            });
          }
        }
      } catch (e) { console.warn('[admin] bidirectional link failed:', e); }
    }

    // If a new cover is staged while an old one exists, queue the old one for deletion
    if (stagedCover && existingCover && !removedMediaIds.includes(existingCover.id)) {
      removedMediaIds.push(existingCover.id);
    }

    // Delete removed media docs + their storage files
    for (const mediaId of removedMediaIds) {
      try {
        const mdoc = await getDoc(personMediaDoc(personId, mediaId));
        if (mdoc.exists()) {
          const d = mdoc.data();
          if (d.storage_path) {
            try { await deleteObject(storageRef(storage, d.storage_path)); } catch {}
          }
          await deleteDoc(personMediaDoc(personId, mediaId));
        }
      } catch (e) { console.warn("[admin] media delete failed:", e); }
    }
    removedMediaIds = [];

    const totalUploads = (stagedCover ? 1 : 0) + stagedFiles.length;
    if (totalUploads > 0) {
      setFormStatus(t("status.uploading", { n: totalUploads }), "info");

      const existingSnap = await getDocs(personMediaCollection(personId));
      let order = existingSnap.size;

      if (stagedCover) {
        setProgress(0);
        const { url, path } = await uploadOne(stagedCover.file, personId, setProgress);
        await addDoc(
          personMediaCollection(personId),
          withTenant({ file_type: "photo", role: "cover", storage_url: url, storage_path: path, display_order: -1 })
        );
      }

      for (const item of stagedFiles) {
        setProgress(0);
        const { url, path } = await uploadOne(item.file, personId, setProgress);
        await addDoc(
          personMediaCollection(personId),
          withTenant({ file_type: item.type, role: "gallery", storage_url: url, storage_path: path, display_order: order++ })
        );
      }
      setProgress(100);
    }

    setStatus(t("status.savedToast", { name: `${data.first_name} ${data.last_name}` }), "success");
    resetForm();
    showSection("dashboard");
  } catch (err) {
    console.error("[admin] save failed:", err);
    setFormStatus(t("status.saveFailed", { msg: err.message || err }), "error");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    setProgress(0);
  }
}

function resetForm() {
  const form = document.getElementById("profileForm");
  if (form) form.reset();
  stagedFiles.forEach((f) => URL.revokeObjectURL(f.previewUrl));
  stagedFiles = [];
  if (stagedCover) { URL.revokeObjectURL(stagedCover.previewUrl); stagedCover = null; }
  existingCover = null;
  existingGallery = [];
  selectedBgPath = null;
  removedMediaIds = [];
  editingPersonId = null;
  renderPreviews();
  renderCoverPreview();
  renderBgPicker();
  editingPerson = null;
  selectedRelated = [];
  renderFamilySelected();
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.textContent = t("btn.saveProfile");
  const formTitle = document.getElementById("formTitle");
  if (formTitle) formTitle.textContent = t("formTitle.new");
  updatePlotPreview();
  clearFormStatus();
}

async function loadForEdit(person) {
  editingPersonId = person.id;
  editingPerson = person;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || "";
  };
  set("firstName",      person.first_name);
  set("lastName",       person.last_name);
  set("firstNameKana",  person.first_name_kana);
  set("lastNameKana",   person.last_name_kana);
  set("kaimyo",         person.kaimyo || person.posthumous_name);
  set("birthDate",      person.birth_date);
  set("deathDate",      person.death_date);
  set("manualAge",      person.manual_age != null ? String(person.manual_age) : "");
  set("plotSection",    person.plot_section);
  set("plotRow",        person.plot_row);
  set("biography",      person.biography);
  updatePlotPreview();
  selectedBgPath = person.background_path || null;
  renderBgPicker();

  // Restore family links
  selectedRelated = (person.related_persons || [])
    .map((id) => allProfiles.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => ({ id: p.id, first_name: p.first_name, last_name: p.last_name, kaimyo: p.kaimyo || p.posthumous_name || "" }));
  renderFamilySelected();

  // Reset media state
  if (stagedCover) { URL.revokeObjectURL(stagedCover.previewUrl); stagedCover = null; }
  stagedFiles.forEach((f) => URL.revokeObjectURL(f.previewUrl));
  stagedFiles = [];
  existingCover = null;
  existingGallery = [];
  removedMediaIds = [];
  renderCoverPreview();
  renderPreviews();

  // Load existing media from Firestore subcollection
  try {
    const mediaSnap = await getDocs(personMediaCollection(person.id));
    for (const mdoc of mediaSnap.docs) {
      const d = { id: mdoc.id, ...mdoc.data() };
      if (d.role === "cover") {
        existingCover = d;
      } else {
        existingGallery.push(d);
      }
    }
    existingGallery.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
    renderCoverPreview();
    renderPreviews();
  } catch (err) {
    console.warn("[admin] loadForEdit media failed:", err);
  }

  const name = `${person.first_name} ${person.last_name}`;
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.textContent = t("btn.updateProfile");
  const formTitle = document.getElementById("formTitle");
  if (formTitle) formTitle.textContent = t("formTitle.edit", { name });

  setFormStatus(t("status.editing", { name }), "info");
  // The page itself doesn't scroll — the .content pane does.
  document.querySelector(".content")?.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Confirm dialog (replaces native confirm) ─────────────────────────────────

function confirmDialog({ title, body, confirmLabel, danger = true }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-dialog" role="alertdialog" aria-modal="true">
        <h3 class="confirm-title">${esc(title)}</h3>
        <p class="confirm-body">${esc(body).replaceAll("\n", "<br>")}</p>
        <div class="confirm-actions">
          <button type="button" class="btn-secondary" data-confirm="no">${t("btn.cancel")}</button>
          <button type="button" class="${danger ? "btn-danger" : "btn"}" data-confirm="yes">${esc(confirmLabel)}</button>
        </div>
      </div>`;

    function close(answer) {
      overlay.classList.add("closing");
      setTimeout(() => { overlay.remove(); resolve(answer); }, 140);
    }

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
      const btn = e.target.closest("[data-confirm]");
      if (btn) close(btn.dataset.confirm === "yes");
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(false); }
    });

    document.body.appendChild(overlay);
    overlay.querySelector('[data-confirm="no"]')?.focus();
  });
}

async function deleteProfile(person) {
  const name = `${person.first_name} ${person.last_name}`;
  const ok = await confirmDialog({
    title: t("confirm.deleteTitle"),
    body: t("confirm.delete", { name }),
    confirmLabel: t("btn.confirmDelete"),
  });
  if (!ok) return;

  setStatus(t("status.deleting"), "info");

  // Clean up subcollection media first — failures here don't block person deletion.
  try {
    const media = await getDocs(personMediaCollection(person.id));
    for (const m of media.docs) {
      const d = m.data();
      if (d.storage_path) {
        try { await deleteObject(storageRef(storage, d.storage_path)); } catch {}
      }
      await deleteDoc(personMediaDoc(person.id, m.id));
    }
  } catch (mediaErr) {
    console.warn("[admin] media cleanup skipped:", mediaErr.message);
  }

  // Detach from the family so nothing dangles: strip this person's id out of
  // every relative's related_persons and out of any family record's member_ids.
  // arrayRemove is atomic (no read, no clobber). Non-blocking, like media above.
  try {
    for (const rid of (person.related_persons || [])) {
      await updateDoc(doc(db, COLLECTIONS.persons, rid), {
        related_persons: arrayRemove(person.id),
        updated_at: serverTimestamp(),
      });
    }
    for (const fam of familyRecords) {
      if ((fam.member_ids || []).includes(person.id)) {
        await updateDoc(doc(db, COLLECTIONS.families, fam.id), {
          member_ids: arrayRemove(person.id),
          updated_at: serverTimestamp(),
        });
      }
    }
  } catch (linkErr) {
    console.warn("[admin] family link cleanup skipped:", linkErr.message);
  }

  // Always delete the person document.
  try {
    await deleteDoc(doc(db, COLLECTIONS.persons, person.id));
    setStatus(t("status.deletedToast", { name: `${person.first_name} ${person.last_name}` }), "success");
    allProfiles = allProfiles.filter((p) => p.id !== person.id);
    dashboardPersons = dashboardPersons.filter((p) => p.id !== person.id);
    // Mirror the link cleanup in-memory so the family/individual views are
    // immediately correct (e.g. a relative left with no links becomes solo).
    for (const p of dashboardPersons) {
      if (p.related_persons?.includes(person.id)) {
        p.related_persons = p.related_persons.filter((id) => id !== person.id);
      }
    }
    for (const fam of familyRecords) {
      if (fam.member_ids?.includes(person.id)) {
        fam.member_ids = fam.member_ids.filter((id) => id !== person.id);
      }
    }
    recomputeEntityIds();
    // Delete can be triggered from either Search tab — refresh both so the
    // removed row disappears immediately regardless of which one is showing.
    renderFamilyIndividualPanel();
    updateSearchTabCounts();
  } catch (err) {
    console.error("[admin] delete failed:", err);
    setStatus(t("status.deleteFailed", { msg: err.message }), "error");
  }
}

// ── File staging / upload ────────────────────────────────────────────────────

// ── Background presets ───────────────────────────────────────────────────────
// Backgrounds are 5 images shared across every profile, not an upload per
// person. They live once at Storage path individuals_backgrounds/background{1..5}.{ext}
// so every tenant uses the same set with a single upload — but a tenant can
// still get its own distinct set later, with no code change, by uploading to
// {TENANT_ID}/backgrounds/background{n}.{ext} instead; that path is checked
// first and wins over the shared one when present.

const BG_PRESET_COUNT = 5;
const BG_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

async function resolveBgPreset(n) {
  for (const base of [`${TENANT_ID}/backgrounds`, `individuals_backgrounds`]) {
    for (const ext of BG_EXTENSIONS) {
      const path = `${base}/background${n}.${ext}`;
      try {
        const url = await getDownloadURL(storageRef(storage, path));
        return { path, url };
      } catch (_) { /* try next extension / fall back to shared */ }
    }
  }
  return null;
}

async function loadBgPresets() {
  const found = await Promise.all(
    Array.from({ length: BG_PRESET_COUNT }, (_, i) => i + 1).map(resolveBgPreset)
  );
  bgPresets = found.filter(Boolean);
  renderBgPicker();
}

function renderBgPicker() {
  const wrap = document.getElementById("bgPicker");
  if (!wrap) return;

  if (!bgPresets.length) {
    wrap.innerHTML = `<p class="field-hint">${t("bg.noneUploaded")}</p>`;
    return;
  }

  const noneBtn = `
    <button type="button" class="bg-picker-item bg-picker-none${selectedBgPath ? "" : " selected"}" data-path="">
      <span>${t("bg.none")}</span>
    </button>`;

  const items = bgPresets.map((p) => `
    <button type="button" class="bg-picker-item${selectedBgPath === p.path ? " selected" : ""}" data-path="${p.path}" style="background-image:url('${p.url}')" aria-label="${p.path}"></button>`).join("");

  wrap.innerHTML = noneBtn + items;

  wrap.querySelectorAll(".bg-picker-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedBgPath = btn.dataset.path || null;
      renderBgPicker();
    });
  });
}

function classifyFile(file) {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "photo";
}

function stageCover(file) {
  if (stagedCover) URL.revokeObjectURL(stagedCover.previewUrl);
  stagedCover = { file, previewUrl: URL.createObjectURL(file) };
  renderCoverPreview();
}

function stageFiles(fileList) {
  for (const file of fileList) {
    stagedFiles.push({ file, type: classifyFile(file), previewUrl: URL.createObjectURL(file) });
  }
  renderPreviews();
}

function renderCoverPreview() {
  const wrap = document.getElementById("coverPreview");
  if (!wrap) return;
  wrap.innerHTML = "";

  if (stagedCover) {
    const img = Object.assign(document.createElement("img"), {
      src: stagedCover.previewUrl, alt: "Cover preview", className: "cover-thumb",
    });
    const remove = Object.assign(document.createElement("button"), {
      className: "cover-remove", type: "button", textContent: "✕ Remove",
    });
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(stagedCover.previewUrl);
      stagedCover = null;
      renderCoverPreview();
    });
    wrap.append(img, remove);
  } else if (existingCover) {
    const img = Object.assign(document.createElement("img"), {
      src: existingCover.storage_url, alt: "Cover photo", className: "cover-thumb",
    });
    const remove = Object.assign(document.createElement("button"), {
      className: "cover-remove", type: "button", textContent: "✕ Remove",
    });
    remove.addEventListener("click", () => {
      removedMediaIds.push(existingCover.id);
      existingCover = null;
      renderCoverPreview();
    });
    wrap.append(img, remove);
  }
}

function renderPreviews() {
  const wrap = document.getElementById("mediaPreview");
  if (!wrap) return;
  wrap.innerHTML = "";

  // Existing saved gallery items
  existingGallery.forEach((item) => {
    const thumb = document.createElement("div");
    thumb.className = "media-thumb";

    const mediaEl = item.file_type === "video"
      ? Object.assign(document.createElement("video"), { src: item.storage_url, muted: true })
      : item.file_type === "audio"
      ? Object.assign(document.createElement("audio"), { src: item.storage_url, controls: true })
      : Object.assign(document.createElement("img"),  { src: item.storage_url, alt: "Gallery" });

    const badge  = Object.assign(document.createElement("span"), { className: "badge", textContent: item.file_type });
    const remove = Object.assign(document.createElement("button"), { className: "remove", type: "button", textContent: "✕" });
    remove.addEventListener("click", () => {
      removedMediaIds.push(item.id);
      existingGallery = existingGallery.filter((i) => i.id !== item.id);
      renderPreviews();
    });

    thumb.append(mediaEl, badge, remove);
    wrap.appendChild(thumb);
  });

  // Newly staged files (not yet uploaded)
  stagedFiles.forEach((item, i) => {
    const thumb = document.createElement("div");
    thumb.className = "media-thumb";

    const mediaEl =
      item.type === "video"
        ? Object.assign(document.createElement("video"), { src: item.previewUrl, muted: true })
        : item.type === "audio"
        ? Object.assign(document.createElement("audio"), { src: item.previewUrl, controls: true })
        : Object.assign(document.createElement("img"),   { src: item.previewUrl, alt: "Preview" });

    const badge  = Object.assign(document.createElement("span"), { className: "badge", textContent: item.type });
    const remove = Object.assign(document.createElement("button"), { className: "remove", type: "button", textContent: "✕" });
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(item.previewUrl);
      stagedFiles.splice(i, 1);
      renderPreviews();
    });

    thumb.append(mediaEl, badge, remove);
    wrap.appendChild(thumb);
  });
}

function uploadOne(file, personId, onProgress) {
  return new Promise((resolve, reject) => {
    const safeName = `${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
    const path = `${TENANT_ID}/${personId}/${safeName}`;
    const task = uploadBytesResumable(storageRef(storage, path), file);

    task.on(
      "state_changed",
      (snap) => onProgress && onProgress((snap.bytesTransferred / snap.totalBytes) * 100),
      reject,
      async () => {
        try { resolve({ url: await getDownloadURL(task.snapshot.ref), path }); }
        catch (e) { reject(e); }
      }
    );
  });
}

function setProgress(pct) {
  const bar  = document.getElementById("progressBar");
  const wrap = document.getElementById("uploadProgress");
  if (!bar || !wrap) return;
  bar.style.width = `${Math.round(pct)}%`;
  pct > 0 ? wrap.classList.remove("hidden") : wrap.classList.add("hidden");
}

// ── Utility helpers ──────────────────────────────────────────────────────────

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ── Language ─────────────────────────────────────────────────────────────────

function syncLangButtons() {
  document.querySelectorAll("#langSwitch [data-lang]").forEach((b) =>
    b.classList.toggle("active", b.dataset.lang === getLang())
  );
}

/** Re-translate everything that JS rendered when the language changes. */
function retranslateDynamic() {
  syncLangButtons();
  setText("pageTitle", currentPageTitle());
  setText("pageSubtitle", currentSection === "dashboard" ? t(`sub.${activeSearchTab}`) : t(`sub.${currentSection}`));

  // Form chrome reflects whether we're editing
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.textContent = editingPersonId ? t("btn.updateProfile") : t("btn.saveProfile");
  const formTitle = document.getElementById("formTitle");
  if (formTitle) {
    formTitle.textContent = editingPerson
      ? t("formTitle.edit", { name: `${editingPerson.first_name} ${editingPerson.last_name}` })
      : t("formTitle.new");
  }

  // Re-render data views currently on screen
  if (currentSection === "dashboard") {
    renderFamilyIndividualPanel();
    updateSearchTabCounts();
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

export function initAdminPortal() {
  // Auth guard — redirect to login if not signed in
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      window.location.href = "login.html";
    }
  });

  // Sign out button
  document.getElementById("signOutBtn")?.addEventListener("click", async () => {
    sessionStorage.clear();
    await signOut(auth);
    window.location.href = "login.html";
  });

  // Language: apply saved choice + wire the EN / 日本語 switch
  document.documentElement.lang = getLang();
  applyStaticI18n();
  syncLangButtons();
  document.getElementById("langSwitch")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-lang]");
    if (!btn || btn.dataset.lang === getLang()) return;
    setLang(btn.dataset.lang);
  });
  onLangChange(retranslateDynamic);

  // Memorial site name — shown in the top bar next to the page title so the
  // admin always knows which site they're managing. Prefer the tenant's real
  // display name from its config doc (so renaming the tenant updates this
  // everywhere); until that resolves, fall back to prettifying the slug
  // ("tokyo_reien" → "Tokyo Reien").
  const prettySite = (TENANT_ID || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "—";

  const siteEl = document.getElementById("pageSite");
  if (siteEl) {
    siteEl.textContent = prettySite;
    siteEl.title = TENANT_ID;
    getDoc(doc(db, COLLECTIONS.tenants, TENANT_ID))
      .then((snap) => {
        const name = snap.exists() ? (snap.data().name || "").trim() : "";
        if (name) { siteEl.textContent = name; siteEl.title = name; }
      })
      .catch(() => {});
  }

  // Sidebar nav
  document.querySelectorAll("[data-section]").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.dataset.section === "new-profile") resetForm();
      // A deliberate click on "Search" always lands on the Family tab first —
      // a family drilled into on an earlier visit shouldn't linger.
      if (el.dataset.section === "dashboard") switchSearchTab("family");
      showSection(el.dataset.section);
    });
  });

  // Search tabs — Family groups shown first, Individuals second
  document.querySelectorAll(".search-tab").forEach((btn) => {
    btn.addEventListener("click", () => switchSearchTab(btn.dataset.tab));
  });

  // Profiles section "New Profile" button
  document.getElementById("addProfileBtn")?.addEventListener("click", () => {
    resetForm();
    showSection("new-profile");
  });

  // Dashboard family/individual panel search
  document.getElementById("familySearchInput")?.addEventListener("input", renderFamilyIndividualPanel);
  document.getElementById("individualSearchInput")?.addEventListener("input", renderFamilyIndividualPanel);

  // Form submit
  document.getElementById("profileForm")?.addEventListener("submit", handleSave);

  // Live plot label preview
  document.getElementById("plotSection")?.addEventListener("input", updatePlotPreview);
  document.getElementById("plotRow")?.addEventListener("input", updatePlotPreview);
  updatePlotPreview();

  // Cover photo dropzone
  const dropzoneCover = document.getElementById("dropzoneCover");
  const fileInputCover = document.getElementById("fileInputCover");
  if (dropzoneCover && fileInputCover) {
    fileInputCover.addEventListener("click", (e) => e.stopPropagation());
    dropzoneCover.addEventListener("click", () => fileInputCover.click());
    fileInputCover.addEventListener("change", (e) => {
      if (e.target.files[0]) stageCover(e.target.files[0]);
      fileInputCover.value = "";
    });
    ["dragenter", "dragover"].forEach((ev) =>
      dropzoneCover.addEventListener(ev, (e) => { e.preventDefault(); dropzoneCover.classList.add("dragover"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dropzoneCover.addEventListener(ev, (e) => { e.preventDefault(); dropzoneCover.classList.remove("dragover"); })
    );
    dropzoneCover.addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) stageCover(file);
    });
  }

  // Background presets — this tenant's 5 shared backgrounds, loaded once
  loadBgPresets();

  // Gallery dropzone
  const dropzone  = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  if (dropzone && fileInput) {
    fileInput.addEventListener("click", (e) => e.stopPropagation());
    dropzone.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", (e) => { stageFiles(e.target.files); fileInput.value = ""; });
    ["dragenter", "dragover"].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); })
    );
    dropzone.addEventListener("drop", (e) => {
      if (e.dataTransfer?.files?.length) stageFiles(e.dataTransfer.files);
    });
  }

  // Family picker — pre-load profiles so search works on first use
  getDocs(tenantQuery(COLLECTIONS.persons)).then((snap) => {
    allProfiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }).catch(() => {});
  initFamilyPicker();
  initFamilyBuilder();

  // Load initial section — land on New Profile rather than the dashboard.
  showSection("new-profile");
}

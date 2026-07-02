// admin.js — SmartSenior admin portal: dashboard, profile management, media upload.

import {
  db,
  storage,
  auth,
  onAuthStateChanged,
  signOut,
  ROLE,
  DISPLAY_NAME,
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
  storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  COLLECTIONS,
  TENANT_ID,
  personMediaCollection,
  personMediaDoc,
} from "./firebase.js?v=3";
import { t, getLang, setLang, applyStaticI18n, onLangChange } from "./i18n.js?v=3";

// ── State ───────────────────────────────────────────────────────────────────

let stagedFiles = [];       // { file, type, previewUrl } — new gallery uploads
let stagedCover = null;    // { file, previewUrl } — new cover upload
let existingCover = null;  // { id, storage_url, storage_path } — loaded from Firestore
let existingGallery = [];  // [{ id, storage_url, storage_path, file_type }] — loaded from Firestore
let removedMediaIds = [];  // Firestore media doc IDs queued for deletion on save
let stagedBg = null;       // { file, previewUrl } — new background upload
let existingBgUrl = null;  // string URL stored on person doc
let existingBgPath = null; // string Storage path for deletion
let editingPersonId = null;
let editingPerson = null;   // full person object while editing (for re-translation)
let allProfiles = [];       // cached for client-side filtering
let currentSection = "dashboard";
let sortField = "last_name"; // last_name | first_name | death_date | created_at
let sortDir   = "asc";       // asc | desc
let selectedRelated = [];   // array of { id, first_name, last_name }

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

  // Close mobile sidebar
  document.getElementById("sidebar")?.classList.remove("open");

  // Lazy-load sections
  if (name === "dashboard") loadDashboard();
  if (name === "profiles") loadProfileList();

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
      showSection("new-profile", { activeNav: "profiles", personId: person.id, skipPush: true });
      return;
    }
  }

  if (state.section === "new-profile" && !state.personId) resetForm();
  showSection(state.section || "dashboard", { activeNav: state.activeNav, skipPush: true });
});

// ── Status helpers ───────────────────────────────────────────────────────────

function setStatus(msg, kind = "info") {
  const el = document.getElementById("topStatus");
  if (!el) return;
  el.className = `top-status ${kind}`;
  el.textContent = msg;
  el.classList.remove("hidden");
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

// ── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const personSnap = await getDocs(tenantQuery(COLLECTIONS.persons));
    const persons = personSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Stat cards
    setText("statProfiles", personSnap.size);

    // Recent profiles (newest first by created_at)
    const sorted = [...persons].sort((a, b) => {
      const at = a.created_at?.seconds ?? 0;
      const bt = b.created_at?.seconds ?? 0;
      return bt - at;
    });
    renderRecentProfiles(sorted.slice(0, 5));
  } catch (err) {
    console.error("[dashboard] load failed:", err);
    if (err.message?.includes("index")) {
      setStatus(t("status.indexNeeded"), "error");
    }
  }
}

// ── Recent profiles (dashboard mini-table) ────────────────────────────────────

function renderRecentProfiles(persons) {
  const wrap = document.getElementById("recentProfiles");
  if (!wrap) return;

  if (!persons.length) {
    wrap.innerHTML = `<p class="empty-state">${t("empty.noProfilesCreate")}</p>`;
    wireNavButtons(wrap);
    return;
  }

  wrap.innerHTML = `
    <table class="mini-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Dates</th>
          <th>Plot</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${persons.map((p) => profileRow(p)).join("")}
      </tbody>
    </table>`;

  wireProfileActions(wrap, persons);
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

async function loadProfileList() {
  const wrap = document.getElementById("profileTable");
  if (!wrap) return;
  wrap.innerHTML = '<div class="spinner"></div>';

  try {
    // No orderBy in Firestore query — avoids requiring a composite index.
    // Sorting is done client-side so profiles always load even without indexes.
    const snap = await getDocs(tenantQuery(COLLECTIONS.persons));
    allProfiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderProfileTable(allProfiles);
  } catch (err) {
    console.error("[profiles] list failed:", err);
    wrap.innerHTML = `<p class="empty-state" style="color:var(--color-danger)">${t("empty.loadFail")}</p>`;
  }
}

function sortIcon(field) {
  if (sortField !== field) return '<span class="sort-icon">↕</span>';
  return `<span class="sort-icon active">${sortDir === "asc" ? "↑" : "↓"}</span>`;
}

function renderProfileTable(persons) {
  const wrap = document.getElementById("profileTable");
  if (!wrap) return;

  if (!persons.length) {
    wrap.innerHTML = `<p class="empty-state">${t("empty.noProfiles")}</p>`;
    return;
  }

  const sorted = sortProfiles(persons);

  wrap.innerHTML = `
    <div class="profiles-table-wrap">
      <table class="profiles-table">
        <thead>
          <tr>
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

  // Sortable column headers
  wrap.querySelectorAll("th.sortable").forEach((th) => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const field = th.dataset.sort;
      if (sortField === field) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortField = field;
        sortDir = "asc";
      }
      renderProfileTable(persons);
    });
  });

  wireProfileActions(wrap);
}

function profileRow(p, full = false) {
  const initials = ((p.last_name || "").charAt(0) + (p.first_name || "").charAt(0)).toUpperCase() || "✦";
  const birth = (p.birth_date || "").slice(0, 4) || "—";
  const death = (p.death_date || "").slice(0, 4) || "—";

  if (full) {
    return `
      <tr data-id="${p.id}">
        <td>
          <div class="avatar-cell">
            <div class="avatar">${initials}</div>
            <div>
              <div class="profile-name">${p.last_name || "—"}</div>
              ${p.family_name ? `<div class="profile-meta">${p.family_name}</div>` : ""}
            </div>
          </div>
        </td>
        <td>${p.first_name || "—"}</td>
        <td>${death}</td>
        <td>${p.plot_section || "—"}</td>
        <td>${p.plot_row || "—"}</td>
        <td>
          <div class="table-actions">
            <button class="btn-secondary" data-action="qr"     data-id="${p.id}" data-name="${(p.last_name || p.first_name || '').replace(/"/g,'&quot;')}" title="QR Code">QR</button>
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
          <div class="avatar">${initials}</div>
          <div class="profile-name">${p.last_name || ""} ${p.first_name || ""}</div>
        </div>
      </td>
      <td>${birth} – ${death}</td>
      <td>${p.plot || "—"}</td>
      <td>
        <div class="table-actions">
          <button class="btn-secondary" data-action="edit" data-id="${p.id}">Edit</button>
          <button class="btn-danger"    data-action="delete" data-id="${p.id}">Delete</button>
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
      if (action === "edit"   && person) { loadForEdit(person); showSection("new-profile", { activeNav: "profiles", personId: person.id }); }
      if (action === "delete" && person) await deleteProfile(person);
    });
  });
}

// ── QR Code modal ────────────────────────────────────────────────────────────

function showQrModal(person) {
  const tenantId = TENANT_ID || '';
  const url = `https://kiosk.saidans.org/family.html?person=${encodeURIComponent(person.id)}&site=${encodeURIComponent(tenantId)}`;
  const familyLabel = person.last_name ? `${person.last_name}家` : (person.first_name || 'Family');

  document.getElementById('qrFamilyLabel').textContent = familyLabel;
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
    win.document.write(`<!DOCTYPE html><html><head><title>${familyLabel} QR</title>
      <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;gap:16px}
      h1{font-size:1.8rem;margin:0}p{color:#888;font-size:0.75rem;word-break:break-all;max-width:280px;text-align:center}</style>
      </head><body>
      <h1>${familyLabel}</h1>
      <img src="${canvas.toDataURL()}" width="240" height="240" />
      <p>${url}</p>
      <script>window.onload=()=>{window.print();}<\/script>
      </body></html>`);
    win.document.close();
  };

  document.getElementById('qrDownloadBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `${familyLabel}-qr.png`;
    a.click();
  };
}

// ── Profile form ─────────────────────────────────────────────────────────────

function readForm() {
  const get = (id) => (document.getElementById(id)?.value || "").trim();
  const section = get("plotSection");
  const row     = get("plotRow");
  const plot    = [section, row].filter(Boolean).join("-");
  return {
    first_name: get("firstName"),
    last_name: get("lastName"),
    family_name: get("familyName"),
    kaimyo: get("kaimyo"),
    birth_date: get("birthDate"),
    death_date: get("deathDate"),
    plot_section: section,
    plot_row: row,
    plot,          // combined for backward-compat display/search
    biography: get("biography"),
    presentation_url: get("presentationUrl"),
    related_persons: selectedRelated.map((p) => p.id),
  };
}

// ── Family picker ─────────────────────────────────────────────────────────────

function renderFamilySelected() {
  const list = document.getElementById("familySelected");
  if (!list) return;
  list.innerHTML = selectedRelated.map((p) => `
    <li class="family-tag">
      <span>${p.first_name} ${p.last_name}</span>
      <button type="button" class="family-tag-remove" data-id="${p.id}">✕</button>
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

  input.addEventListener("input", () => {
    const q = input.value.toLowerCase().trim();
    if (!q) { suggestions.classList.add("hidden"); return; }

    const matches = allProfiles.filter((p) => {
      if (p.id === editingPersonId) return false;
      if (selectedRelated.find((r) => r.id === p.id)) return false;
      return `${p.first_name} ${p.last_name}`.toLowerCase().includes(q);
    }).slice(0, 6);

    if (!matches.length) { suggestions.classList.add("hidden"); return; }

    suggestions.innerHTML = matches.map((p) => `
      <li class="family-suggestion-item" data-id="${p.id}">
        ${p.first_name} ${p.last_name}${p.death_date ? ` (${p.death_date.slice(0,4)})` : ""}
      </li>`).join("");
    suggestions.classList.remove("hidden");

    suggestions.querySelectorAll(".family-suggestion-item").forEach((item) => {
      item.addEventListener("click", () => {
        const p = allProfiles.find((x) => x.id === item.dataset.id);
        if (p && !selectedRelated.find((r) => r.id === p.id)) {
          selectedRelated.push({ id: p.id, first_name: p.first_name, last_name: p.last_name });
          renderFamilySelected();
        }
        input.value = "";
        suggestions.classList.add("hidden");
      });
    });
  });

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !suggestions.contains(e.target)) {
      suggestions.classList.add("hidden");
    }
  });
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

    // Background image — upload new or delete removed
    if (stagedBg) {
      if (existingBgPath) {
        try { await deleteObject(storageRef(storage, existingBgPath)); } catch {}
      }
      setProgress(0);
      const { url, path } = await uploadOne(stagedBg.file, personId, setProgress);
      await updateDoc(doc(db, COLLECTIONS.persons, personId), {
        background_url: url,
        background_path: path,
      });
    } else if (existingBgPath && !existingBgUrl) {
      try { await deleteObject(storageRef(storage, existingBgPath)); } catch {}
      await updateDoc(doc(db, COLLECTIONS.persons, personId), {
        background_url: null,
        background_path: null,
      });
    }

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
    await loadProfileList();
    showSection("profiles");
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
  if (stagedBg)    { URL.revokeObjectURL(stagedBg.previewUrl);    stagedBg = null; }
  existingCover = null;
  existingGallery = [];
  existingBgUrl = null;
  existingBgPath = null;
  removedMediaIds = [];
  editingPersonId = null;
  renderPreviews();
  renderCoverPreview();
  renderBgPreview();
  editingPerson = null;
  selectedRelated = [];
  renderFamilySelected();
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.textContent = t("btn.saveProfile");
  const formTitle = document.getElementById("formTitle");
  if (formTitle) formTitle.textContent = t("formTitle.new");
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
  set("familyName",     person.family_name);
  set("kaimyo",         person.kaimyo || person.posthumous_name);
  set("birthDate",      person.birth_date);
  set("deathDate",      person.death_date);
  set("plotSection",    person.plot_section);
  set("plotRow",        person.plot_row);
  set("biography",      person.biography);
  set("presentationUrl", person.presentation_url);
  existingBgUrl  = person.background_url  || null;
  existingBgPath = person.background_path || null;

  // Restore family links
  selectedRelated = (person.related_persons || [])
    .map((id) => allProfiles.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => ({ id: p.id, first_name: p.first_name, last_name: p.last_name }));
  renderFamilySelected();

  // Reset media state
  if (stagedCover) { URL.revokeObjectURL(stagedCover.previewUrl); stagedCover = null; }
  if (stagedBg)    { URL.revokeObjectURL(stagedBg.previewUrl);    stagedBg = null; }
  stagedFiles.forEach((f) => URL.revokeObjectURL(f.previewUrl));
  stagedFiles = [];
  existingCover = null;
  existingGallery = [];
  removedMediaIds = [];
  renderCoverPreview();
  renderBgPreview();
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
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteProfile(person) {
  const name = `${person.first_name} ${person.last_name}`;
  if (!confirm(t("confirm.delete", { name }))) return;

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

  // Always delete the person document.
  try {
    await deleteDoc(doc(db, COLLECTIONS.persons, person.id));
    setStatus(t("status.deletedToast", { name: `${person.first_name} ${person.last_name}` }), "success");
    allProfiles = allProfiles.filter((p) => p.id !== person.id);
    renderProfileTable(allProfiles);
    loadDashboard();
  } catch (err) {
    console.error("[admin] delete failed:", err);
    setStatus(t("status.deleteFailed", { msg: err.message }), "error");
  }
}

// ── File staging / upload ────────────────────────────────────────────────────

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

function stageBg(file) {
  if (stagedBg) URL.revokeObjectURL(stagedBg.previewUrl);
  stagedBg = { file, previewUrl: URL.createObjectURL(file) };
  renderBgPreview();
}

function stageFiles(fileList) {
  for (const file of fileList) {
    stagedFiles.push({ file, type: classifyFile(file), previewUrl: URL.createObjectURL(file) });
  }
  renderPreviews();
}

function renderBgPreview() {
  const wrap = document.getElementById("bgPreview");
  if (!wrap) return;
  wrap.innerHTML = "";

  if (stagedBg) {
    const img = Object.assign(document.createElement("img"), {
      src: stagedBg.previewUrl, alt: "Background preview", className: "cover-thumb",
    });
    const remove = Object.assign(document.createElement("button"), {
      className: "cover-remove", type: "button", textContent: "✕ Remove",
    });
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(stagedBg.previewUrl);
      stagedBg = null;
      renderBgPreview();
    });
    wrap.append(img, remove);
  } else if (existingBgUrl) {
    const img = Object.assign(document.createElement("img"), {
      src: existingBgUrl, alt: "Background image", className: "cover-thumb",
    });
    const remove = Object.assign(document.createElement("button"), {
      className: "cover-remove", type: "button", textContent: "✕ Remove",
    });
    remove.addEventListener("click", () => {
      existingBgUrl = null;
      renderBgPreview();
    });
    wrap.append(img, remove);
  }
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

function wireNavButtons(container) {
  container.querySelectorAll("[data-section]").forEach((el) => {
    el.addEventListener("click", () => showSection(el.dataset.section));
  });
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
  setText("sidebarRole", ROLE === "superadmin" ? t("role.superadmin") : t("role.admin"));

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
  if (currentSection === "dashboard") loadDashboard();
  if (currentSection === "profiles") renderProfileTable(allProfiles);
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

  // Sidebar user info
  setText("tenantBadge", TENANT_ID);
  setText("sidebarUser", DISPLAY_NAME);
  setText("sidebarRole", ROLE === "superadmin" ? t("role.superadmin") : t("role.admin"));

  // Sidebar nav
  document.querySelectorAll("[data-section]").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.dataset.section === "new-profile") resetForm();
      showSection(el.dataset.section);
    });
  });

  // Mobile sidebar toggle
  document.getElementById("menuToggle")?.addEventListener("click", () => {
    document.getElementById("sidebar")?.classList.toggle("open");
  });

  // Top-bar "New Profile" button
  document.getElementById("newProfileBtn")?.addEventListener("click", () => {
    resetForm();
    showSection("new-profile");
  });

  // Profiles section "New Profile" button
  document.getElementById("addProfileBtn")?.addEventListener("click", () => {
    resetForm();
    showSection("new-profile");
  });

  // Profiles section refresh
  document.getElementById("refreshBtn")?.addEventListener("click", loadProfileList);

  // Client-side name filter
  document.getElementById("profileSearch")?.addEventListener("input", (e) => {
    const q = e.target.value.toLowerCase();
    const filtered = q
      ? allProfiles.filter((p) =>
          `${p.first_name} ${p.last_name} ${p.family_name || ""}`.toLowerCase().includes(q)
        )
      : allProfiles;
    renderProfileTable(filtered);
  });

  // Form submit / reset
  document.getElementById("profileForm")?.addEventListener("submit", handleSave);
  document.getElementById("resetBtn")?.addEventListener("click", resetForm);

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

  // Background image dropzone
  const dropzoneBg  = document.getElementById("dropzoneBg");
  const fileInputBg = document.getElementById("fileInputBg");
  if (dropzoneBg && fileInputBg) {
    fileInputBg.addEventListener("click", (e) => e.stopPropagation());
    dropzoneBg.addEventListener("click", () => fileInputBg.click());
    fileInputBg.addEventListener("change", (e) => {
      if (e.target.files[0]) stageBg(e.target.files[0]);
      fileInputBg.value = "";
    });
    ["dragenter", "dragover"].forEach((ev) =>
      dropzoneBg.addEventListener(ev, (e) => { e.preventDefault(); dropzoneBg.classList.add("dragover"); })
    );
    ["dragleave", "drop"].forEach((ev) =>
      dropzoneBg.addEventListener(ev, (e) => { e.preventDefault(); dropzoneBg.classList.remove("dragover"); })
    );
    dropzoneBg.addEventListener("drop", (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("image/")) stageBg(file);
    });
  }

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

  // Load initial section
  showSection("dashboard");
}

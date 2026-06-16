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
  orderBy,
  limit,
  tenantQuery,
  withTenant,
  serverTimestamp,
  storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  COLLECTIONS,
  TENANT_ID,
} from "./firebase.js";
import { t, getLang, setLang, applyStaticI18n, onLangChange } from "./i18n.js";

// ── State ───────────────────────────────────────────────────────────────────

let stagedFiles = [];       // { file, type, previewUrl } — gallery
let stagedCover = null;    // { file, previewUrl } — cover photo
let editingPersonId = null;
let editingPerson = null;   // full person object while editing (for re-translation)
let activeChart = null;     // Chart.js instance
let allProfiles = [];       // cached for client-side filtering
let currentSection = "dashboard";
let sortField = "last_name"; // last_name | first_name | death_date | created_at
let sortDir   = "asc";       // asc | desc
let selectedRelated = [];   // array of { id, first_name, last_name }

/** Localized label for a kiosk event type. */
function eventLabel(type) {
  return t(`event.${type}`);
}

// ── Section navigation ───────────────────────────────────────────────────────

function showSection(name) {
  currentSection = name;
  document.querySelectorAll(".section").forEach((s) => s.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));

  const sec = document.getElementById(`sec-${name}`);
  if (sec) sec.classList.add("active");

  document.querySelectorAll(`[data-section="${name}"]`).forEach((el) =>
    el.classList.add("active")
  );

  const titleEl = document.getElementById("pageTitle");
  if (titleEl) titleEl.textContent = t(`section.${name}`);

  // Close mobile sidebar
  document.getElementById("sidebar")?.classList.remove("open");

  // Lazy-load sections
  if (name === "dashboard") loadDashboard();
  if (name === "profiles") loadProfileList();
}

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
    const [personSnap, mediaSnap, eventSnap] = await Promise.all([
      getDocs(tenantQuery(COLLECTIONS.persons)),
      getDocs(tenantQuery(COLLECTIONS.media)),
      getDocs(
        tenantQuery(COLLECTIONS.events, orderBy("timestamp", "desc"), limit(200))
      ).catch(() => ({ docs: [] })),
    ]);

    const events = eventSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const persons = personSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Stat cards
    const searches = events.filter((e) => e.event_type === "search_query").length;
    const views = events.filter((e) => e.event_type === "profile_view").length;

    setText("statProfiles", personSnap.size);
    setText("statMedia", mediaSnap.size);
    setText("statSearches", searches);
    setText("statViews", views);

    // Chart
    renderEventChart(events);

    // Activity feed
    renderActivityFeed(events.slice(0, 25), persons);

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

// ── Event chart ──────────────────────────────────────────────────────────────

const EVENT_COLORS = [
  "#3B82F6",
  "#14B8A6",
  "#8B5CF6",
  "#F97316",
  "#EAB308",
  "#10B981",
];

function renderEventChart(events) {
  const canvas = document.getElementById("eventChart");
  if (!canvas || !window.Chart) return;

  const counts = {};
  for (const e of events) {
    counts[e.event_type] = (counts[e.event_type] || 0) + 1;
  }

  const labels = Object.keys(counts).map((k) => eventLabel(k));
  const data = Object.values(counts);

  if (activeChart) activeChart.destroy();

  activeChart = new window.Chart(canvas, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          label: t("chart.events"),
          data,
          backgroundColor: EVENT_COLORS,
          borderRadius: 8,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: "y",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.parsed.x} event${ctx.parsed.x !== 1 ? "s" : ""}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(0,0,0,0.06)" },
          ticks: { color: "#6E6E73", font: { size: 12 } },
        },
        y: {
          grid: { display: false },
          ticks: { color: "#6E6E73", font: { size: 12 } },
        },
      },
    },
  });
}

// ── Activity feed ─────────────────────────────────────────────────────────────

const BADGE_CLASS = {
  search_query: "badge-search",
  profile_view: "badge-view",
  slideshow_play: "badge-slideshow",
  video_play: "badge-video",
  nfc_tap: "badge-nfc",
  qr_scan: "badge-qr",
};

function relativeTime(ts) {
  if (!ts) return "";
  const date = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function renderActivityFeed(events, persons) {
  const list = document.getElementById("activityList");
  if (!list) return;

  if (!events.length) {
    list.innerHTML = `<li class="activity-empty">${t("empty.noActivity")}</li>`;
    return;
  }

  const personMap = {};
  for (const p of persons) personMap[p.id] = `${p.first_name || ""} ${p.last_name || ""}`.trim();

  list.innerHTML = events
    .map((e) => {
      const label = eventLabel(e.event_type);
      const badge = BADGE_CLASS[e.event_type] || "";
      const name = e.person_id ? personMap[e.person_id] || e.person_id : "";
      const desc = e.query
        ? `"${e.query}"`
        : name
        ? name
        : e.device_id || "";
      return `
        <li class="activity-item">
          <span class="activity-badge ${badge}">${label}</span>
          <div class="activity-body">
            <div class="activity-desc">${desc}</div>
            <div class="activity-time">${relativeTime(e.timestamp)}</div>
          </div>
        </li>`;
    })
    .join("");
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
            <button class="btn-secondary" data-action="link" data-id="${p.id}">${t("btn.link")}</button>
            <button class="btn-secondary" data-action="edit" data-id="${p.id}">${t("btn.edit")}</button>
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
          <button class="btn-secondary" data-action="link" data-id="${p.id}">Link</button>
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

      if (action === "link") { showProfileLink(id); showSection("new-profile"); }
      if (action === "edit" && person) { loadForEdit(person); showSection("new-profile"); }
      if (action === "delete" && person) await deleteProfile(person);
    });
  });
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

    const totalUploads = (stagedCover ? 1 : 0) + stagedFiles.length;
    if (totalUploads > 0) {
      setFormStatus(t("status.uploading", { n: totalUploads }), "info");

      const existing = await getDocs(
        tenantQuery(COLLECTIONS.media, where("person_id", "==", personId))
      );
      let order = existing.size;

      if (stagedCover) {
        setProgress(0);
        const { url, path } = await uploadOne(stagedCover.file, personId, setProgress);
        await addDoc(
          collection(db, COLLECTIONS.media),
          withTenant({ person_id: personId, file_type: "photo", role: "cover", storage_url: url, storage_path: path, display_order: -1 })
        );
      }

      for (const item of stagedFiles) {
        setProgress(0);
        const { url, path } = await uploadOne(item.file, personId, setProgress);
        await addDoc(
          collection(db, COLLECTIONS.media),
          withTenant({ person_id: personId, file_type: item.type, role: "gallery", storage_url: url, storage_path: path, display_order: order++ })
        );
      }
      setProgress(100);
    }

    setFormStatus(t("status.profileSaved"), "success");
    setStatus(t("status.savedToast", { name: `${data.first_name} ${data.last_name}` }), "success");
    resetForm();
    showProfileLink(personId);
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
  editingPersonId = null;
  renderPreviews();
  renderCoverPreview();
  editingPerson = null;
  selectedRelated = [];
  renderFamilySelected();
  const saveBtn = document.getElementById("saveBtn");
  if (saveBtn) saveBtn.textContent = t("btn.saveProfile");
  const formTitle = document.getElementById("formTitle");
  if (formTitle) formTitle.textContent = t("formTitle.new");
  document.getElementById("linkBox")?.classList.add("hidden");
  clearFormStatus();
}

function loadForEdit(person) {
  editingPersonId = person.id;
  editingPerson = person;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val || "";
  };
  set("firstName",      person.first_name);
  set("lastName",       person.last_name);
  set("familyName",     person.family_name);
  set("birthDate",      person.birth_date);
  set("deathDate",      person.death_date);
  set("plotSection",    person.plot_section);
  set("plotRow",        person.plot_row);
  set("biography",      person.biography);
  set("presentationUrl", person.presentation_url);

  // Restore family links
  selectedRelated = (person.related_persons || [])
    .map((id) => allProfiles.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => ({ id: p.id, first_name: p.first_name, last_name: p.last_name }));
  renderFamilySelected();

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

  // Clean up media files first — failures here don't block person deletion.
  try {
    const media = await getDocs(
      tenantQuery(COLLECTIONS.media, where("person_id", "==", person.id))
    );
    for (const m of media.docs) {
      const d = m.data();
      if (d.storage_path) {
        try { await deleteObject(storageRef(storage, d.storage_path)); } catch {}
      }
      await deleteDoc(doc(db, COLLECTIONS.media, m.id));
    }
  } catch (mediaErr) {
    // Composite index may not exist yet — log but continue to delete the person.
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

// ── NFC / QR ─────────────────────────────────────────────────────────────────

function profileUrl(personId, via) {
  const url = new URL("../kiosk/family.html", window.location.href);
  url.searchParams.set("person", personId);
  if (via) url.searchParams.set("via", via);
  return url.href;
}

function showProfileLink(personId) {
  const box = document.getElementById("linkBox");
  const linkUrl = document.getElementById("linkUrl");
  const nfcUrl  = document.getElementById("nfcUrl");
  if (!box || !linkUrl) return;

  const qrUrl = profileUrl(personId, "qr");
  linkUrl.value = qrUrl;
  if (nfcUrl) nfcUrl.value = profileUrl(personId, "nfc");
  box.classList.remove("hidden");
  renderQrCode(qrUrl);
}

function renderQrCode(url) {
  const target = document.getElementById("qrcode");
  if (!target) return;
  target.innerHTML = "";
  if (window.QRCode) {
    new window.QRCode(target, { text: url, width: 160, height: 160 });
  } else {
    target.innerHTML = `<a href="${url}" target="_blank" rel="noopener" style="color:#0D1B2A;font-size:0.85rem;">${t("link.open")}</a>`;
  }
}

async function copyLink() {
  const field = document.getElementById("linkUrl");
  if (!field) return;
  try {
    await navigator.clipboard.writeText(field.value);
    setStatus(t("status.linkCopied"), "success");
  } catch {
    field.select();
    setStatus(t("status.pressCopy"), "info");
  }
}

// ── File staging / upload ────────────────────────────────────────────────────

function classifyFile(file) {
  return file.type.startsWith("video/") ? "video" : "photo";
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
  if (!stagedCover) return;

  const img = Object.assign(document.createElement("img"), {
    src: stagedCover.previewUrl,
    alt: "Cover preview",
    className: "cover-thumb",
  });
  const remove = Object.assign(document.createElement("button"), {
    className: "cover-remove",
    type: "button",
    textContent: "✕ Remove",
  });
  remove.addEventListener("click", () => {
    URL.revokeObjectURL(stagedCover.previewUrl);
    stagedCover = null;
    renderCoverPreview();
  });
  wrap.append(img, remove);
}

function renderPreviews() {
  const wrap = document.getElementById("mediaPreview");
  if (!wrap) return;
  wrap.innerHTML = "";

  stagedFiles.forEach((item, i) => {
    const thumb = document.createElement("div");
    thumb.className = "media-thumb";

    const mediaEl =
      item.type === "video"
        ? Object.assign(document.createElement("video"), { src: item.previewUrl, muted: true })
        : Object.assign(document.createElement("img"),  { src: item.previewUrl, alt: "Preview" });

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
  setText("pageTitle", t(`section.${currentSection}`));
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
    el.addEventListener("click", () => showSection(el.dataset.section));
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

  // Gallery dropzone
  const dropzone  = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  if (dropzone && fileInput) {
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

  // Copy link button
  document.getElementById("copyLinkBtn")?.addEventListener("click", copyLink);

  // Family picker — pre-load profiles so search works on first use
  getDocs(tenantQuery(COLLECTIONS.persons)).then((snap) => {
    allProfiles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }).catch(() => {});
  initFamilyPicker();

  // Load initial section
  showSection("dashboard");
}

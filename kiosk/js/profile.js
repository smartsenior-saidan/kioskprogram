// profile.js — serene memorial presentation (marble stage, vertical name,
// framed photo slideshow, era-formatted dates, memorial video).

import {
  getDocs,
  getDoc,
  doc,
  db,
  COLLECTIONS,
  getPersonById,
  personMediaCollection,
} from "./firebase.js";
import { logProfileView, logArrivalSource, logVideoPlay } from "./analytics.js";

const ADVANCE_MS = 6000;

// ── URL / id helpers ────────────────────────────────────────────────────────

function getParam(key) {
  return new URLSearchParams(window.location.search).get(key);
}

// Recover the person id even if a clean-URL host stripped the query string on
// the .html → extensionless redirect: fall back to the value search.js stashed.
function getPersonId() {
  return getParam('person') || sessionStorage.getItem('kiosk_person');
}

function getViewMode() {
  return getParam('view') || sessionStorage.getItem('kiosk_view');
}

// ── Japanese date / number formatting ──────────────────────────────────────

const KANJI_DIGITS = ['〇','一','二','三','四','五','六','七','八','九'];

/** Integer → Japanese kanji numeral (handles up to 9999, good for years/dates). */
function toKanji(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return '';
  if (n === 0) return KANJI_DIGITS[0];
  if (n < 0) return '';
  const units = ['', '十', '百', '千'];
  let s = '';
  const str = String(n);
  const len = str.length;
  for (let i = 0; i < len; i++) {
    const d = Number(str[i]);
    const u = len - 1 - i;
    if (d === 0) continue;
    // Omit the leading "一" for 十/百/千 (e.g. 十一 not 一十一)
    if (!(d === 1 && u > 0)) s += KANJI_DIGITS[d];
    s += units[u];
  }
  return s;
}

/** "YYYY-MM-DD" → "令和六年十一月七日" (Japanese era). */
function toEraDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  let era, ey;
  if (y >= 2019)      { era = '令和'; ey = y - 2018; }
  else if (y >= 1989) { era = '平成'; ey = y - 1988; }
  else if (y >= 1926) { era = '昭和'; ey = y - 1925; }
  else if (y >= 1912) { era = '大正'; ey = y - 1911; }
  else                { era = '明治'; ey = y - 1867; }
  const yk = ey === 1 ? '元' : toKanji(ey);
  return `${era}${yk}年${toKanji(m)}月${toKanji(d)}日`;
}

/** Age at death from birth/death dates (full years). */
function computeAge(birthIso, deathIso) {
  if (!birthIso || !deathIso) return null;
  const b = new Date(birthIso);
  const d = new Date(deathIso);
  if (isNaN(b) || isNaN(d)) return null;
  let age = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) age--;
  return age >= 0 ? age : null;
}

// ── Media loading ─────────────────────────────────────────────────────────

async function loadMedia(personId) {
  try {
    const snap = await getDocs(personMediaCollection(personId));
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0));
  } catch (err) {
    console.warn('[profile] media load failed:', err);
    return [];
  }
}

// ── Slideshow ───────────────────────────────────────────────────────────────

let _photos = [];
let _idx    = 0;
let _timer  = null;

function slideTo(i) {
  const imgs = document.querySelectorAll('.p-slide');
  if (!imgs.length) return;
  imgs[_idx]?.classList.remove('active');
  _idx = ((i % _photos.length) + _photos.length) % _photos.length;
  imgs[_idx]?.classList.add('active');
  document.querySelectorAll('.p-dot').forEach((d, di) =>
    d.classList.toggle('active', di === _idx)
  );
}

function initSlideshow(photoUrls) {
  _photos = photoUrls;
  const stack = document.getElementById('pSlides');
  if (!stack) return;

  photoUrls.forEach((url, i) => {
    const img = document.createElement('img');
    img.src       = url;
    img.alt       = 'Memorial photo';
    img.className = 'p-slide' + (i === 0 ? ' active' : '');
    stack.appendChild(img);
  });

  if (photoUrls.length > 1) {
    const dotsEl = document.getElementById('pDots');
    if (dotsEl) {
      dotsEl.classList.remove('hidden');
      photoUrls.forEach((_, di) => {
        const d = document.createElement('div');
        d.className = 'p-dot' + (di === 0 ? ' active' : '');
        d.addEventListener('click', () => { slideTo(di); restartTimer(); });
        dotsEl.appendChild(d);
      });
    }
    restartTimer();

    // Touch swipe on the photo frame
    const photo = document.getElementById('pPhoto');
    if (photo) {
      let _tx = 0;
      photo.addEventListener('touchstart', (e) => { _tx = e.touches[0].clientX; }, { passive: true });
      photo.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - _tx;
        if (Math.abs(dx) < 30) return;
        slideTo(dx < 0 ? _idx + 1 : _idx - 1);
        restartTimer();
      }, { passive: true });
    }
  }
}

function restartTimer() {
  clearInterval(_timer);
  _timer = setInterval(() => slideTo(_idx + 1), ADVANCE_MS);
}

// ── Rendering ─────────────────────────────────────────────────────────────

function set(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || '';
}
function show(id)  { document.getElementById(id)?.classList.remove('hidden'); }
function hide(id)  { document.getElementById(id)?.classList.add('hidden'); }

/** Wire the top "Back" / "End Visit" controls (shared by both render modes). */
function wireNav(ja) {
  const backBtn = document.getElementById('pnavBack');
  if (backBtn) {
    backBtn.textContent = ja ? '◀ 戻る' : '◀ Back';
    backBtn.addEventListener('click', () => {
      const via = new URLSearchParams(window.location.search).get('via');
      const personId = new URLSearchParams(window.location.search).get('person');
      if (via === 'family' && personId) {
        // Go back to the family selector for this person
        const rootId = sessionStorage.getItem('kiosk_person') || personId;
        window.location.href = `family.html?person=${rootId}&site=${window.__ENV__.TENANT_ID}`;
      } else {
        window.location.href = `index.html?restore=search&site=${window.__ENV__.TENANT_ID}`;
      }
    });
  }
  const endBtn = document.getElementById('pnavEnd');
  if (endBtn) {
    endBtn.textContent = ja ? '参拝終了' : 'End Visit';
    endBtn.addEventListener('click', () => { window.location.href = `index.html?site=${window.__ENV__.TENANT_ID}`; });
  }
}

/** A premade presentation URL — show it full-screen in an embedded frame. */
function renderEmbed(person) {
  const lang = sessionStorage.getItem('kiosk_lang') || 'ja';
  const ja   = lang !== 'en';
  document.body.classList.toggle('lang-ja', ja);
  document.body.classList.toggle('lang-en', !ja);
  document.documentElement.lang = lang;

  const displayName = ja
    ? `${person.last_name || ''}　${person.first_name || ''}`.trim()
    : `${person.first_name || ''} ${person.last_name || ''}`.trim();
  document.title = `${displayName.replace('　', ' ')} — SmartSenior`;

  wireNav(ja);

  const frame = document.getElementById('pEmbedFrame');
  if (frame) frame.src = person.presentation_url;
  show('pEmbed');
}

function renderPerson(person, media) {
  const lang   = sessionStorage.getItem('kiosk_lang') || 'ja';
  const ja     = lang !== 'en';
  const photos  = media.filter((m) => m.file_type === 'photo' && m.storage_url);
  const videos  = media.filter((m) => m.file_type === 'video' && m.storage_url);
  const audios  = media.filter((m) => m.file_type === 'audio' && m.storage_url);

  document.body.classList.toggle('lang-ja', ja);
  document.body.classList.toggle('lang-en', !ja);
  document.documentElement.lang = lang;

  // Name
  const displayName = ja
    ? `${person.last_name || ''}　${person.first_name || ''}`.trim()
    : `${person.first_name || ''} ${person.last_name || ''}`.trim();
  document.title = `${displayName.replace('　', ' ')} — SmartSenior`;
  set('pName', displayName);

  // Posthumous Buddhist name (戒名), if recorded
  const kaimyo = person.kaimyo || person.posthumous_name || '';
  if (kaimyo) { set('pKaimyo', kaimyo); show('pKaimyo'); }

  // Top controls
  wireNav(ja);

  // Death date
  if (person.death_date) {
    set('pDeathLabel', ja ? '没日' : 'Passed');
    set('pDeathDate', ja ? toEraDate(person.death_date) : person.death_date);
    show('pDeathBlock');
  }

  // Age at death
  const age = computeAge(person.birth_date, person.death_date);
  if (age != null) {
    set('pAgeLabel', ja ? '享年' : 'Age');
    set('pAge', ja ? `${toKanji(age)}歳` : String(age));
    show('pAgeBlock');
  }

  // Plot
  if (person.plot) {
    set('pPlotLabel', ja ? '区画' : 'Plot');
    set('pPlot', person.plot);
    show('pPlotBlock');
  }

  // Photos or initials placeholder
  if (photos.length) {
    initSlideshow(photos.map((p) => p.storage_url));
  } else {
    show('pNoPhoto');
    const initials = ((person.last_name || '').charAt(0) + (person.first_name || '').charAt(0)).toUpperCase() || '✦';
    set('pInitials', initials);
  }

  // Memorial audio
  if (audios.length) {
    const audio   = document.getElementById('pAudio');
    const btn     = document.getElementById('pAudioBtn');
    const icon    = document.getElementById('pAudioIcon');
    const label   = document.getElementById('pAudioLabel');
    if (audio && btn) {
      audio.src = audios[0].storage_url;
      btn.addEventListener('click', () => {
        if (audio.paused) {
          audio.play();
          icon.textContent  = '⏸';
          label.textContent = ja ? '一時停止' : 'Pause';
        } else {
          audio.pause();
          icon.textContent  = '▶';
          label.textContent = ja ? '音楽を再生' : 'Play Music';
        }
      });
      audio.addEventListener('ended', () => {
        icon.textContent  = '▶';
        label.textContent = ja ? '音楽を再生' : 'Play Music';
      });
      if (label) label.textContent = ja ? '音楽を再生' : 'Play Music';
      show('pAudioWrap');
      show('pBottom');
    }
  }

  // Memorial video
  if (videos.length) {
    const video = document.getElementById('pVideo');
    if (video) {
      video.src = videos[0].storage_url;
      let logged = false;
      video.addEventListener('play', () => {
        if (!logged) { logVideoPlay(person.id); logged = true; }
      });
      show('pVideoWrap');
      show('pBottom');
    }
  }

  // Biography (in an elegant overlay)
  if (person.biography) {
    set('pBioLabel', ja ? 'ご略歴' : 'Biography');
    set('pBio', person.biography);
    const toggle = document.getElementById('pBioToggle');
    if (toggle) {
      toggle.textContent = ja ? 'ご略歴を読む' : 'Read biography';
      toggle.classList.remove('hidden');
    }
    show('pBottom');
    const overlay = document.getElementById('pBioOverlay');
    const close   = document.getElementById('pBioClose');
    if (close) close.textContent = ja ? '閉じる' : 'Close';
    toggle?.addEventListener('click', () => overlay?.classList.remove('hidden'));
    close?.addEventListener('click', () => overlay?.classList.add('hidden'));
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  }

  // If arriving via "区画へ案内", flash the plot block
  if (getViewMode() === 'plot') {
    document.getElementById('pPlotBlock')?.classList.add('m-info-highlight');
  }
}

// ── Family members ────────────────────────────────────────────────────────

async function renderFamily(person, ja) {
  const ids = person.related_persons;
  if (!ids || !ids.length) return;

  const familyWrap = document.getElementById("pFamily");
  const familyList = document.getElementById("pFamilyList");
  const familyTitle = document.getElementById("pFamilyTitle");
  if (!familyWrap || !familyList) return;

  if (familyTitle) familyTitle.textContent = ja ? 'ご家族' : 'Family Members';

  const fetches = ids.map((id) => getDoc(doc(db, COLLECTIONS.persons, id)));
  const snaps = await Promise.all(fetches);

  const members = snaps
    .filter((s) => s.exists())
    .map((s) => ({ id: s.id, ...s.data() }));

  if (!members.length) return;

  familyList.innerHTML = members.map((m) => {
    const name = ja
      ? `${m.last_name || ''}　${m.first_name || ''}`.trim()
      : `${m.first_name || ''} ${m.last_name || ''}`.trim();
    const years = m.birth_date || m.death_date
      ? `${(m.birth_date || '').slice(0,4) || '?'} – ${(m.death_date || '').slice(0,4) || '?'}`
      : '';
    return `
      <button class="m-family-card" data-id="${m.id}">
        <div class="m-family-initials">${((m.last_name||'').charAt(0)+(m.first_name||'').charAt(0)).toUpperCase()||'✦'}</div>
        <div class="m-family-name">${name}</div>
        ${years ? `<div class="m-family-years">${years}</div>` : ''}
      </button>`;
  }).join('');

  familyList.querySelectorAll('.m-family-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      window.location.href = `profile.html?person=${btn.dataset.id}&site=${window.__ENV__.TENANT_ID}`;
    });
  });

  familyWrap.classList.remove('hidden');
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

export async function initProfileScreen() {
  const lang     = sessionStorage.getItem('kiosk_lang') || 'ja';
  const ja       = lang !== 'en';
  const loader   = document.getElementById('loader');
  const personId = getPersonId();

  const errorScreen = (msg) => {
    if (loader) loader.classList.add('hidden');
    const main = document.getElementById('pMain');
    if (main) main.remove();
    document.body.insertAdjacentHTML('beforeend', `
      <div class="p-error">
        <p>${msg}</p>
        <a href="index.html">${ja ? '← 検索に戻る' : '← Return to search'}</a>
      </div>`);
  };

  if (!personId) {
    errorScreen(ja ? 'ご遺族の情報が指定されていません。' : 'No memorial specified.');
    return;
  }

  try {
    const person = await getPersonById(personId);
    if (!person) {
      errorScreen(ja ? 'ご遺族の記録が見つかりませんでした。' : 'This memorial could not be found.');
      return;
    }

    if (person.presentation_url) {
      // Premade presentation: skip the built-in layout, embed the URL.
      renderEmbed(person);
    } else {
      const media = await loadMedia(personId);
      renderPerson(person, media);
      document.getElementById('pMain')?.classList.remove('hidden');
      await renderFamily(person, lang !== 'en');
    }

    logProfileView(person.id);
    logArrivalSource(person.id);
  } catch (err) {
    console.error('[profile] failed:', err);
    errorScreen(ja ? '読み込みに失敗しました。' : 'Something went wrong.');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}

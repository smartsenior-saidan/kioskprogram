// profile.js — serene memorial presentation (marble stage, vertical name,
// framed photo slideshow, era-formatted dates, memorial video).

import {
  getDocs,
  getPersonById,
  personMediaCollection,
} from "./firebase.js";

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
function wireNav() {
  const backBtn = document.getElementById('pnavBack');
  if (backBtn) {
    backBtn.textContent = '◀ 戻る';
    backBtn.addEventListener('click', () => {
      const via = new URLSearchParams(window.location.search).get('via');
      const personId = new URLSearchParams(window.location.search).get('person');
      if (via === 'family' && personId) {
        const rootId = sessionStorage.getItem('kiosk_person') || personId;
        window.location.href = `family.html?person=${rootId}&site=${window.__ENV__.TENANT_ID}`;
      } else if (via === 'slideshow' && personId) {
        const rootId = sessionStorage.getItem('kiosk_person') || personId;
        window.location.href = `slideshow.html?person=${rootId}&site=${window.__ENV__.TENANT_ID}`;
      } else {
        window.location.href = `index.html?restore=search&site=${window.__ENV__.TENANT_ID}`;
      }
    });
  }
  const endBtn = document.getElementById('pnavEnd');
  if (endBtn) {
    endBtn.textContent = '参拝終了';
    endBtn.addEventListener('click', () => { window.location.href = `thankyou.html?site=${window.__ENV__.TENANT_ID}`; });
  }
}

/** A premade presentation URL — show it full-screen in an embedded frame. */
function renderEmbed(person) {
  const displayName = `${person.last_name || ''}${person.first_name || ''}`.trim();
  document.title = `${displayName.replace('　', ' ')} — SmartSenior`;

  wireNav();

  const frame = document.getElementById('pEmbedFrame');
  if (frame) frame.src = person.presentation_url;
  show('pEmbed');
}

function renderPerson(person, media) {
  const photos  = media.filter((m) => m.file_type === 'photo' && m.storage_url);
  const videos  = media.filter((m) => m.file_type === 'video' && m.storage_url);
  const audios  = media.filter((m) => m.file_type === 'audio' && m.storage_url);

  // Name
  const displayName = `${person.last_name || ''}${person.first_name || ''}`.trim();
  document.title = `${displayName.replace('　', ' ')} — SmartSenior`;
  set('pName', displayName);

  // Posthumous Buddhist name (戒名), if recorded
  const kaimyo = person.kaimyo || person.posthumous_name || '';
  if (kaimyo) { set('pKaimyo', kaimyo); show('pKaimyo'); }

  // Top controls
  wireNav();

  // Death date
  if (person.death_date) {
    set('pDeathLabel', '没日');
    set('pDeathDate', toEraDate(person.death_date));
    show('pDeathBlock');
  }

  // Age at death
  const age = computeAge(person.birth_date, person.death_date);
  if (age != null) {
    set('pAgeLabel', '享年');
    set('pAge', `${toKanji(age)}歳`);
    show('pAgeBlock');
  }

  // Photos or initials placeholder
  if (photos.length) {
    initSlideshow(photos.map((p) => p.storage_url));

    // Tap photo to open fullscreen lightbox
    const photoFrame = document.getElementById('pPhoto');
    const lightbox   = document.getElementById('pLightbox');
    const lbImg      = document.getElementById('pLightboxImg');
    const lbClose    = document.getElementById('pLightboxClose');
    if (photoFrame && lightbox) {
      photoFrame.addEventListener('click', () => {
        const active = document.querySelector('.p-slide.active');
        if (!active?.src) return;
        lbImg.src = active.src;
        lightbox.classList.remove('hidden');
      });
      lbClose?.addEventListener('click', (e) => {
        e.stopPropagation();
        lightbox.classList.add('hidden');
      });
      lightbox.addEventListener('click', () => lightbox.classList.add('hidden'));
    }
  } else {
    show('pNoPhoto');
    const initials = ((person.last_name || '').charAt(0) + (person.first_name || '').charAt(0)).toUpperCase() || '✦';
    set('pInitials', initials);
  }

  // Memorial audio
  if (audios.length) {
    const audio = document.getElementById('pAudio');
    if (audio) {
      audio.src = audios[0].storage_url;
      show('pAudioWrap');
      show('pBottom');
    }
  }

  // Memorial video
  if (videos.length) {
    const video = document.getElementById('pVideo');
    if (video) {
      video.src = videos[0].storage_url;
      show('pVideoWrap');
      show('pBottom');
    }
  }

  // Biography (in an elegant overlay)
  if (person.biography) {
    set('pBioLabel', 'メッセージ');
    set('pBio', person.biography);
    const toggle = document.getElementById('pBioToggle');
    if (toggle) {
      toggle.textContent = 'メッセージを読む';
      toggle.classList.remove('hidden');
    }
    show('pBottom');
    const overlay = document.getElementById('pBioOverlay');
    const close   = document.getElementById('pBioClose');
    if (close) close.textContent = '閉じる';
    toggle?.addEventListener('click', () => overlay?.classList.remove('hidden'));
    close?.addEventListener('click', () => overlay?.classList.add('hidden'));
    overlay?.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

export async function initProfileScreen() {
  const loader   = document.getElementById('loader');
  const personId = getPersonId();

  const errorScreen = (msg) => {
    if (loader) loader.classList.add('hidden');
    const main = document.getElementById('pMain');
    if (main) main.remove();
    document.body.insertAdjacentHTML('beforeend', `
      <div class="p-error">
        <p>${msg}</p>
        <a href="index.html">← 検索に戻る</a>
      </div>`);
  };

  if (!personId) {
    errorScreen('ご遺族の情報が指定されていません。');
    return;
  }

  try {
    const person = await getPersonById(personId);
    if (!person) {
      errorScreen('ご遺族の記録が見つかりませんでした。');
      return;
    }

    // Per-person background overrides the tenant background
    if (person.background_url) {
      document.body.style.setProperty('--tenant-bg-url', `url("${person.background_url}")`);
      document.body.classList.add('has-tenant-bg');
    }

    if (person.presentation_url) {
      // Premade presentation: skip the built-in layout, embed the URL.
      renderEmbed(person);
    } else {
      const media = await loadMedia(personId);
      renderPerson(person, media);
      document.getElementById('pMain')?.classList.remove('hidden');
    }

  } catch (err) {
    console.error('[profile] failed:', err);
    errorScreen('読み込みに失敗しました。');
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}

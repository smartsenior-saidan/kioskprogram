// i18n.js — lightweight English/Japanese translation for the admin portal.
//
// Usage:
//   import { t, getLang, setLang, applyStaticI18n, onLangChange } from "./i18n.js";
//   applyStaticI18n();                 // translate [data-i18n] elements
//   el.textContent = t("table.lastName");
//   t("status.savedToast", { name: "山田 太郎" });

const STRINGS = {
  en: {
    "section.dashboard": "Dashboard",
    "section.profiles": "Profiles",
    "section.new-profile": "New Profile",
    "nav.dashboard": "Dashboard",
    "nav.profiles": "Profiles",
    "nav.newProfile": "New Profile",
    "signOut": "Sign out",
    "role.superadmin": "Super Admin",
    "role.admin": "Admin",
    "btn.newProfile": "+ New Profile",
    "card.recentProfiles": "Recent Profiles",
    "link.viewAll": "View all →",
    "ph.fiSearch": "Search by name…",
    "fi.familyMembers": "Family Members",
    "fi.individualMembers": "Individual Members",
    "fi.peopleSuffix": " people",
    "fi.familyCol": "Family",
    "fi.membersCol": "Members",
    "fi.nameCol": "Name",
    "fi.plotCol": "Plot",
    "card.allProfiles": "All Profiles",
    "ph.filterName": "Filter by name…",
    "btn.refresh": "↺ Refresh",
    "form.firstName": "First name *",
    "form.lastName": "Last name *",
    "form.firstNameKana": "First name (hiragana)",
    "ph.firstNameKana": "はなこ",
    "form.lastNameKana": "Last name (hiragana)",
    "ph.lastNameKana": "やまだ",
    "hint.nameKana": "Hiragana readings let guests search by kana even if they don't know the kanji.",
    "form.kaimyo": "Posthumous name (kaimyo)",
    "ph.kaimyo": "戒名",
    "hint.kaimyo": "Buddhist posthumous name, shown next to the name on the kiosk profile.",
    "form.birthDate": "Date of birth",
    "form.deathDate": "Date of passing",
    "form.plotSection": "Section",
    "ph.plotSection": "e.g. C",
    "form.plotRow": "Row / plot number",
    "ph.plotRow": "e.g. 12",
    "form.coverPhoto": "Cover photo",
    "hint.coverPhoto": "Single portrait photo shown on the kiosk profile card.",
    "form.gallery": "Gallery, videos & music",
    "hint.gallery": "Photos, videos, or music — photos shown in slideshow, music plays on the profile page.",
    "table.section": "Section",
    "table.row": "Row",
    "form.biography": "Biography",
    "ph.biography": "Share their life story, memories, and legacy…",
    "form.media": "Photos & videos",
    "dropzone.main": "<strong>Tap to choose</strong> or drag files here",
    "dropzone.hint": "JPG, PNG, MP4, WebM, MP3, AAC",
    "btn.saveProfile": "Save profile",
    "btn.updateProfile": "Update profile",
    "btn.clear": "Clear",
    "card.linkNfc": "Link NFC / QR",
    "hint.linkNfc": "Program an NFC tag or print the QR code. Scans are logged automatically.",
    "label.profileUrl": "Profile URL",
    "btn.copy": "Copy",
    "label.nfcUrl": "NFC tag URL",
    "formTitle.new": "New Profile",
    "formTitle.edit": "Edit — {name}",
    "table.lastName": "Last Name",
    "table.firstName": "First Name",
    "table.passed": "Passed",
    "table.actions": "Actions",
    "btn.link": "Link",
    "btn.edit": "Edit",
    "btn.delete": "Delete",
    "empty.noProfiles": "No profiles yet.",
    "empty.noProfilesCreate": 'No profiles yet. <button class="btn-link" data-section="new-profile">Create one →</button>',
    "empty.loadFail": "Could not load profiles. Check browser console.",
    "status.indexNeeded": "Firestore index needed — check browser console for setup link.",
    "status.nameRequired": "First and last name are required.",
    "status.saving": "Saving profile…",
    "status.uploading": "Uploading {n} file(s)…",
    "status.profileSaved": "Profile saved.",
    "status.savedToast": "{name} saved.",
    "status.saveFailed": "Save failed: {msg}",
    "status.editing": "Editing {name}. Add media below to append files.",
    "status.deleting": "Deleting…",
    "status.deletedToast": "{name} deleted.",
    "status.deleteFailed": "Delete failed: {msg}",
    "status.linkCopied": "Link copied.",
    "status.pressCopy": "Press Ctrl/Cmd+C to copy.",
    "link.open": "Open link",
    "confirm.delete": "Delete the memorial for {name}?\nThis also removes all photos and videos.",
  },
  ja: {
    "section.dashboard": "ダッシュボード",
    "section.profiles": "故人一覧",
    "section.new-profile": "新規登録",
    "nav.dashboard": "ダッシュボード",
    "nav.profiles": "故人一覧",
    "nav.newProfile": "新規登録",
    "signOut": "サインアウト",
    "role.superadmin": "スーパー管理者",
    "role.admin": "管理者",
    "btn.newProfile": "＋ 新規登録",
    "card.recentProfiles": "最近の登録",
    "link.viewAll": "すべて表示 →",
    "ph.fiSearch": "名前で検索…",
    "fi.familyMembers": "ご家族",
    "fi.individualMembers": "個人",
    "fi.peopleSuffix": "人",
    "fi.familyCol": "ご家族",
    "fi.membersCol": "人数",
    "fi.nameCol": "お名前",
    "fi.plotCol": "区画",
    "card.allProfiles": "故人一覧",
    "ph.filterName": "名前で絞り込み…",
    "btn.refresh": "↺ 更新",
    "form.firstName": "名 *",
    "form.lastName": "姓 *",
    "form.firstNameKana": "名（ひらがな）",
    "ph.firstNameKana": "はなこ",
    "form.lastNameKana": "姓（ひらがな）",
    "ph.lastNameKana": "やまだ",
    "hint.nameKana": "ひらがなでの読みを登録すると、漢字が分からないご来館者でも検索できます。",
    "form.kaimyo": "戒名",
    "ph.kaimyo": "戒名",
    "hint.kaimyo": "仏式の戒名。キオスクのプロフィールでお名前の横に表示されます。",
    "form.birthDate": "生年月日",
    "form.deathDate": "没年月日",
    "form.plotSection": "区（エリア）",
    "ph.plotSection": "例：A区",
    "form.plotRow": "側・番号",
    "ph.plotRow": "例：1側1番",
    "form.coverPhoto": "顔写真",
    "hint.coverPhoto": "キオスクのプロフィールカードに表示する1枚の写真。",
    "form.gallery": "ギャラリー・動画・音楽",
    "hint.gallery": "写真・動画・音楽ファイル — 写真はスライドショー、音楽はプロフィールページで再生されます。",
    "table.section": "区",
    "table.row": "番号",
    "form.biography": "ご略歴",
    "ph.biography": "故人の歩み・思い出などをご記入ください…",
    "form.media": "写真・動画",
    "dropzone.main": "<strong>タップして選択</strong> またはドラッグ＆ドロップ",
    "dropzone.hint": "JPG, PNG, MP4, WebM, MP3, AAC",
    "btn.saveProfile": "保存",
    "btn.updateProfile": "更新",
    "btn.clear": "クリア",
    "card.linkNfc": "NFC / QR 連携",
    "hint.linkNfc": "NFCタグに書き込むか、QRコードを印刷してください。スキャンは自動的に記録されます。",
    "label.profileUrl": "プロフィールURL",
    "btn.copy": "コピー",
    "label.nfcUrl": "NFCタグURL",
    "formTitle.new": "新規登録",
    "formTitle.edit": "編集 — {name}",
    "table.lastName": "姓",
    "table.firstName": "名",
    "table.passed": "没年",
    "table.actions": "操作",
    "btn.link": "連携",
    "btn.edit": "編集",
    "btn.delete": "削除",
    "empty.noProfiles": "まだ登録がありません。",
    "empty.noProfilesCreate": 'まだ登録がありません。<button class="btn-link" data-section="new-profile">作成する →</button>',
    "empty.loadFail": "読み込みに失敗しました。コンソールをご確認ください。",
    "status.indexNeeded": "Firestoreのインデックスが必要です — コンソールの設定リンクをご確認ください。",
    "status.nameRequired": "姓と名は必須です。",
    "status.saving": "保存中…",
    "status.uploading": "{n}件のファイルをアップロード中…",
    "status.profileSaved": "保存しました。",
    "status.savedToast": "{name} を保存しました。",
    "status.saveFailed": "保存に失敗しました：{msg}",
    "status.editing": "{name} を編集中。下にメディアを追加できます。",
    "status.deleting": "削除中…",
    "status.deletedToast": "{name} を削除しました。",
    "status.deleteFailed": "削除に失敗しました：{msg}",
    "status.linkCopied": "コピーしました。",
    "status.pressCopy": "Ctrl/Cmd+C でコピーしてください。",
    "link.open": "リンクを開く",
    "confirm.delete": "{name} の電子墓誌を削除しますか？\n写真・動画もすべて削除されます。",
  },
};

let _lang = localStorage.getItem("admin_lang") || "en";
const _listeners = [];

export function getLang() {
  return _lang;
}

export function setLang(lang) {
  if (lang !== "en" && lang !== "ja") return;
  _lang = lang;
  localStorage.setItem("admin_lang", lang);
  document.documentElement.lang = lang;
  applyStaticI18n();
  _listeners.forEach((fn) => fn(lang));
}

/** Register a callback fired whenever the language changes. */
export function onLangChange(fn) {
  _listeners.push(fn);
}

/** Translate a key, interpolating {placeholders} from `vars`. */
export function t(key, vars) {
  let s = (STRINGS[_lang] && STRINGS[_lang][key]) || STRINGS.en[key] || key;
  if (vars) {
    for (const k in vars) s = s.replaceAll(`{${k}}`, vars[k]);
  }
  return s;
}

/** Apply translations to all [data-i18n], [data-i18n-ph], [data-i18n-html]. */
export function applyStaticI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.setAttribute("placeholder", t(el.dataset.i18nPh));
  });
}

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
    "stat.totalProfiles": "Total Profiles",
    "stat.totalProfilesSub": "Deceased persons",
    "stat.media": "Media Files",
    "stat.mediaSub": "Photos & videos",
    "stat.searches": "Searches",
    "stat.allTime": "All time",
    "stat.views": "Profile Views",
    "card.eventBreakdown": "Event Breakdown",
    "card.recentActivity": "Recent Activity",
    "card.recentProfiles": "Recent Profiles",
    "link.viewAll": "View all →",
    "card.allProfiles": "All Profiles",
    "ph.filterName": "Filter by name…",
    "btn.refresh": "↺ Refresh",
    "form.firstName": "First name *",
    "form.lastName": "Last name *",
    "form.familyName": "Family / maiden name",
    "ph.familyName": "Helps guests search under an additional surname",
    "form.birthDate": "Date of birth",
    "form.deathDate": "Date of passing",
    "form.plot": "Plot / location",
    "ph.plot": "e.g. Section C, Row 12",
    "form.biography": "Biography",
    "ph.biography": "Share their life story, memories, and legacy…",
    "form.presentationUrl": "Presentation link (optional)",
    "ph.presentationUrl": "https://…  link to a premade presentation",
    "hint.presentationUrl": "If set, the kiosk opens this presentation instead of the photos & videos below.",
    "form.media": "Photos & videos",
    "dropzone.main": "<strong>Tap to choose</strong> or drag files here",
    "dropzone.hint": "JPG, PNG, MP4, WebM",
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
    "table.plot": "Plot",
    "table.actions": "Actions",
    "btn.link": "Link",
    "btn.edit": "Edit",
    "btn.delete": "Delete",
    "empty.noProfiles": "No profiles yet.",
    "empty.noProfilesCreate": 'No profiles yet. <button class="btn-link" data-section="new-profile">Create one →</button>',
    "empty.noActivity": "No activity recorded yet.",
    "empty.loadFail": "Could not load profiles. Check browser console.",
    "event.search_query": "Searches",
    "event.profile_view": "Views",
    "event.slideshow_play": "Slideshows",
    "event.video_play": "Videos",
    "event.nfc_tap": "NFC taps",
    "event.qr_scan": "QR scans",
    "chart.events": "Events",
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
    "stat.totalProfiles": "登録者数",
    "stat.totalProfilesSub": "故人",
    "stat.media": "メディア",
    "stat.mediaSub": "写真・動画",
    "stat.searches": "検索数",
    "stat.allTime": "累計",
    "stat.views": "閲覧数",
    "card.eventBreakdown": "イベント内訳",
    "card.recentActivity": "最近のアクティビティ",
    "card.recentProfiles": "最近の登録",
    "link.viewAll": "すべて表示 →",
    "card.allProfiles": "故人一覧",
    "ph.filterName": "名前で絞り込み…",
    "btn.refresh": "↺ 更新",
    "form.firstName": "名 *",
    "form.lastName": "姓 *",
    "form.familyName": "旧姓・家名",
    "ph.familyName": "別の姓でも検索できるようにします",
    "form.birthDate": "生年月日",
    "form.deathDate": "没年月日",
    "form.plot": "区画・場所",
    "ph.plot": "例：1区1側1番",
    "form.biography": "ご略歴",
    "ph.biography": "故人の歩み・思い出などをご記入ください…",
    "form.presentationUrl": "プレゼンテーションのURL（任意）",
    "ph.presentationUrl": "https://…  既存のプレゼンテーションのリンク",
    "hint.presentationUrl": "入力すると、下の写真・動画の代わりにこのプレゼンテーションを表示します。",
    "form.media": "写真・動画",
    "dropzone.main": "<strong>タップして選択</strong> またはドラッグ＆ドロップ",
    "dropzone.hint": "JPG, PNG, MP4, WebM",
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
    "table.plot": "区画",
    "table.actions": "操作",
    "btn.link": "連携",
    "btn.edit": "編集",
    "btn.delete": "削除",
    "empty.noProfiles": "まだ登録がありません。",
    "empty.noProfilesCreate": 'まだ登録がありません。<button class="btn-link" data-section="new-profile">作成する →</button>',
    "empty.noActivity": "アクティビティはまだありません。",
    "empty.loadFail": "読み込みに失敗しました。コンソールをご確認ください。",
    "event.search_query": "検索",
    "event.profile_view": "閲覧",
    "event.slideshow_play": "スライド",
    "event.video_play": "動画",
    "event.nfc_tap": "NFCタップ",
    "event.qr_scan": "QRスキャン",
    "chart.events": "イベント",
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

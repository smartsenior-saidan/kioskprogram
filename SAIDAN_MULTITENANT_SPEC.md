# Saidan Multi-Tenant System — Engineering Spec

**Status:** v1.3
**Date:** 2026-06-14 (revised through onboarding)
**Author:** Ted Fujisawa
**Lead developer:** Linus (full-time until 2026-07-31)
**Audience:** Engineering (English-speaking)

**Two hard deadlines:**
- **Wed 2026-07-02 — Kodaira goes LIVE** as the first tenant (visitor-facing system must work)
- **Fri 2026-07-31 — Full Base complete + documented + Tokyo_Reien ready** (lead dev off-boards)

> Changelog at the bottom (Section 15). Biggest change since v1.2: **both customers now run on this system** — Kodaira is the first tenant, not a WordPress clone.

---

## 0. TL;DR

A Firebase-based, multi-tenant memorial display for Japanese temples and cemeteries. Static HTML + vanilla JS + Tailwind (CDN) frontend, Firestore backend, Python for any Cloud Functions and scripts. No React/Next/Node.js build chain. Each tenant is an organization (temple / cemetery / management organization), identified by `?tenant=` in the URL. Production domain is **saidans.org**. Hardware is **Surface Pro 7+** in Edge kiosk mode (912x1368 portrait). NFC/QR is handled entirely by the existing Boshi Monitor `kiosk_app.py` — your web app only consumes URL parameters. Slideshow of all deceased is in scope.

Both Kodaira (7/2) and Tokyo_Reien (Sept) ship on this system. Build it in two sprints: a Kodaira MVP by 7/2, then the full Base + Tokyo_Reien prep by 7/31.

---

## 1. Business Context

### 1.1 The product

**Saidan (祭壇)** means "altar." It is a digital memorial display installed in temples/cemeteries. A visitor at a wall-mounted Surface Pro 7+ tablet can:

1. Search the deceased by name (on-screen hiragana keyboard)
2. View a "family tree" of family members enshrined there
3. See a memorial page: photo, posthumous name (戒名), birth/death dates, age at death
4. Hear background music (BGM)
5. Watch a slideshow of all deceased
6. Tap an NFC card or scan a QR code to jump straight to their family (handled by kiosk_app.py, not your code)
7. End the visit

### 1.2 Tenant types

| Type | Japanese | Description |
|---|---|---|
| Temple | 寺院 (jiin) | Buddhist temple with cemetery |
| Cemetery / Memorial park | 霊園 (reien) / メモリアル | Standalone cemetery |
| Management organization | 管理団体 (kanri_dantai) | Organization managing multiple temples/cemeteries |

A **management organization (管理団体)** contains sub-tenants (member temples/cemeteries). A standalone temple/cemetery is itself a top-level tenant. See [tenant-architecture-principle] in Ted's memory: **tenant = organization, products = front-ends to that organization's data.**

### 1.3 Customers

| Customer | Type | Go-live | How |
|---|---|---|---|
| DEMO | sales demo | live | Legacy WordPress on Kinsta (retired once this system is stable) |
| **Kodaira_Memorial** | Cemetery | **2026-07-02** | **First tenant on THIS system** (`tenants/kodaira/`) |
| **Tokyo_Reien** | Cemetery | **2026-09 (early)** | Second tenant on THIS system (`tenants/tokyo_reien/`) |

Kodaira is no longer a WordPress clone (changed from earlier plans). It is the first real tenant on the multi-tenant system you build, which makes the 7/2 deadline the Sprint 1 target.

### 1.4 Reference codebases

**rem-multi** — `C:\Gallery_Search_git\rem-multi`. A shipped Firebase multi-tenant grave-register search system (pilot: 妙満寺). Your model for Firestore + static HTML + admin patterns. Saidan integrates with its admin UI. Read it Days 1-2.

**Boshi Monitor kiosk** — `C:\Kiosk-Dev\kiosk-app\kiosk_app.py` (v1.0.0). The Python kiosk wrapper that runs on the Surface Pro 7+: handles NFC/QR hardware, launches Edge in kiosk mode, and navigates Edge via Chrome DevTools Protocol. **Your web app runs inside this wrapper.** You write no NFC/QR JavaScript — you only consume the URL parameters it sends.

---

## 2. Architecture

### 2.1 High level

```
Surface Pro 7+ (Intune kiosk)
+----------------------------------------------------------+
|  kiosk_app.exe (Python wrapper, EXISTING - do NOT modify) |
|  - NFC: ACR122U via pyscard                               |
|  - QR:  DENSO QK30-U via pyserial / pynput                |
|  - Launches Edge in kiosk mode (--remote-debugging-port)  |
|  - Navigates Edge via Chrome DevTools Protocol            |
|              | Page.navigate(url)                          |
|              v                                            |
|  Edge (fullscreen kiosk)                                  |
|  +------------------------------------------------------+ |
|  |  saidans.org Web App (YOUR work)                     | |
|  |  Served by Cloudflare Pages (GitHub push deploy)     | |
|  |  Static HTML + Vanilla JS + Tailwind CDN             | |
|  |  Reads URL params: tenant, card_uid, family_id, ...  | |
|  +------------------------------------------------------+ |
|              | Firebase SDK                                |
+--------------|--------------------------------------------+
               v
+----------------------------------------------------------+
|  Firebase (new project "saidan-mt") - data only, no host  |
|  - Firestore (tenants/{tid}/deceased, families, cards)    |
|  - Storage (photos, BGM)                                  |
|  - Authentication (admin only)                            |
+--------------------------^-------------------------------+
                           | Firebase SDK (cross-project)
+--------------------------+-------------------------------+
|  Admin UI                                                 |
|  rem-multi's admin.html (extended with a "saidan" tab)    |
+----------------------------------------------------------+
```

**Firebase project:** a NEW project (`saidan-mt`), separate from rem-multi. Independent billing, cleaner separation. Admin UI lives in rem-multi but reads/writes saidan-mt via a shared Google identity. Firebase provides Firestore + Storage + Auth only.

**Hosting:** the saidan web app is served by **Cloudflare Pages** at `saidans.org`, deployed by GitHub push (same infra family as the Boshi Monitor `kiosk-tenants` project). This is NOT Firebase Hosting. The `firebase` CLI is still used to deploy Firestore/Storage security rules and run the local emulator. If `saidans.org` was pointed at Firebase Hosting during initial env setup, re-point its DNS to the Cloudflare Pages project.

### 2.2 Two "tenants" concepts (kept in sync by convention)

| Layer | Where | Purpose | Example |
|---|---|---|---|
| **Kiosk config** | Cloudflare Pages: `kiosk.smartsenior.jp/tenants/{tid}/config.json` | URLs, timeouts, welcome image (hardware-facing) | `tenants/kodaira/config.json` |
| **Business data** | Firestore: `tenants/{tid}/...` | Deceased, families, cards, photos | `tenants/kodaira/deceased/{id}` |

Same `{tid}` in both. Adding a tenant = add a Cloudflare config.json (small) + add Firestore `tenants/{tid}/` docs (admin work).

### 2.3 URL contract (kiosk_app.py -> saidans.org)

| URL | Trigger | Behavior |
|---|---|---|
| `https://saidans.org/?tenant={tid}` | boot / idle / reset | welcome page |
| `https://saidans.org/?tenant={tid}&card_uid={uid}` | NFC tap | look up `tenants/{tid}/cards/{uid}` -> family-tree |
| `https://saidans.org/?tenant={tid}&family_id={fid}` | QR scan (URL embedded) | family-tree for that family |
| `https://saidans.org/?tenant={tid}&deceased_id={did}` | QR for a person | single-deceased page |
| `https://saidans.org/end?tenant={tid}` | 参拝終了 / idle timeout | end page |

Read with `URLSearchParams`.

### 2.4 Firestore hierarchy

```
tenants/{tid}/
  config/main                  org info (name, type, contact)
  config/saidan                saidan settings (theme, bg, BGM, slideshow)
  deceased/{deceasedId}        person record (SHARED across products)
  families/{familyId}          family group
  cards/{cardId}               NFC/QR -> family mapping
  products/saidan/
    visits/{visitId}           visit log (optional)
  sub-tenants/{sub_tid}/       ONLY for 管理団体 (same shape as parent)
```

---

## 3. Tech Stack

| Layer | Tech | Why |
|---|---|---|
| Frontend | Static HTML + Vanilla JS | No build chain, fast, rem-multi pattern, Ted-maintainable after handoff |
| CSS | Tailwind CSS (Play CDN for MVP) | Matches rem-multi; swap to standalone-CLI purged CSS if the 6/30 hardware test shows lag — see 10.8 |
| Backend | Firebase Firestore | NoSQL, no server mgmt |
| Files | Firebase Storage | Photos, BGM |
| Auth | Firebase Authentication (Google) | Admin only |
| Hosting | Cloudflare Pages | saidans.org; same infra family as Boshi Monitor kiosk-tenants; GitHub push -> auto-deploy. Firebase still provides Firestore/Storage/Auth — just not hosting. |
| Functions (if needed) | Cloud Functions in **Python** | Matches Boshi Monitor; avoids Node.js |
| NFC + QR | Existing `kiosk_app.py` | Mature, in production; no JS needed |
| Date conversion | Japanese era library (locked in Week 1) | Display 令和六年十一月七日 |
| Build | None | Direct HTML/JS, Tailwind via CDN |

**Avoid:** React, Next.js, Node.js, npm, TypeScript build chains, Webpack/Vite.
**Allowed:** ES modules via `<script type="module">`, small CDN libs (dayjs, the era library, etc.). See Section 10.2 for the one sanctioned escape hatch on the admin tab.

---

## 4. Data Model

### 4.0 Document IDs — use unique IDs, never names (CRITICAL)

`deceased/{deceasedId}` and `families/{familyId}` MUST use Firestore auto-generated IDs (random, unique), NOT name-based slugs like `yamada` or `yamada-michiko`. URLs reference records by these IDs (`?deceased_id={did}`, `?family_id={fid}`), never by name.

Why this matters — two disambiguation cases:
- **Same name at different temples** (e.g. 山田道子 at Kodaira AND Tokyo_Reien): disambiguated by `?tenant=` in the URL. Each temple is a separate tenant; the two are separate records and never collide.
- **Same name within one temple** (two different 山田道子 at Kodaira): disambiguated ONLY by the unique document ID. Name-based IDs would collide and show the wrong person.

Keep the display name in the `displayName` field; the document ID stays an opaque unique ID. A person enshrined at two temples is two separate records (one per tenant) — do not deduplicate across tenants.

### 4.1 `tenants/{tid}/config/main`
```typescript
{
  name: string;            // "東京霊園"
  nameRomaji?: string;
  type: 'temple' | 'cemetery' | 'kanri_dantai';
  contactEmail: string;
  contactPhone?: string;
  address?: string;
  createdAt: Timestamp;
  status: 'active' | 'archived';
}
// All tenants are in Japan. Times are always Asia/Tokyo -> treat as a code
// constant, not a per-tenant field. No timezone field.
```

### 4.2 `tenants/{tid}/config/saidan`
```typescript
{
  themeColor: string;          // "#6b4423"
  backgroundImageUrl: string;
  bgmUrl: string;              // default BGM
  welcomeMessage: string;      // "ご来館ありがとうございます。"
  endMessage: string;          // "お参りお疲れ様でした。"
  searchEnabled: boolean;
  showAncestorSearch: boolean;
  slideshowEnabled: boolean;
  slideshowDurationSec: number; // default 8
}
```

### 4.3 `tenants/{tid}/deceased/{deceasedId}` (SHARED model — other products read it)
```typescript
{
  displayName: string;       // "山田 道子"
  displayNameKana: string;   // "やまだ みちこ" (search key)
  posthumousName?: string;   // "戒名サンプル"
  rightTitle?: string;
  birthDate?: string;        // ISO "1955-04-23"
  deathDate?: string;        // ISO "2024-11-07"
  age?: number;
  imageUrl?: string;         // Storage URL
  audioUrl?: string;         // personal BGM
  familyId?: string;
  shortId?: string;          // legacy cross-system id
  isAncestor?: boolean;      // 故人 vs 先祖
  status: 'active' | 'archived';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 4.4 `tenants/{tid}/families/{familyId}`
```typescript
{
  name: string;     // "山田家"
  slug: string;     // "yamada"
  plotId?: string;
  description?: string;
  status: 'active' | 'archived';
  createdAt: Timestamp;
}
```
deceased -> family is one-way (deceased holds `familyId`). Query for members; don't store a list on the family.

### 4.5 `tenants/{tid}/cards/{cardId}`
```typescript
{
  cardType: 'nfc' | 'qr';
  cardUid: string;     // NFC UID hex, or QR payload
  familyId: string;
  issuedTo?: string;
  issuedAt: Timestamp;
  status: 'active' | 'revoked';
}
```
NFC: `{cardId}` IS the UID (direct lookup). QR: payload is the full URL `https://saidans.org/?tenant={tid}&family_id={fid}` (no lookup needed).

### 4.6 `tenants/{tid}/products/saidan/visits/{visitId}` (optional, low priority)
```typescript
{ deceasedId: string; familyId?: string; source: 'search'|'nfc'|'qr'|'slideshow'; startedAt: Timestamp; endedAt?: Timestamp; }
```

### 4.7 Dates — Japanese era
Store ISO / Timestamp. Display 令和六年十一月七日. Lock the library in Week 1 (candidates: dayjs-wareki, or a <300-line custom helper). This should be decided already if onboarding is complete.

---

## 5. Pages (in `public/`, target 912x1368 portrait)

### 5.1 index.html (welcome)
Title "ご来館ありがとうございます。", subtitle, "氏名検索スタート" button -> search. NFC hint at bottom. Card routing handled externally; this page just routes `?card_uid=` / `?family_id=` at load. Theme from config.

### 5.2 search.html
Title "名前検索（姓→名と入力）". Read-only input + 50-on hiragana keyboard. Search (magnifier) + clear (X). Radio: 故人 / 先祖 (先祖 default). Prefix match on `displayNameKana` (`>=` and `<= input + ''`), filtered by `isAncestor`. Count message "N件の家族が見つかりました。" Corner buttons 戻る / 参拝終了.

### 5.3 family-tree.html
Reached via search OR `?card_uid=` / `?family_id=`. For `card_uid`: look up the card -> familyId. Title = family name. Subtitle "お参りする故人を選択してください". Deceased as buttons (theme bg, white text). Bottom "全故人（スライド）" -> slideshow. Each member -> single-deceased.

### 5.4 single-deceased.html
Marble background. 3 columns + photo: left 享年 / 没日 (era format, vertical), center photo, right 戒名 / 氏名 (vertical, `writing-mode: vertical-rl`). BGM plays (mind autoplay policy — needs a prior user gesture). Corner buttons.

### 5.5 slideshow.html
Reuses single-deceased layout. Auto-advance every `slideshowDurationSec` (8s default). BGM continuous. Pause/next/prev. Loops. Pauses on interaction.

### 5.6 end.html
"お参りお疲れ様でした。" / "気をつけてお帰りください。" "スタート画面へ戻る" -> index. Auto-return after 30s.

### 5.7 Common to all
Theme color on action buttons; yellow border frame; background image from config; all Japanese text preserved (do not translate); `tenant` read on load; 参拝終了 -> end page. NFC tap site-wide restarts the flow.

---

## 6. Admin Integration (rem-multi)

Extend **`rem-multi/admin.html`** with a "saidan" tab (in place — do NOT fork rem-multi). Provides:

1. 故人 list / add / edit / archive
2. 家族 list / add / edit / archive
3. Photo upload -> Storage
4. BGM upload -> Storage
5. `config/saidan` editor (theme, background, default BGM, slideshow on/off)
6. NFC/QR card issuance (create cards, link to families, generate printable QR)
7. Tenant switch (super-admin only)

Roles via Firebase Custom Claims:

| Role | Access |
|---|---|
| super-admin | all tenants (Ted: tfujisawa@smartsenior.jp) |
| tenant-admin | own tenant only |
| readonly | future |

**Cross-project access:** admin lives in rem-multi's project, reads/writes saidan-mt. Plan: shared Google identity, two named Firebase app instances. Custom Claims set in BOTH projects. Confirm with Ted before implementing.

---

## 7. Repository Structure

```
saidan-firebase/
  public/
    index.html  search.html  family-tree.html
    single-deceased.html  slideshow.html  end.html
    js/
      firebase-config.js   tenant-loader.js   common.js
      card-router.js   search.js   family.js   deceased.js
      slideshow.js   wareki.js
    css/ saidan.css
    assets/ icons/
  scripts/                 # Python (no Node.js)
    seed_demo.py  import_deceased.py
    generate_qr_batch.py
  functions/ main.py       # Cloud Functions (if needed), Python
  kiosk-config-template/tenants/_template/config.json
  firestore.rules  storage.rules  firebase.json
  README.md
  docs/
    DEPLOY.md  ADD_TENANT.md  SCHEMA.md  ADMIN_GUIDE.md
    CARD_ISSUANCE.md  KIOSK_INTEGRATION.md  TROUBLESHOOTING.md
```

---

## 8. Timeline — two sprints

Onboarding + Firebase environment: DONE (Day 1).

### Sprint 1 — Kodaira MVP (-> Jul 2). Daily cadence.
Goal: minimum visitor-facing system, Kodaira data loaded, running on the real tablet.

| Day | Focus |
|---|---|
| Tue 6/17 | Shared modules (tenant-loader, common, saidan.css) + seed script + page skeletons |
| Wed 6/18 | index.html + start keyboard |
| Thu 6/19 | Search Firestore query |
| Fri 6/20 | family-tree + Week review |
| Mon 6/23 | single-deceased layout (vertical text) |
| Tue 6/24 | photo + era date + BGM **(early-warning checkpoint)** |
| Wed 6/25 | end.html + card-router + import_deceased.py |
| Thu 6/26 | 912x1368 fit + load Kodaira data |
| Fri 6/27 | Cloudflare config.json + dry-run + review |
| Mon 6/30 | Real Surface Pro 7+ test |
| Tue 7/1 | Fix + freeze + rehearsal |
| **Wed 7/2** | **KODAIRA INSTALL (Ted on-site)** |

**MVP cutline (must work 7/2):** welcome->search->family-tree->single-deceased->end; STANDALONE admin (故人/家族 CRUD + photo/BGM upload + config editor) for manual data entry; Kodaira data entered manually via that admin; Surface Pro 7+ kiosk; NFC/QR routing; everything tenant-driven from Firestore.
**Can wait:** rem-multi admin integration + cross-project auth, card-issuance UI, slideshow, full docs, Tokyo_Reien.
**Admin approach:** the 7/2 admin is a STANDALONE page in the saidan project (same Firebase, plain Google login) — fast, low-risk. Porting it into rem-multi with cross-project auth is Sprint 2. Data entry is manual (no CSV import).

### Sprint 2 — Full Base + Tokyo_Reien (-> Jul 31). Weekly cadence.

| Week | Goal |
|---|---|
| Jul 3-4 | Post-install fixes + slideshow.html |
| Jul 7-11 | Port the Sprint-1 standalone admin into rem-multi + cross-project auth |
| Jul 14-18 | Card issuance UI + QR batch + Tokyo_Reien tenant prep |
| Jul 21-25 | Real-hardware end-to-end + write all 8 docs |
| Jul 28-31 | Handoff: Ted does a solo tenant-add from docs; close gaps; screencast; off-board |

**7/31 done = Ted can create a new tenant in <30 min from docs alone, and deploy a change solo.**

Fallback if Sprint 1 slips (decide by Tue 6/24): cut slideshow/admin/cards before 7/2 (already planned); Ted pre-loads Kodaira data; ship memorial text-only first; last resort Kodaira opens with search + memorial only, NFC/QR the following week.

---

## 9. Definition of Done (per task)

1. Verifiable artifact (URL / file / screenshot)
2. Tested by someone other than the author
3. Tenant-scoped — works for any `?tenant=`
4. No hardcoded data, no console errors, works on Edge
5. ASCII-only in code
6. (Week 6-7 docs) Ted can follow them solo without asking

"I wrote it" is not done. "I tested it, here's the link" is done.

---

## 10. Constraints & Conventions

### 10.1 ASCII-only in code (CRITICAL)
No Japanese, no emoji in code files, scripts, config keys, comments, commit messages, or filenames. Past Intune failures were caused by encoding issues.
Japanese IS allowed in: HTML text shown to users, Firestore string values, user-facing markdown docs, chat.

### 10.2 No Node.js / no build chain (with one admin escape hatch)
Default everything to static HTML + Vanilla JS + Tailwind CDN. No React/Next/Webpack/Vite/npm. Cloud Functions, if any, are Python.

The admin tab is genuinely more complex than the kiosk pages (forms, lists, uploads, tab state). Default it to vanilla, matching rem-multi. **Sanctioned escape hatch:** if by end of the admin week the vanilla approach is clearly slowing things down, you may add **Alpine.js or petite-vue from CDN** (no build step, no npm) to the saidan admin tab only. Decision trigger: if you write more than ~200 lines of repetitive form/list glue, raise it with Ted and add Alpine.js from CDN. Do NOT introduce React, a bundler, or split the stack (kiosk vanilla / admin React). Do NOT rewrite rem-multi.

### 10.3 No physical deletes
`status: 'archived'` + `archivedAt`. Never `deleteDoc()`.

### 10.4 Dates
Store ISO/Timestamp; display Japanese era; use the Week 1 library.

### 10.5 Tenant isolation via Security Rules
Every `tenants/{tid}/...` doc readable/writable only by an authorized user for that tid (or super-admin). Copy rem-multi's pattern.

### 10.6 Commits
English, conventional commits (`feat:`, `fix:`, `docs:`).

### 10.7 Branching
`main` for the first weeks (move fast). Switch to feature branches + PRs once the shape is clear.

### 10.8 Tailwind CSS — CDN now, purge later if needed
Use the **Tailwind Play CDN** (`<script src="https://cdn.tailwindcss.com">`) for Sprint 1 / the MVP. It is what rem-multi uses and needs zero setup. Be aware it is a ~100KB+ JS engine that compiles CSS in the browser at runtime (Tailwind's docs call it "development only"). On this kiosk that cost is acceptable: it caches after first load (the kiosk runs all day), the DOM is small, and the pages need network for Firestore anyway, so the CDN is not a new offline failure point.

**Decision rule:** at the real Surface Pro 7+ test (Mon 6/30), watch for a flash of unstyled content (FOUC) or load lag. If it's noticeable, switch to a pre-built purged stylesheet — this stays Node.js-free:
1. Download the Tailwind **standalone CLI** (single .exe, no npm / no node_modules).
2. Run it once to emit `public/css/tailwind.min.css` (only the classes used, ~10-20KB).
3. Replace `<script src="https://cdn.tailwindcss.com">` with `<link rel="stylesheet" href="/css/tailwind.min.css">`.
4. Re-run the CLI whenever new classes are added (a single-binary build step Ted can run after handoff).

If the hardware test looks fine, leave the CDN as-is. Do not add npm or a bundler either way.

---

## 11. Hardware — Surface Pro 7+ kiosk

- Surface Pro 7+ (Win 10/11), display rotated to portrait (912x1368), wall-mounted.
- Boot -> Intune auto-login as kiosk user -> `kiosk_app.exe` launches at logon -> launches Edge `--kiosk --remote-debugging-port=9222` -> reads `kiosk.smartsenior.jp/tenants/{tid}/config.json` -> navigates Edge to `welcome_url`.
- For saidan tenants, `welcome_url = https://saidans.org/?tenant={tid}`. NFC tap / QR scan -> kiosk_app navigates Edge to the resolved URL.
- You do not write or modify any of the above; your work is the page at saidans.org.

### Cloudflare config.json for a saidan tenant
```json
{
  "tenant_id": "kodaira",
  "welcome_url": "https://saidans.org/?tenant=kodaira",
  "nfc_url_template": "https://saidans.org/?tenant=kodaira&card_uid={uid}",
  "qr_url_template": "{qr_payload}",
  "thankyou_url": "https://saidans.org/end?tenant=kodaira",
  "qr_url_timeout_sec": 600,
  "online_check_url": "https://saidans.org/?ping=1"
}
```
`{uid}` is filled by kiosk_app.py with the NFC UID hex. `{qr_payload}` means use the QR's payload directly (our QRs embed full URLs).

### Intune
Reuse the Boshi Monitor pipeline (same `Smart Senior Kiosk` app). A new saidan tenant needs a device group + a Configuration Profile setting `TenantId`. Document the per-tenant Intune flow in `docs/ADD_TENANT.md`. NFC reader: ACR122U (USB). QR reader: DENSO QK30-U (USB-COM). Surface Pro 7+ has no built-in NFC — the USB reader is required.

### Network
Wired ethernet preferred (Surface Dock). kiosk_app.py handles offline display; the web app should degrade gracefully. IndexedDB offline caching is nice-to-have, out of scope for Base.

---

## 12. Resolved Decisions

| # | Question | Decision |
|---|---|---|
| 1 | DB / backend | Firebase (Firestore/Storage/Auth), new project `saidan-mt`. NOT Firebase Hosting — see #18. |
| 2 | Production domain | saidans.org |
| 3 | Tablet hardware | Surface Pro 7+, Intune kiosk |
| 4 | Frontend framework | None — static HTML + Vanilla JS (admin may use Alpine.js/petite-vue from CDN if needed; see 10.2) |
| 5 | Node.js | Not used anywhere; Cloud Functions in Python |
| 6 | NFC/QR | Handled by existing kiosk_app.py; saidan only consumes URL params |
| 7 | Slideshow | In scope for Base |
| 8 | Japanese era date | Library required, locked in Week 1 |
| 9 | Terminology | 管理団体 (kanri_dantai), not 協会 |
| 10 | Kodaira deployment | On THIS multi-tenant system as the first tenant (NOT a WordPress clone), live 7/2 |
| 11 | Tokyo_Reien deployment | Second tenant on this system, live September |
| 12 | Delivery structure | Two sprints: Kodaira MVP by 7/2, full Base by 7/31 |
| 13 | Lead developer | Linus, full-time to 7/31; Ted reviews at ~50% and owns Japanese/customer + installs |
| 14 | Tailwind delivery | Play CDN for MVP; switch to standalone-CLI purged CSS only if the 6/30 hardware test shows lag (see 10.8). No npm either way. |
| 15 | WordPress migration | NOT needed. Legacy WordPress has no data. `migrate_wp.py` dropped. |
| 16 | Data entry | MANUAL via admin console (no CSV import; `import_deceased.py` dropped). Requires the admin to exist by 7/2. |
| 17 | Admin in Sprint 1 | Full admin pulled into Sprint 1 as a STANDALONE saidan-project page (Google login, 故人/家族 CRUD, photo/BGM upload, config editor). rem-multi integration + cross-project auth + card issuance stay in Sprint 2. Higher 7/2 risk; fallback = shrink admin to "add 故人 + photo". |
| 18 | Web app hosting | **Cloudflare Pages** at saidans.org (GitHub push deploy), same infra family as Boshi Monitor kiosk-tenants. NOT Firebase Hosting. Firebase = Firestore/Storage/Auth only. `firebase` CLI still used for rules + emulator. Re-point saidans.org DNS to Cloudflare Pages if it was set to Firebase during env setup. |
| 19 | Org config | No `timezone` field — all tenants are Japan (Asia/Tokyo is a code constant). |
| 20 | Document IDs | `deceased`/`families` use Firestore auto IDs, NOT name slugs. Same name across temples -> disambiguated by `?tenant=`; same name within a temple -> by unique doc ID. See 4.0. |
| 21 | QR "temple-only" | The gate must live in the KIOSK, not in the QR (a QR param is public). QR carries only the family/person id; the kiosk supplies tenant + a secret/auth. Real enforcement (Cloud Function or auth-gated Firestore) is post-7/2; 7/2 launches with public direct-view. |

---

## 13. Communication

Daily async standup (Slack, English). Weekly 1-hour video review. Pair sessions in Week 1 on rem-multi + kiosk_app.py. PR review within 24h. Japanese content questions go to Ted — do not guess.

---

## 14. Success criteria

On Aug 1, Ted opens the repo alone and:
1. reads `docs/ADD_TENANT.md`
2. follows it (creates Firestore tenant + Cloudflare kiosk config)
3. has a working tenant within 30 minutes
4. issues NFC + QR cards for its families from the admin
5. verifies end-to-end on a Surface Pro 7+: tap card -> kiosk_app navigates Edge -> saidans.org shows the family

That is the bar. Build for the person who inherits this, not just the demo.

---

## 15. Changelog

- **v1.4 (2026-06-14):** Web app hosting moved to **Cloudflare Pages** (saidans.org, GitHub push deploy) — Firebase is now data only (Firestore/Storage/Auth), not hosting (Section 3, 2.1, decision #18). Data entry confirmed manual via admin (no CSV; `import_deceased.py` dropped) and the full admin pulled into Sprint 1 as a standalone page (decisions #16-17). Removed `timezone` from `config/main` — all Japan (decision #19). Kodaira starts with ~5 deceased (manual entry is trivial). Intune deployment tasks added. Added the document-ID rule: use Firestore auto IDs, not name slugs — disambiguates same-name people across and within temples (Section 4.0, decision #20). Added QR "temple-only" principle: the gate lives in the kiosk, not the QR; real enforcement is post-7/2 (decision #21). Confirmed URL style stays query `?tenant=` for launch; subdomains deferred.
- **v1.3 (2026-06-14, post-onboarding):** Both customers now run on this system — Kodaira is the FIRST tenant (no WordPress clone), live 7/2; Tokyo_Reien second, Sept. Added two-sprint structure with two deadlines (Kodaira MVP 7/2, Base 7/31) and the MVP cutline + fallback. Added Alpine.js/petite-vue CDN escape hatch for the admin tab only (Section 10.2). Recorded lead developer (Linus). Noted onboarding + Firebase env complete. Recorded Tailwind delivery decision: Play CDN for MVP, standalone-CLI purged CSS if the 6/30 hardware test shows lag (Section 10.8, decision #14).
- **v1.2:** Boshi Monitor kiosk_app.py integration (saidan consumes URL contract, no JS hardware code). Terminology 協会 -> 管理団体. Static-HTML / no-Node.js confirmed; Python for Functions.
- **v1.1:** Resolved open questions — new Firebase project, saidans.org, Surface Pro 7+/Intune, NFC+QR, slideshow in scope.
- **v1.0:** Initial spec.

---

## Related documents

- `docs/COMPLETION_TASKLIST.md` — the live day/week tracker to 7/31
- `docs/PAGE_BUILD_GUIDE.md` — how to build each page
- `docs/REVIEW_CHECKLIST.md` — Ted's per-week code review checklist
- `docs/junior-onboarding/` — onboarding kit (Firebase setup, Day 1)

# SmartSenior Kiosk Program

A multi-tenant memorial kiosk and admin system built with vanilla JS + Firebase, deployed on Cloudflare Pages.

---

## Live URLs

| Project | URL | Who uses it |
|---|---|---|
| Kiosk | `smartsenior-kiosk.pages.dev?site=<tenant-id>` | Guests at the cemetery |
| Admin | `smartsenior-admin.pages.dev` | Staff / managers |

### Kiosk per tenant
Each physical kiosk device just loads its own URL with the `?site=` parameter:
```
Cemetery A  →  smartsenior-kiosk.pages.dev?site=memorial-1
Cemetery B  →  smartsenior-kiosk.pages.dev?site=memorial-2
```
Same deployment, different data. No new project needed per tenant.

---

## Project Structure

```
KioskProgram/
├── kiosk/          # Public-facing kiosk (Cloudflare project: smartsenior-kiosk)
│   ├── index.html      # Home + search screen
│   ├── family.html     # Family selector page
│   ├── profile.html    # Individual memorial page
│   ├── js/
│   │   ├── config.js       # Tenant binding (?site= param)
│   │   ├── firebase.js     # Firebase init + shared helpers
│   │   ├── search.js       # Fuzzy search
│   │   ├── profile.js      # Profile rendering
│   │   └── analytics.js    # Event logging
│   └── css/
│
├── admin/          # Staff admin panel (Cloudflare project: smartsenior-admin)
│   ├── index.html      # Admin dashboard
│   ├── login.html      # Login page
│   ├── js/
│   └── css/
│
├── firestore.rules     # Firestore security rules
└── firestore.indexes.json
```

---

## Cloudflare Pages Deployment

Two separate Cloudflare Pages projects, both connected to this repo:

| Setting | Kiosk project | Admin project |
|---|---|---|
| Project name | `smartsenior-kiosk` | `smartsenior-admin` |
| Build command | (blank) | (blank) |
| Build output directory | `kiosk` | `admin` |
| Production branch | `main` | `main` |

Every push to `main` auto-deploys both projects.

---

## Multi-Tenant Setup

Each tenant (cemetery/memorial site) needs:

1. **Firebase Auth user** — create in Firebase Console → Authentication
2. **Firestore user doc** — create at `users/{uid}` with:
   ```
   display_name: "Memorial Name"
   role: "admin"
   tenant_id: "memorial-1"
   ```
3. **Kiosk URL** — `smartsenior-kiosk.pages.dev?site=memorial-1`

All admins and kiosks at the same site share the same `tenant_id`. Firestore security rules enforce that each tenant can only access their own data.

---

## Adding a New Tenant

1. Create a Firebase Auth user for the site's admin staff
2. Copy the UID and create `users/{uid}` doc in Firestore with the new `tenant_id`
3. Give the kiosk device its URL: `smartsenior-kiosk.pages.dev?site=<new-tenant-id>`
4. No code changes or redeployment needed

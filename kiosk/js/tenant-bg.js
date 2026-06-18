// tenant-bg.js — applies per-tenant visual theme from Firestore + Storage.
//
// Reads tenants/{tenantId} for: accent_color, bgm_path
// Reads Storage for: {tenantId}/background.{ext}  (conventional path)
//
// Call applyTenantBackground() on every kiosk page.

import {
  storage,
  storageRef,
  getDownloadURL,
  getTenantConfig,
} from "./firebase.js";

const EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const BG_TIMEOUT_MS = 2500;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findBackgroundURL(tenantId) {
  for (const ext of EXTENSIONS) {
    try {
      return await getDownloadURL(storageRef(storage, `${tenantId}/background.${ext}`));
    } catch (_) { /* try next */ }
  }
  return null;
}

/** Darken a #rrggbb hex color by `amount` (0–255). */
function darken(hex, amount = 20) {
  const r = Math.max(0, parseInt(hex.slice(1, 3), 16) - amount);
  const g = Math.max(0, parseInt(hex.slice(3, 5), 16) - amount);
  const b = Math.max(0, parseInt(hex.slice(5, 7), 16) - amount);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ── Accent color ─────────────────────────────────────────────────────────────

function applyAccentColor(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return;
  const root = document.documentElement;
  root.style.setProperty("--color-accent", hex);
  root.style.setProperty("--color-accent-dark", darken(hex, 20));
}

// ── BGM ───────────────────────────────────────────────────────────────────────

function setupBgm(url) {
  const audio = document.createElement("audio");
  audio.src    = url;
  audio.loop   = true;
  audio.volume = 0.35;

  // Browsers block autoplay without a prior user gesture — try immediately,
  // then retry on the first touch/click if it fails.
  const tryPlay = () => audio.play().catch(() => {});
  tryPlay();
  const onInteraction = () => {
    tryPlay();
    document.removeEventListener("click",      onInteraction);
    document.removeEventListener("touchstart", onInteraction);
  };
  document.addEventListener("click",      onInteraction, { once: true });
  document.addEventListener("touchstart", onInteraction, { once: true, passive: true });
}

async function loadBgm(bgmPath) {
  if (!bgmPath) return;
  try {
    const url = await getDownloadURL(storageRef(storage, bgmPath));
    setupBgm(url);
  } catch (err) {
    console.warn("[tenant-bg] BGM load failed:", err);
  }
}

// ── Main export ──────────────────────────────────────────────────────────────

export async function applyTenantBackground() {
  const tenantId = window.__ENV__?.TENANT_ID;

  document.body.classList.add("bg-loading");
  const timeout = setTimeout(() => document.body.classList.remove("bg-loading"), BG_TIMEOUT_MS);

  try {
    if (!tenantId) return;

    // Fetch tenant config + background URL in parallel
    const [config, bgUrl] = await Promise.all([
      getTenantConfig(),
      findBackgroundURL(tenantId),
    ]);

    // Apply accent color
    if (config.accent_color) applyAccentColor(config.accent_color);

    // Start BGM (fire-and-forget — never blocks page reveal)
    if (config.bgm_path) loadBgm(config.bgm_path);

    // Pre-load background image before revealing page
    if (bgUrl) {
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = resolve;
        img.src = bgUrl;
      });
      document.body.style.setProperty("--tenant-bg-url", `url("${bgUrl}")`);
      document.body.classList.add("has-tenant-bg");
    }

    return config;
  } catch (err) {
    console.warn("[tenant-bg] theme apply failed:", err);
    return {};
  } finally {
    clearTimeout(timeout);
    document.body.classList.remove("bg-loading");
  }
}

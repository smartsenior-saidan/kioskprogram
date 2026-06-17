// tenant-bg.js — loads a per-tenant background image from Firebase Storage.
//
// Upload your background to:  {tenantId}/background.jpg  (or .png / .webp)
// Call applyTenantBackground() on any page that should show it.

import {
  storage,
  storageRef,
  getDownloadURL,
} from "./firebase.js";

const EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

// Maximum ms to wait before showing content regardless of background load status
const BG_TIMEOUT_MS = 2500;

async function findBackgroundURL(tenantId) {
  for (const ext of EXTENSIONS) {
    try {
      const path = `${tenantId}/background.${ext}`;
      const url = await getDownloadURL(storageRef(storage, path));
      return url;
    } catch (_) {
      // not found — try next extension
    }
  }
  return null;
}

export async function applyTenantBackground() {
  const tenantId = window.__ENV__?.TENANT_ID;

  // Mark body as loading — CSS hides content until this is removed
  document.body.classList.add("bg-loading");

  // Safety valve: never block the page for more than BG_TIMEOUT_MS
  const timeout = setTimeout(() => {
    document.body.classList.remove("bg-loading");
  }, BG_TIMEOUT_MS);

  try {
    if (!tenantId) return;

    const url = await findBackgroundURL(tenantId);
    if (url) {
      // Pre-load the image so it's painted before we reveal the page
      await new Promise((resolve) => {
        const img = new Image();
        img.onload = resolve;
        img.onerror = resolve; // still reveal on error
        img.src = url;
      });

      document.body.style.setProperty("--tenant-bg-url", `url("${url}")`);
      document.body.classList.add("has-tenant-bg");
    }
  } catch (err) {
    console.warn("[tenant-bg] failed to load background:", err);
  } finally {
    clearTimeout(timeout);
    document.body.classList.remove("bg-loading");
  }
}

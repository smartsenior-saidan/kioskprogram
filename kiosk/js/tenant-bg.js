// tenant-bg.js — loads a per-tenant background image from Firebase Storage.
//
// Upload your background to:  tenants/{tenantId}/background.jpg  (or .png / .webp)
// Call applyTenantBackground() on any page that should show it.

import {
  storage,
  storageRef,
  getDownloadURL,
} from "./firebase.js";

const EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

/**
 * Try each extension in order and return the first download URL that resolves,
 * or null if the tenant has no background uploaded.
 */
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

/**
 * Fetch the tenant's background image and apply it to <body>.
 * Adds class `has-tenant-bg` when an image is found so CSS can style over it.
 * Safe to call on any page — does nothing if no image is uploaded.
 */
export async function applyTenantBackground() {
  const tenantId = window.__ENV__?.TENANT_ID;
  if (!tenantId) return;

  try {
    const url = await findBackgroundURL(tenantId);
    if (!url) return;

    document.body.style.setProperty("--tenant-bg-url", `url("${url}")`);
    document.body.classList.add("has-tenant-bg");
  } catch (err) {
    // Non-critical — kiosk works fine without a background
    console.warn("[tenant-bg] failed to load background:", err);
  }
}

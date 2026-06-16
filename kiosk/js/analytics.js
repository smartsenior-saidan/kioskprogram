// analytics.js — log kiosk events to the search_events collection.
//
// Event types: search_query, profile_view, slideshow_play, video_play,
// nfc_tap, qr_scan. Every event is tenant-scoped and stamped with the device.

import {
  db,
  collection,
  addDoc,
  serverTimestamp,
  COLLECTIONS,
  TENANT_ID,
  DEVICE_ID,
} from "./firebase.js";

export const EVENT_TYPES = Object.freeze({
  SEARCH_QUERY: "search_query",
  PROFILE_VIEW: "profile_view",
  SLIDESHOW_PLAY: "slideshow_play",
  VIDEO_PLAY: "video_play",
  NFC_TAP: "nfc_tap",
  QR_SCAN: "qr_scan",
});

/**
 * Core logger. Fire-and-forget: analytics must never break the guest UX, so
 * failures are swallowed (and only warned to the console).
 */
export async function logEvent(eventType, details = {}) {
  const payload = {
    tenant_id: TENANT_ID,
    device_id: DEVICE_ID,
    event_type: eventType,
    person_id: details.personId || null,
    query: details.query || null,
    timestamp: serverTimestamp(),
  };

  try {
    await addDoc(collection(db, COLLECTIONS.events), payload);
  } catch (err) {
    console.warn(`[analytics] failed to log ${eventType}:`, err);
  }
}

// --- Convenience wrappers --------------------------------------------------

// Search queries are intentionally NOT persisted (privacy / no need to store
// what visitors type). This is a no-op kept so existing call sites still work.
export const logSearch = (_queryText) => {};

export const logProfileView = (personId) =>
  logEvent(EVENT_TYPES.PROFILE_VIEW, { personId });

export const logSlideshowPlay = (personId) =>
  logEvent(EVENT_TYPES.SLIDESHOW_PLAY, { personId });

export const logVideoPlay = (personId) =>
  logEvent(EVENT_TYPES.VIDEO_PLAY, { personId });

export const logNfcTap = (personId) =>
  logEvent(EVENT_TYPES.NFC_TAP, { personId });

export const logQrScan = (personId) =>
  logEvent(EVENT_TYPES.QR_SCAN, { personId });

export function logArrivalSource(personId) {
  const via = new URLSearchParams(window.location.search).get("via");
  if (via === "nfc") logNfcTap(personId);
  else if (via === "qr") logQrScan(personId);
}

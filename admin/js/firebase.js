// firebase.js — Firebase v9+ modular SDK initialization + shared helpers.
//
// The Firebase SDK is loaded from the CDN inside each HTML file as an ES module,
// so this file is itself an ES module and re-exports everything the other
// modules need. Because static pages can't read a .env file, configuration is
// read from `window.__ENV__` if a host injects it, otherwise from the inline
// fallback below. Copy your .env values into FALLBACK_CONFIG for local dev.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  setPersistence,
  browserSessionPersistence,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// --- Configuration ---------------------------------------------------------

// Inline fallback. Replace with your project's values for local development.
// In production prefer injecting window.__ENV__.
const FALLBACK_CONFIG = {
  apiKey: "AIzaSyA-SQmJrGINcd1i2BfnY64urhsYMjBBQts",
  authDomain: "smartsenior-kiosk.firebaseapp.com",
  projectId: "smartsenior-kiosk",
  storageBucket: "smartsenior-kiosk.firebasestorage.app",
  messagingSenderId: "1020345537805",
  appId: "1:1020345537805:web:72132a7eff1c9e67cacc44",
  measurementId: "G-GCQV80RTVW",
};

const ENV = (typeof window !== "undefined" && window.__ENV__) || {};

const firebaseConfig = {
  apiKey: ENV.FIREBASE_API_KEY || FALLBACK_CONFIG.apiKey,
  authDomain: ENV.FIREBASE_AUTH_DOMAIN || FALLBACK_CONFIG.authDomain,
  projectId: ENV.FIREBASE_PROJECT_ID || FALLBACK_CONFIG.projectId,
  storageBucket: ENV.FIREBASE_STORAGE_BUCKET || FALLBACK_CONFIG.storageBucket,
  messagingSenderId:
    ENV.FIREBASE_MESSAGING_SENDER_ID || FALLBACK_CONFIG.messagingSenderId,
  appId: ENV.FIREBASE_APP_ID || FALLBACK_CONFIG.appId,
  measurementId: ENV.FIREBASE_MEASUREMENT_ID || FALLBACK_CONFIG.measurementId,
};

// Active tenant — set from the logged-in user's Firestore record (stored in sessionStorage by login.js).
export const TENANT_ID =
  sessionStorage.getItem("ss_tenant_id") ||
  ENV.TENANT_ID ||
  "demo-tenant";

export const ROLE = sessionStorage.getItem("ss_role") || "admin";
export const DISPLAY_NAME = sessionStorage.getItem("ss_display_name") || "";
export const DEVICE_ID = ENV.DEVICE_ID || "admin-001";

// --- Initialize ------------------------------------------------------------

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app);

// Session-only persistence: signing in stays valid while this browser tab/session
// is open (surviving the login.html -> index.html redirect), but closing the
// browser clears it. Prevents a login from silently auto-restoring forever on a
// shared/demo device — every fresh session must sign in again.
setPersistence(auth, browserSessionPersistence).catch((err) =>
  console.warn("[admin] failed to set auth persistence:", err)
);

export { signInWithEmailAndPassword, sendPasswordResetEmail, onAuthStateChanged, signOut };

// Collection name constants (single source of truth).
export const COLLECTIONS = {
  tenants: "tenants",
  devices: "kiosk_devices",
  persons: "deceased_persons",
  families: "families",
};

/** Reference to the media subcollection for a specific person. */
export function personMediaCollection(personId) {
  return collection(db, COLLECTIONS.persons, personId, "media");
}

/** Reference to a specific media doc in the subcollection. */
export function personMediaDoc(personId, mediaId) {
  return doc(db, COLLECTIONS.persons, personId, "media", mediaId);
}

// Re-export Firestore + Storage helpers so other modules import from one place.
export {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
};

// --- Tenant-scoped query helpers -------------------------------------------

export function tenantQuery(collectionName, ...constraints) {
  return query(
    collection(db, collectionName),
    where("tenant_id", "==", TENANT_ID),
    ...constraints
  );
}

export function withTenant(data) {
  return {
    created_at: serverTimestamp(),
    ...data,
    tenant_id: TENANT_ID,
  };
}

console.info(`[SmartSenior] Firebase initialized — tenant: ${TENANT_ID}`);

import {
  auth,
  db,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  doc,
  getDoc,
} from "./firebase.js";

const form      = document.getElementById("loginForm");
const emailEl   = document.getElementById("email");
const passEl    = document.getElementById("password");
const signInBtn = document.getElementById("signInBtn");
const forgotBtn = document.getElementById("forgotBtn");
const statusEl  = document.getElementById("loginStatus");

function showStatus(msg, kind = "error") {
  statusEl.className = `login-status ${kind}`;
  statusEl.textContent = msg;
  statusEl.classList.remove("hidden");
}

function clearStatus() {
  statusEl.classList.add("hidden");
}

function friendlyError(code) {
  switch (code) {
    case "auth/invalid-email":         return "Please enter a valid email address.";
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":    return "Incorrect email or password.";
    case "auth/too-many-requests":     return "Too many attempts. Please wait a moment and try again.";
    case "auth/user-disabled":         return "This account has been disabled. Contact SmartSenior support.";
    default:                           return "Sign in failed. Please try again.";
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearStatus();

  const email    = emailEl.value.trim();
  const password = passEl.value;

  if (!email || !password) {
    showStatus("Please enter your email and password.");
    return;
  }

  signInBtn.disabled = true;
  signInBtn.textContent = "Signing in…";

  try {
    const { user } = await signInWithEmailAndPassword(auth, email, password);

    // Look up this user's memorial-site assignment in Firestore.
    const userSnap = await getDoc(doc(db, "users", user.uid));
    const userData = userSnap.exists() ? userSnap.data() : {};

    // No tenant = the account hasn't been linked to a memorial site yet.
    // Refuse rather than silently dropping into a shared "demo" tenant.
    if (!userData.tenant_id) {
      await signOut(auth);
      sessionStorage.clear();
      showStatus("This account isn't linked to a memorial site yet. Contact SmartSenior.");
      signInBtn.disabled = false;
      signInBtn.textContent = "Sign In";
      return;
    }

    sessionStorage.setItem("ss_tenant_id", userData.tenant_id);
    sessionStorage.setItem("ss_role", userData.role || "admin");
    sessionStorage.setItem("ss_display_name", userData.display_name || user.email);

    window.location.href = "index.html";
  } catch (err) {
    showStatus(friendlyError(err.code));
    signInBtn.disabled = false;
    signInBtn.textContent = "Sign In";
  }
});

forgotBtn.addEventListener("click", async () => {
  const email = emailEl.value.trim();
  if (!email) {
    showStatus("Enter your email address above, then tap Forgot password.", "info");
    emailEl.focus();
    return;
  }

  forgotBtn.disabled = true;
  try {
    await sendPasswordResetEmail(auth, email);
    showStatus("Password reset email sent. Check your inbox.", "success");
  } catch {
    showStatus("Could not send reset email. Check the address and try again.");
  } finally {
    forgotBtn.disabled = false;
  }
});

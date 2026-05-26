// public-admin/login.js
// Admin login page logic.

// Base paths and allowed redirect targets.
const AUTH_BASE = "/3d-kartan/backend/auth";
const DEFAULT_TARGET = "/admin/forms.html";
const FORMS_TARGET = "/admin/forms.html";
const SUBS_TARGET = "/admin/submissions.html";

// Cached DOM references.
const toastHost = document.getElementById("toastHost");
const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const formsToggle = document.getElementById("formsToggle");
const subsToggle = document.getElementById("subsToggle");

// Displays a self-dismissing toast notification.
// type: 'success' | 'error'   timeout: milliseconds before auto-removal
function toast(title, msg, type="success", timeout=3500) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="title">${title}</div><div class="msg">${msg}</div>`;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

// Read the ?next= param from the current URL – never touches localStorage
function getSafeNext() {
  try {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("next");
    if (t === FORMS_TARGET || t === SUBS_TARGET) return t;
  } catch (_) {}
  return DEFAULT_TARGET;
}

// Update the URL in-place so each tab keeps its own ?next= value
function setNext(target) {
  const valid = target === SUBS_TARGET ? SUBS_TARGET : FORMS_TARGET;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("next", valid);
    history.replaceState(null, "", url.toString());
  } catch (_) {}
  updateToggleUI(valid);
}

// Syncs the active/inactive styling of the two toggle buttons to match target.
function updateToggleUI(target) {
  const t = target === SUBS_TARGET ? SUBS_TARGET : FORMS_TARGET;
  if (t === FORMS_TARGET) {
    formsToggle.classList.add("active");
    subsToggle.classList.remove("active");
  } else {
    subsToggle.classList.add("active");
    formsToggle.classList.remove("active");
  }
}

// Toggle buttons – update the ?next= param and button styling on click.
formsToggle.addEventListener("click", () => setNext(FORMS_TARGET));
subsToggle.addEventListener("click", () => setNext(SUBS_TARGET));

// Login form submission – POST credentials to the auth API.
// On success, redirects to the target page stored in the ?next= param.
// On failure, shows a toast with the server error message.
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  loginBtn.disabled = true;
  loginBtn.textContent = "Loggar in…";

  try {
    const res = await fetch(`${AUTH_BASE}/login`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = json?.error?.message || json?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    toast("Inloggad", "Du loggas nu in i admin‑gränssnittet.", "success", 2000);

    const target = getSafeNext();
    window.location.href = target;
  } catch (err) {
    toast("Fel vid inloggning", err.message || "Okänt fel", "error", 5000);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Logga in";
  }
});

// Boot: set toggle from the ?next= URL param (no localStorage)
(function init() {
  const target = getSafeNext();
  updateToggleUI(target);
})();

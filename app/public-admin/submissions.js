// public-admin/submissions.js
// Admin submissions viewer page logic.

// Base API paths.
const API_BASE = "/3d-kartan/backend/admin";
const AUTH_BASE = "/3d-kartan/backend/auth";
const LOGIN_PAGE = "/admin/login.html";
const THIS_PAGE = "/admin/submissions.html";

// Cached DOM references.
const toastHost = document.getElementById("toastHost");
const overlayEl = document.getElementById("overlay");
const formsListEl = document.getElementById("formsList");
const rowsEl = document.getElementById("rows");
const statusEl = document.getElementById("status");
const metaEl = document.getElementById("meta");
const searchEl = document.getElementById("search");
const currentUserLabel = document.getElementById("currentUserLabel");
const logoutBtn = document.getElementById("logoutBtn");

// The last loaded submissions array, kept in memory for client-side
// filtering and JSON export without re-fetching.
let lastSubmissions = [];
let lastFormId = "";

// ---------------------------------------------------------------------------
// Idle timeout – logs the user out after 30 minutes of inactivity.
// ---------------------------------------------------------------------------
const IDLE_LIMIT_MS = 30 * 60 * 1000;
let idleTimer = null;

// Resets the idle countdown. Called on every user interaction event.
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(onIdleTimeout, IDLE_LIMIT_MS);
}

// Called when the idle timer fires. Attempts a best-effort server-side
// logout, shows a notification, then redirects to the login page.
async function onIdleTimeout() {
  try {
    await fetch(`${AUTH_BASE}/logout`, {
      method: "POST",
      credentials: "include"
    });
  } catch (_) {
    // Ignore network errors – the redirect below handles the outcome.
  } finally {
    toast("Utloggad", "Du har loggats ut p.g.a. inaktivitet.", "success", 3000);
    window.location.href = `${LOGIN_PAGE}?next=${encodeURIComponent(THIS_PAGE)}`;
  }
}

["click", "mousemove", "keydown", "touchstart"].forEach((eventName) => {
  window.addEventListener(eventName, resetIdleTimer, { passive: true });
});

window.addEventListener("beforeunload", (e) => {
  try {
    const data = JSON.stringify({ reason: "tab_closed" });
    navigator.sendBeacon(`${AUTH_BASE}/logout`, data);
  } catch (_) {
    // ignore
  }
});

// Shows or hides the loading overlay and disables interactive buttons.
function setBusy(on) {
  overlayEl.classList.toggle("show", !!on);
  ["refreshBtn","exportBtn"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !!on;
  });
}

// Serialises obj as pretty-printed JSON into the status debug panel.
function setStatus(obj) {
  statusEl.textContent = JSON.stringify(obj, null, 2);
}

// Displays a self-dismissing toast notification.
// type: 'success' | 'error'   timeout: milliseconds before auto-removal
function toast(title, msg, type="success", timeout=3500) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="title">${title}</div><div class="msg">${msg}</div>`;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

// Fetch wrapper that always sends the session cookie.
// Intercepts 401 responses and redirects to the login page.
// Throws on non-2xx responses with status and body attached to the error.
async function apiJson(url, options = {}) {
  const opts = {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  };

  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));

  if (res.status === 401) {
    toast("Session slut", "Du behöver logga in igen.", "error", 3000);
    window.location.href = `${LOGIN_PAGE}?next=${encodeURIComponent(THIS_PAGE)}`;
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const msg = json?.error?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

// Verifies the current session against GET /auth/me and populates the
// logged-in username label. Redirects to login on 401 or network error.
async function fetchCurrentUser() {
  try {
    const res = await fetch("/3d-kartan/backend/auth/me", {
      method: "GET",
      credentials: "include",
      headers: { "Content-Type": "application/json" }
    });

    if (res.status === 401) {
      window.location.href = `${LOGIN_PAGE}?next=${encodeURIComponent(THIS_PAGE)}`;
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (data?.user?.username) {
      currentUserLabel.textContent = `Inloggad som: ${data.user.username}`;
    } else {
      currentUserLabel.textContent = "";
    }
  } catch (_) {
    window.location.href = `${LOGIN_PAGE}?next=${encodeURIComponent(THIS_PAGE)}`;
  }
}

// Formats an ISO date string as a locale-aware Swedish date/time string.
function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("sv-SE");
}

// Escapes a value for safe insertion into an HTML context.
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Coerces a value to a finite number, or returns null.
function toNumber(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Formats a coordinate value to 6 decimal places.
function fmtCoord(v) {
  return Number(v).toFixed(6);
}

// Builds a Google Maps search URL for a lat/lon pair.
function mapsLink(lat, lon) {
  const q = encodeURIComponent(`${lat},${lon}`);
  return `https://www.google.com/maps?q=${q}`;
}

// Coordinates: check submission.location.{lon,lat} (API format) then fallbacks
function extractLatLon(submission) {
  {
    const lat = toNumber(submission?.location?.lat);
    const lon = toNumber(submission?.location?.lon);
    if (lat !== null && lon !== null) return { lat, lon, source: "location" };
  }

  {
    const lat = toNumber(submission?.lat);
    const lon = toNumber(submission?.lon);
    if (lat !== null && lon !== null) return { lat, lon, source: "top-level" };
  }

  const d = submission?.data ?? {};

  {
    const lat = toNumber(d.lat ?? d.latitude);
    const lon = toNumber(d.lon ?? d.lng ?? d.longitude);
    if (lat !== null && lon !== null) return { lat, lon, source: "data lat/lon" };
  }

  const g = d.geometry ?? d.geom;
  if (g && g.type === "Point" && Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
    const lon = toNumber(g.coordinates[0]);
    const lat = toNumber(g.coordinates[1]);
    if (lat !== null && lon !== null) return { lat, lon, source: "geojson" };
  }

  return null;
}

// Renders the submissions table, applying the current search filter.
// The filter is a plain substring match against the full JSON of each submission.
function renderTable(items) {
  rowsEl.innerHTML = "";

  const q = (searchEl.value || "").trim().toLowerCase();

  const filtered = !q ? items : items.filter(s => {
    const hay = JSON.stringify(s.data ?? s, null, 0).toLowerCase();
    return hay.includes(q);
  });

  metaEl.textContent = `${filtered.length} / ${items.length} submissions`;

  if (!filtered.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5" class="text-center subtle">(Inga submissions hittades)</td>`;
    rowsEl.appendChild(tr);
    return;
  }

  for (const s of filtered) {
    const id = s.id || s._id || "";
    const created = s.created || s.createdAt || s._created || "";
    const updated = s.updated || s.updatedAt || s._updated || "";
    const data = (s.data ?? s);

    const ll = extractLatLon(s);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${escapeHtml(id)}</td>
      <td>${escapeHtml(fmtDate(created))}</td>
      <td>${escapeHtml(fmtDate(updated))}</td>
      <td>
        ${
          ll
            ? `<div class="mono">${escapeHtml(fmtCoord(ll.lat))}, ${escapeHtml(fmtCoord(ll.lon))}</div>
               <a href="${mapsLink(ll.lat, ll.lon)}" target="_blank" rel="noopener">Öppna i karta</a>`
            : `<span class="subtle">(saknas)</span>`
        }
      </td>
      <td><pre class="mono mb-0" style="white-space: pre-wrap;">${escapeHtml(JSON.stringify(data, null, 2))}</pre></td>
    `;
    rowsEl.appendChild(tr);
  }
}

// Fetches all forms and populates the form selector dropdown.
async function refreshForms() {
  const forms = await apiJson(`${API_BASE}/forms`, { method: "GET" });
  const items = forms.data || [];

  formsListEl.innerHTML = "";
  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = "-- välj formulär --";
  formsListEl.appendChild(ph);

  for (const f of items) {
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = `${f.name || f.id} (${(f.status || "draft").toUpperCase()})`;
    formsListEl.appendChild(opt);
  }
}

// Fetches and renders submissions for the given formId.
// Caches the result in lastSubmissions for filtering and export.
async function refreshSubmissions(formId) {
  if (!formId) return;

  setBusy(true);
  try {
    const subs = await apiJson(`${API_BASE}/forms/${encodeURIComponent(formId)}/submissions`, { method: "GET" });

    lastFormId = formId;
    lastSubmissions = subs.data || [];
    setStatus({ ok: true, formId, count: lastSubmissions.length, page: subs.page });

    renderTable(lastSubmissions);
  } catch (e) {
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    rowsEl.innerHTML = `<tr><td colspan="5" class="text-center text-danger">Fel: ${escapeHtml(e.message)}</td></tr>`;
    toast("Kunde inte hämta submissions", e.message, "error");
  } finally {
    setBusy(false);
  }
}

// Clear the status panel.
document.getElementById("clearStatusBtn").onclick = () => setStatus({});

// Refresh button – re-fetch submissions for the currently selected form.
document.getElementById("refreshBtn").onclick = async () => {
  const id = formsListEl.value;
  if (!id) return toast("Välj formulär", "Välj ett formulär först.", "error");
  await refreshSubmissions(id);
};

// Export button – downloads the cached submissions as a JSON file.
document.getElementById("exportBtn").onclick = () => {
  if (!lastFormId) return toast("Inget att exportera", "Ladda submissions först.", "error");
  const blob = new Blob([JSON.stringify(lastSubmissions, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `submissions-${lastFormId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// Form selector – load submissions whenever a different form is chosen.
formsListEl.onchange = async () => {
  const id = formsListEl.value;
  if (!id) {
    lastSubmissions = [];
    lastFormId = "";
    metaEl.textContent = "";
    rowsEl.innerHTML = "";
    return;
  }
  await refreshSubmissions(id);
};

// Search box – re-render the table with the updated filter on every keystroke.
searchEl.addEventListener("input", () => renderTable(lastSubmissions));

// Logout button – destroys the server-side session and redirects to login.
logoutBtn.onclick = async () => {
  try {
    setBusy(true);
    await fetch(`${AUTH_BASE}/logout`, {
      method: "POST",
      credentials: "include"
    });
  } catch (_) {
    // Ignore network errors – we redirect regardless.
  } finally {
    setBusy(false);
    window.location.href = `${LOGIN_PAGE}?next=${encodeURIComponent(THIS_PAGE)}`;
  }
};

// Boot sequence – runs once on page load.
(async () => {
  try {
    setBusy(true);
    resetIdleTimer();          // Start the idle timer.
    await fetchCurrentUser();  // Verify session and display the logged-in user.
    await refreshForms();
    setStatus({ ok: true, message: "Ready" });
  } catch (e) {
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    // fetchCurrentUser redirects on 401; only genuine errors reach here.
    toast("Start misslyckades", e.message, "error");
  } finally {
    setBusy(false);
  }
})();

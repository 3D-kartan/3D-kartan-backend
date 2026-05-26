// public-admin/forms.js
// Admin form builder page logic.
// Depends on: formio.full.min.js (sets window.Formio), bootstrap.min.css.

// Cached DOM references.
const statusEl = document.getElementById("status");
const nameEl = document.getElementById("name");
const formIdEl = document.getElementById("formId");
const saveStateEl = document.getElementById("saveState");
const overlayEl = document.getElementById("overlay");
const deleteHintEl = document.getElementById("deleteHint");

const formsListEl = document.getElementById("formsList");
const statusFilterEl = document.getElementById("statusFilter");
const toastHost = document.getElementById("toastHost");
const logoutBtn = document.getElementById("logoutBtn");
const currentUserLabel = document.getElementById("currentUserLabel");

// Active Form.io builder instance; replaced each time a form is loaded or reset.
let builder = null;
// Tracks whether there are unsaved changes in the builder.
let isDirty = false;
// Debounce handle for the builder onChange event.
let changeDebounce = null;
// Status of the currently loaded form ('draft' | 'published' | 'finished' | null).
// null means no form has been loaded through the UI yet.
let currentFormStatus = null;

// Base API paths.
const API_BASE = "/3d-kartan/backend/admin";
const AUTH_BASE = "/3d-kartan/backend/auth";
const LOGIN_PAGE = "/admin/login.html";

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
    window.location.href = `${LOGIN_PAGE}?next=/admin/forms.html`;
  }
}

["click", "mousemove", "keydown", "touchstart"].forEach((eventName) => {
  window.addEventListener(eventName, resetIdleTimer, { passive: true });
});

// Tab close – attempt a best-effort logout via sendBeacon so the session
// is cleaned up server-side even when the tab is closed abruptly.
window.addEventListener("beforeunload", (e) => {
  if (isDirty) {
    // Warn the user about unsaved changes before leaving.
    e.preventDefault();
    e.returnValue = "";
  }

  try {
    const data = JSON.stringify({ reason: "tab_closed" });
    navigator.sendBeacon(`${AUTH_BASE}/logout`, data);
  } catch (_) {
    // ignore
  }
});

// Shows or hides the loading overlay and disables all toolbar buttons.
function setBusy(on) {
  overlayEl.classList.toggle("show", !!on);
  ["newBtn","loadBtn","saveBtn","publishBtn","archiveBtn","refreshListBtn","deleteBtn","logoutBtn"].forEach(id => {
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

// Updates the unsaved-changes badge in the page header.
function setDirty(dirty) {
  isDirty = !!dirty;
  if (isDirty) {
    saveStateEl.textContent = "Osparad";
    saveStateEl.classList.remove("badge-saved");
    saveStateEl.classList.add("badge-dirty");
  } else {
    saveStateEl.textContent = "Sparad";
    saveStateEl.classList.remove("badge-dirty");
    saveStateEl.classList.add("badge-saved");
  }
}

// Updates the hint text below the delete button to show the DELETE endpoint
// that will be called, or an 'no form selected' message when formId is empty.
function updateDeleteHint() {
  const id = (formIdEl.value || "").trim();
  deleteHintEl.textContent = id ? `DELETE ${API_BASE}/forms/${id}` : "Ingen Form ID vald.";
}

// Destroys the current Form.io builder and mounts a fresh one with the
// given schema. Marks the builder as clean and attaches the change listener.
async function initBuilder(schema) {
  document.getElementById("builder").innerHTML = "";
  builder = await Formio.builder(document.getElementById("builder"), schema || { components: [] });

  builder.on("change", () => {
    clearTimeout(changeDebounce);
    changeDebounce = setTimeout(() => setDirty(true), 250);
  });
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
    window.location.href = `${LOGIN_PAGE}?next=/admin/forms.html`;
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

// Fetches all forms from the API and populates the forms list selector.
// Client-side filters the result by the currently selected statusFilter value.
async function refreshFormsList() {
  try {
    setBusy(true);
    formsListEl.innerHTML = "";

    const forms = await apiJson(`${API_BASE}/forms`, { method: "GET" });
    const filter = statusFilterEl.value;
    const allItems = forms.data || [];
    const items = filter === "all" ? allItems : allItems.filter(f => f.status === filter);

    if (!items.length) {
      const opt = document.createElement("option");
      opt.textContent = "(Inga formulär hittades)";
      opt.disabled = true;
      formsListEl.appendChild(opt);
      return;
    }

    items.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.id;
      const status = (f.status || "draft").toUpperCase();
      opt.textContent = `${f.name || f.id} — ${status}`;
      formsListEl.appendChild(opt);
    });
  } catch (e) {
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    toast("Kunde inte hämta lista", e.message, "error");
  } finally {
    setBusy(false);
  }
}

// Loads a form by ID into the builder: fetches metadata, resolves the active
// version schema, and updates all UI fields. Sets currentFormStatus so that
// the delete and archive handlers know the form's current state.
async function loadForm(formId) {
  if (!formId) throw new Error("No formId");
  setBusy(true);
  try {
    const formJson = await apiJson(`${API_BASE}/forms/${encodeURIComponent(formId)}`, { method: "GET" });
    const form = formJson.data;
    currentFormStatus = form.status ?? null;

    // Fetch schema from the active version (may 404 for finished forms)
    let schema = { components: [] };
    try {
      const versionJson = await apiJson(
        `${API_BASE}/forms/${encodeURIComponent(formId)}/active-version`,
        { method: "GET" }
      );
      schema = versionJson.data?.schema || { components: [] };
    } catch {
      // form may not have a loaded active version (e.g. deleted/finished)
    }

    nameEl.value = form.name || "";
    formIdEl.value = form.id || formId;

    await initBuilder(schema);

    setStatus(form);
    setDirty(false);
    updateDeleteHint();
    toast("Laddat", "Formuläret är laddat.", "success");
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// UI event handlers
// ---------------------------------------------------------------------------

// Clear the status debug panel.
document.getElementById("clearStatusBtn").onclick = () => setStatus({});

// Mark the form dirty whenever the name field is edited.
nameEl.addEventListener("input", () => setDirty(true));
// Refresh the delete hint whenever the Form ID field changes.
formIdEl.addEventListener("input", updateDeleteHint);

// New button – resets the builder to an empty form after confirming unsaved changes.
document.getElementById("newBtn").onclick = async () => {
  if (isDirty) {
    const ok = confirm("Du har osparade ändringar. Vill du skapa ett nytt formulär ändå?");
    if (!ok) return;
  }
  formIdEl.value = "";
  nameEl.value = "Nytt formulär";
  currentFormStatus = null;
  await initBuilder({ components: [] });
  setStatus({ ok: true, message: "New builder initialized" });
  setDirty(false);
  updateDeleteHint();
  toast("Nytt formulär", "Skapade ett tomt formulär.", "success");
};

// Save button – POST (create) or PATCH (update) the form depending on
// whether a Form ID is already set.
document.getElementById("saveBtn").onclick = async () => {
  try {
    setBusy(true);

    const schema = builder?.schema || { components: [] };
    const name = (nameEl.value || "").trim();
    if (!name) {
      toast("Saknar namn", "Fyll i ett formulärnamn.", "error");
      return;
    }

    const formId = (formIdEl.value || "").trim();
    const url = formId ? `${API_BASE}/forms/${encodeURIComponent(formId)}` : `${API_BASE}/forms`;
    const method = formId ? "PATCH" : "POST";

    const json = await apiJson(url, {
      method,
      body: JSON.stringify({ name, schema })
    });

    formIdEl.value = json.data?.id || formIdEl.value;
    setStatus(json);
    setDirty(false);
    updateDeleteHint();
    toast("Sparat", "Formuläret är sparat.", "success");
    refreshFormsList();
  } catch (e) {
    if (e.message === "Unauthorized") return;
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    toast("Spara misslyckades", e.message, "error");
  } finally {
    setBusy(false);
  }
};

// Publish button – transitions the current DRAFT form to PUBLISHED status.
document.getElementById("publishBtn").onclick = async () => {
  try {
    setBusy(true);

    const formId = (formIdEl.value || "").trim();
    if (!formId) {
      toast("Saknar Form ID", "Spara formuläret först.", "error");
      return;
    }

    const json = await apiJson(`${API_BASE}/forms/${encodeURIComponent(formId)}/publish`, { method: "POST" });
    currentFormStatus = "published";
    setStatus(json.data || json);
    toast("Publicerat", "Formuläret är publicerat.", "success");
    refreshFormsList();
  } catch (e) {
    if (e.message === "Unauthorized") return;
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    toast("Publicering misslyckades", e.message, "error");
  } finally {
    setBusy(false);
  }
};

// Archive button – transitions the current PUBLISHED form to FINISHED status.
// Finished forms no longer accept new submissions.
document.getElementById("archiveBtn").onclick = async () => {
  try {
    setBusy(true);

    const formId = (formIdEl.value || "").trim();
    if (!formId) {
      toast("Saknar Form ID", "Ladda ett formulär först.", "error");
      return;
    }

    const ok = confirm(`Arkivera formuläret?\n\nID: ${formId}\n\nEtt arkiverat formulär stänger för nya svar och kan inte publiceras igen.`);
    if (!ok) return;

    const json = await apiJson(`${API_BASE}/forms/${encodeURIComponent(formId)}/finish`, { method: "POST" });
    currentFormStatus = "finished";
    setStatus(json.data || json);
    toast("Arkiverat", "Formuläret är arkiverat.", "success");
    refreshFormsList();
  } catch (e) {
    if (e.message === "Unauthorized") return;
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    toast("Arkivering misslyckades", e.message, "error");
  } finally {
    setBusy(false);
  }
};

// Delete button – soft-deletes a DRAFT form.
// Blocks deletion of published and finished forms with an alert, and requires
// the form to have been loaded through the UI so the status is known.
document.getElementById("deleteBtn").onclick = async () => {
  const formId = (formIdEl.value || "").trim();
  if (!formId) {
    toast("Saknar Form ID", "Välj ett formulär först.", "error");
    return;
  }

  if (currentFormStatus === null) {
    toast("Ladda formuläret", "Dubbelklicka i listan för att ladda formuläret innan du raderar.", "error");
    return;
  }

  if (currentFormStatus === "published" || currentFormStatus === "finished") {
    alert("Radering av publicerade och arkiverade formulär kan bara ske via databasen.");
    return;
  }

  const ok = confirm(`Radera utkastet?\n\nID: ${formId}\n\nDetta går inte att ångra.`);
  if (!ok) return;

  try {
    setBusy(true);
    const json = await apiJson(
      `${API_BASE}/forms/${encodeURIComponent(formId)}`,
      { method: "DELETE" }
    );

    currentFormStatus = null;
    setStatus(json.data || json);
    toast("Raderat", "Formuläret är raderat.", "success");

    formIdEl.value = "";
    nameEl.value = "Nytt formulär";
    await initBuilder({ components: [] });
    setDirty(false);
    updateDeleteHint();
    refreshFormsList();
  } catch (e) {
    if (e.message === "Unauthorized") return;
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    toast("Radering misslyckades", e.message, "error");
  } finally {
    setBusy(false);
  }
};

// Load button – fetches and opens the form whose ID is in the Form ID field.
document.getElementById("loadBtn").onclick = async () => {
  try {
    const formId = (formIdEl.value || "").trim();
    if (!formId) {
      toast("Saknar Form ID", "Fyll i ett Form ID eller välj i listan.", "error");
      return;
    }
    if (isDirty) {
      const ok = confirm("Du har osparade ändringar. Vill du ladda och skriva över dem?");
      if (!ok) return;
    }
    await loadForm(formId);
  } catch (e) {
    if (e.message === "Unauthorized") return;
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    toast("Ladda misslyckades", e.message, "error");
  }
};

// Refresh list button – re-fetches the forms list.
document.getElementById("refreshListBtn").onclick = refreshFormsList;
// Status filter – re-renders the list whenever the filter changes.
statusFilterEl.addEventListener("change", refreshFormsList);

// Forms list – double-click to load the selected form into the builder.
formsListEl.addEventListener("dblclick", async () => {
  const id = formsListEl.value;
  if (!id) return;

  if (isDirty) {
    const ok = confirm("Du har osparade ändringar. Vill du ladda och skriva över dem?");
    if (!ok) return;
  }

  try {
    await loadForm(id);
  } catch (e) {
    if (e.message === "Unauthorized") return;
    setStatus({ error: true, message: e.message, status: e.status, body: e.body });
    toast("Ladda misslyckades", e.message, "error");
  }
});

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
    window.location.href = `${LOGIN_PAGE}?next=/admin/forms.html`;
  }
};

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
      window.location.href = `${LOGIN_PAGE}?next=/admin/forms.html`;
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (data?.user?.username) {
      currentUserLabel.textContent = `Inloggad som: ${data.user.username}`;
    } else {
      currentUserLabel.textContent = "";
    }
  } catch (_) {
    window.location.href = `${LOGIN_PAGE}?next=/admin/forms.html`;
  }
}

// Boot sequence – runs once on page load.
(async () => {
  resetIdleTimer();         // Start the idle timer.
  await fetchCurrentUser(); // Verify session and display the logged-in user.
  await initBuilder({ components: [] });
  setStatus({ ok: true, message: "Ready" });
  setDirty(false);
  updateDeleteHint();
  refreshFormsList();       // Populate the list; errors are non-fatal here.
})();

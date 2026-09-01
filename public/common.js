/* =========================================================
   common.js — shared across every page: auth guard, header/
   footer rendering, API helpers, working-time math.
   ========================================================= */

const STAGE_DURATIONS = {
  "Not Selected": 0,
  "Indicative": 5,
  "Detail Design": 20,
  "Pricing": 2,
  "Handover": 3,
  "Redesign": 5,
  "Repricing": 2,
  "ECI": 10,
  "Tender": 10,
};

/* ---------------------------------------------------------
   API helpers
   --------------------------------------------------------- */
async function apiGet(url) {
  const res = await fetch(url, { credentials: "same-origin" });
  if (res.status === 401) { redirectToLogin(); throw new Error("Not signed in"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `GET ${url} failed`);
  return res.json();
}
async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) { redirectToLogin(); throw new Error("Not signed in"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed");
  return res.json();
}
async function apiPatch(url, payload) {
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) { redirectToLogin(); throw new Error("Not signed in"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed");
  return res.json();
}
async function apiDelete(url) {
  const res = await fetch(url, { method: "DELETE", credentials: "same-origin" });
  if (res.status === 401) { redirectToLogin(); throw new Error("Not signed in"); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed");
  return res.json();
}

function redirectToLogin() {
  if (!location.pathname.endsWith("login.html")) location.href = "login.html";
}

/* ---------------------------------------------------------
   Auth guard — call at the top of every protected page
   --------------------------------------------------------- */
async function requireAuthOrRedirect() {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (!res.ok) { redirectToLogin(); return null; }
    return await res.json();
  } catch {
    redirectToLogin();
    return null;
  }
}

/* ---------------------------------------------------------
   Header + footer
   --------------------------------------------------------- */
function initHeaderFooter(activePage, user) {
  const headerRoot = document.getElementById("headerRoot");
  if (headerRoot) {
    headerRoot.innerHTML = `
      <div class="topbar-left">
        <span class="topbar-mark">SC</span>
        <div class="profile-block">
          <span class="profile-email">${escapeHtml(user?.email || "")}</span>
          <button id="btnSignOut" class="link-btn">Sign out</button>
        </div>
      </div>
      <nav class="topnav">
        <a href="index.html" class="topnav-link ${activePage === "tracker" ? "active" : ""}">Tracker</a>
        <a href="completed.html" class="topnav-link ${activePage === "completed" ? "active" : ""}">Completed</a>
        <a href="analytics.html" class="topnav-link ${activePage === "analytics" ? "active" : ""}">Analytics</a>
      </nav>
      <div class="topbar-right">
        ${activePage === "tracker" ? `<button id="btnAddNew" class="btn btn-primary">+ Add new</button>` : ""}
      </div>
    `;
    const signOutBtn = document.getElementById("btnSignOut");
    if (signOutBtn) {
      signOutBtn.addEventListener("click", async () => {
        await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
        location.href = "login.html";
      });
    }
  }

  const footerRoot = document.getElementById("footerRoot");
  if (footerRoot) {
    footerRoot.innerHTML = `<p>© Ravithra Alahakoon ${new Date().getFullYear()}</p>`;
  }
}

/* ---------------------------------------------------------
   Working-time math (Mon-Fri only, real seconds)
   --------------------------------------------------------- */
function elapsedWorkingSeconds(startMs, endMs) {
  if (endMs <= startMs) return 0;
  let total = 0;
  let curDay = new Date(startMs);
  curDay.setHours(0, 0, 0, 0);

  while (curDay.getTime() <= endMs) {
    const dow = curDay.getDay();
    if (dow !== 0 && dow !== 6) {
      const nextDay = new Date(curDay);
      nextDay.setDate(curDay.getDate() + 1);
      const dayStart = Math.max(curDay.getTime(), startMs);
      const dayEnd = Math.min(nextDay.getTime(), endMs);
      if (dayEnd > dayStart) total += (dayEnd - dayStart) / 1000;
    }
    curDay.setDate(curDay.getDate() + 1);
  }
  return total;
}

function formatDuration(totalSeconds) {
  totalSeconds = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
}

function computeRemaining(row) {
  const allocDays = STAGE_DURATIONS[row.stage] ?? 0;

  if (!row.stage || row.stage === "Not Selected") {
    return { text: "-", status: "Not Selected", cls: "remain-na", statusCls: "status-muted" };
  }
  if (allocDays === 0) {
    return { text: "-", status: "No countdown", cls: "remain-na", statusCls: "status-muted" };
  }
  if (!row.startDate) {
    return { text: "-", status: "Enter start date", cls: "remain-na", statusCls: "status-muted" };
  }

  const allocSec = allocDays * 86400;
  const startMs = new Date(row.startDate + "T00:00:00").getTime();
  const now = Date.now();
  const endPoint = row.state === "HOLD" ? row.stateChangedAt : now;

  const gross = elapsedWorkingSeconds(startMs, endPoint);
  const net = Math.max(0, gross - (row.heldAccumulatedSec || 0));
  let remainSec = allocSec - net;
  const overdue = remainSec <= 0;
  if (overdue) remainSec = 0;

  const ratio = allocSec > 0 ? remainSec / allocSec : 1;
  let cls = "remain-ok";
  if (overdue) cls = "remain-overdue";
  else if (ratio <= 0.25) cls = "remain-danger";
  else if (ratio <= 0.5) cls = "remain-warn";

  let status, statusCls;
  if (overdue) {
    status = "OVERDUE";
    statusCls = "status-overdue";
  } else if (row.state === "HOLD") {
    status = `ON HOLD — ${formatDuration(remainSec)} left`;
    statusCls = "status-hold";
  } else {
    status = `RUNNING — ${formatDuration(remainSec)} left`;
    statusCls = "status-running";
  }

  return { text: formatDuration(remainSec), status, cls, statusCls };
}

/* ---------------------------------------------------------
   Misc
   --------------------------------------------------------- */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatCurrency(n) {
  const num = Number(n) || 0;
  return "$" + Math.round(num).toLocaleString("en-US");
}

function showBanner(msg) {
  let el = document.getElementById("errorBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "errorBanner";
    el.className = "error-banner";
    document.body.prepend(el);
  }
  el.textContent = msg;
  el.style.display = "block";
  clearTimeout(showBanner._t);
  showBanner._t = setTimeout(() => (el.style.display = "none"), 4000);
}

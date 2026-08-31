/* =========================================================
   Site Control — Project Timeline Tracker
   Shared, multi-user data via Cloudflare Pages Functions + D1.
   The countdown ticks locally every second between syncs, so
   it feels fully live; state changes made by anyone sync to
   everyone else within a few seconds via polling.
   ========================================================= */

const API = "/api/rows";
const POLL_MS = 4000;   // how often we re-sync with the shared database
const TICK_MS = 1000;   // how often the on-screen countdown re-renders

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
  "Submitted": 0,
};

/** @type {Array<Object>} */
let rows = [];
let syncing = false;

/* ---------------------------------------------------------
   Server sync
   --------------------------------------------------------- */
async function fetchRows() {
  try {
    const res = await fetch(API);
    if (!res.ok) throw new Error(`GET ${API} failed: ${res.status}`);
    rows = await res.json();
    renderTable();
  } catch (e) {
    console.error(e);
    showBanner("Couldn't reach the server — check your connection.");
  } finally {
    syncing = false;
  }
}

async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function apiPatch(id, payload) {
  const res = await fetch(`${API}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
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

/* ---------------------------------------------------------
   Working-time math (Mon-Fri only, real seconds) — mirrors
   the logic in functions/api/rows/[id].js so the on-screen
   ticker matches what the server will eventually compute.
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
  if (row.stage === "Submitted" || allocDays === 0) {
    return { text: "-", status: "Submitted - Complete", cls: "remain-na", statusCls: "status-muted" };
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
   Row actions — optimistic local update, then confirm w/ server
   --------------------------------------------------------- */
async function addRow({ address, wbs, stage, startDate }) {
  try {
    await apiPost(API, { address, wbs, stage, startDate });
    await fetchRows();
  } catch (e) {
    showBanner(e.message);
  }
}

async function setRowState(id, newState) {
  const row = rows.find((r) => r.id === id);
  if (!row || row.state === newState) return;

  const prev = { state: row.state, stateChangedAt: row.stateChangedAt, heldAccumulatedSec: row.heldAccumulatedSec };
  const now = Date.now();
  if (row.state === "HOLD" && newState === "START") {
    row.heldAccumulatedSec = (row.heldAccumulatedSec || 0) + elapsedWorkingSeconds(row.stateChangedAt, now);
  }
  row.state = newState;
  row.stateChangedAt = now;
  renderTable(); // instant feedback

  try {
    const updated = await apiPatch(id, { action: "setState", state: newState });
    Object.assign(row, updated);
    renderTable();
  } catch (e) {
    Object.assign(row, prev);
    renderTable();
    showBanner(e.message);
  }
}

async function updateRow(id, { address, wbs, stage, startDate, comment }) {
  try {
    const updated = await apiPatch(id, { action: "update", address, wbs, stage, startDate, comment });
    const row = rows.find((r) => r.id === id);
    if (row) Object.assign(row, updated);
    renderTable();
  } catch (e) {
    showBanner(e.message);
  }
}

async function clearComment(id) {
  const row = rows.find((r) => r.id === id);
  if (!row || !row.comment) return;
  try {
    const updated = await apiPatch(id, { action: "clearComment" });
    Object.assign(row, updated);
    renderTable();
    document.getElementById("eComment").value = "";
  } catch (e) {
    showBanner(e.message);
  }
}

/* ---------------------------------------------------------
   Rendering
   --------------------------------------------------------- */
const rowsBody = document.getElementById("rowsBody");
const emptyState = document.getElementById("emptyState");

function renderTable() {
  rowsBody.innerHTML = "";
  emptyState.style.display = rows.length ? "none" : "block";

  rows
    .slice()
    .sort((a, b) => a.no - b.no)
    .forEach((row) => {
      const r = computeRemaining(row);
      const tr = document.createElement("tr");
      tr.dataset.id = row.id;

      tr.innerHTML = `
        <td>${row.no}</td>
        <td><span class="cell-truncate" title="${escapeHtml(row.address)}">${escapeHtml(row.address)}</span></td>
        <td>${escapeHtml(row.wbs)}</td>
        <td><span class="stage-pill">${escapeHtml(row.stage)}</span></td>
        <td class="mono">${row.startDate || "-"}</td>
        <td class="mono">${STAGE_DURATIONS[row.stage] ? STAGE_DURATIONS[row.stage] + " wd" : "-"}</td>
        <td><span class="remain-cell ${r.cls}">${r.text}</span></td>
        <td>
          <div class="action-pair">
            <button class="toggle-btn btn-start ${row.state === "START" ? "active" : ""}" data-action="start">Start</button>
            <button class="toggle-btn btn-hold ${row.state === "HOLD" ? "active" : ""}" data-action="hold">Hold</button>
          </div>
        </td>
        <td><span class="status-text ${r.statusCls}">${escapeHtml(r.status)}</span></td>
        <td><span class="cell-truncate" title="${escapeHtml(row.comment)}">${escapeHtml(row.comment) || "—"}</span></td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" data-action="edit" title="Edit">✎</button>
            <button class="icon-btn" data-action="history" title="History">🕒</button>
          </div>
        </td>
      `;

      tr.querySelector('[data-action="start"]').addEventListener("click", () => setRowState(row.id, "START"));
      tr.querySelector('[data-action="hold"]').addEventListener("click", () => setRowState(row.id, "HOLD"));
      tr.querySelector('[data-action="edit"]').addEventListener("click", () => openEdit(row.id));
      tr.querySelector('[data-action="history"]').addEventListener("click", () => openHistory(row.id));

      rowsBody.appendChild(tr);
    });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------------------------------------------------
   Modals — Add
   --------------------------------------------------------- */
document.getElementById("btnAddNew").addEventListener("click", () => {
  document.getElementById("formAdd").reset();
  openModal("modalAdd");
});

document.getElementById("formAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addRow({
    address: document.getElementById("fAddress").value.trim(),
    wbs: document.getElementById("fWbs").value.trim(),
    stage: document.getElementById("fStage").value,
    startDate: document.getElementById("fStartDate").value,
  });
  closeModal("modalAdd");
});

/* ---------------------------------------------------------
   Modals — Edit
   --------------------------------------------------------- */
function openEdit(id) {
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  document.getElementById("eId").value = row.id;
  document.getElementById("eAddress").value = row.address;
  document.getElementById("eWbs").value = row.wbs;
  document.getElementById("eStage").value = row.stage;
  document.getElementById("eStartDate").value = row.startDate;
  document.getElementById("eComment").value = row.comment;
  openModal("modalEdit");
}

document.getElementById("formEdit").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("eId").value;
  await updateRow(id, {
    address: document.getElementById("eAddress").value.trim(),
    wbs: document.getElementById("eWbs").value.trim(),
    stage: document.getElementById("eStage").value,
    startDate: document.getElementById("eStartDate").value,
    comment: document.getElementById("eComment").value.trim(),
  });
  closeModal("modalEdit");
});

document.getElementById("btnClearComment").addEventListener("click", () => {
  const id = document.getElementById("eId").value;
  clearComment(id);
});

/* ---------------------------------------------------------
   Modals — History
   --------------------------------------------------------- */
const TYPE_META = {
  CREATED: { label: "Project created", dot: "dot-created" },
  START: { label: "Started", dot: "dot-start" },
  HOLD: { label: "Held", dot: "dot-hold" },
  COMMENT: { label: "Comment updated", dot: "dot-comment" },
  CLEAR: { label: "Comment cleared", dot: "dot-clear" },
};

function openHistory(id) {
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  document.getElementById("historyTitle").textContent = `History — ${row.address || "Untitled"} (${row.wbs})`;

  const body = document.getElementById("historyBody");
  if (!row.history.length) {
    body.innerHTML = `<p class="history-empty">No activity yet.</p>`;
  } else {
    body.innerHTML = row.history
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map((h) => {
        const meta = TYPE_META[h.type] || { label: h.type, dot: "dot-created" };
        const time = new Date(h.ts).toLocaleString();
        return `
          <div class="history-item">
            <span class="history-dot ${meta.dot}"></span>
            <div class="history-content">
              <div class="history-type">${meta.label}</div>
              <div class="history-time">${time}</div>
              <div class="history-detail">${escapeHtml(h.detail)}</div>
            </div>
          </div>
        `;
      })
      .join("");
  }
  openModal("modalHistory");
}

/* ---------------------------------------------------------
   Generic modal open/close
   --------------------------------------------------------- */
function openModal(id) {
  document.getElementById(id).classList.add("open");
}
function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.classList.remove("open");
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-backdrop.open").forEach((m) => m.classList.remove("open"));
  }
});

/* ---------------------------------------------------------
   Init — sync with the server, then tick locally in between
   --------------------------------------------------------- */
fetchRows();
setInterval(() => {
  if (!syncing) {
    syncing = true;
    fetchRows();
  }
}, POLL_MS);
setInterval(renderTable, TICK_MS);

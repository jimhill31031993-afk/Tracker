/* =========================================================
   tracker.js — the active Tracker page
   ========================================================= */

const POLL_MS = 4000;
const TICK_MS = 1000;
const REMINDER_RATIO = 0.20;

let rows = [];
let syncing = false;
let remindedIds = new Set();
let reminderQueue = [];
let reminderShowing = false;

async function fetchRows() {
  try {
    rows = await apiGet("/api/rows");
    renderTable();
  } catch (e) {
    console.error(e);
  } finally {
    syncing = false;
  }
}

/* ---------------------------------------------------------
   Row actions
   --------------------------------------------------------- */
async function addRow(payload) {
  try {
    const created = await apiPost("/api/rows", payload);
    await fetchRows();
    flashRow(created.id);
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
  renderTable();

  try {
    const updated = await apiPatch(`/api/rows/${id}`, { action: "setState", state: newState });
    Object.assign(row, updated);
    renderTable();
  } catch (e) {
    Object.assign(row, prev);
    renderTable();
    showBanner(e.message);
  }
}

async function updateRow(id, payload) {
  try {
    const updated = await apiPatch(`/api/rows/${id}`, { action: "update", ...payload });
    const row = rows.find((r) => r.id === id);
    if (row) Object.assign(row, updated);
    remindedIds.delete(id); // stage/start-date may have changed the deadline — allow re-reminding
    renderTable();
  } catch (e) {
    showBanner(e.message);
  }
}

async function clearComment(id) {
  const row = rows.find((r) => r.id === id);
  if (!row || !row.comment) return;
  try {
    const updated = await apiPatch(`/api/rows/${id}`, { action: "clearComment" });
    Object.assign(row, updated);
    renderTable();
    document.getElementById("eComment").value = "";
  } catch (e) {
    showBanner(e.message);
  }
}

async function deleteRow(id) {
  const row = rows.find((r) => r.id === id);
  if (!row) return;
  if (!confirm(`Delete this project (${row.address})? This can't be undone.`)) return;
  try {
    await apiDelete(`/api/rows/${id}`);
    rows = rows.filter((r) => r.id !== id);
    remindedIds.delete(id);
    renderTable();
  } catch (e) {
    showBanner(e.message);
  }
}

/* ---------------------------------------------------------
   20%-remaining reminder popup
   --------------------------------------------------------- */
function checkReminders() {
  rows.forEach((row) => {
    const allocDays = STAGE_DURATIONS[row.stage] ?? 0;
    if (!allocDays || !row.startDate) return;

    const allocSec = allocDays * 86400;
    const startMs = new Date(row.startDate + "T00:00:00").getTime();
    const endPoint = row.state === "HOLD" ? row.stateChangedAt : Date.now();
    const gross = elapsedWorkingSeconds(startMs, endPoint);
    const net = Math.max(0, gross - (row.heldAccumulatedSec || 0));
    const remainSec = allocSec - net;
    const ratio = remainSec / allocSec;

    if (remainSec > 0 && ratio <= REMINDER_RATIO && !remindedIds.has(row.id)) {
      remindedIds.add(row.id);
      queueReminder(row.address, remainSec);
    }
  });
}

function queueReminder(address, remainSec) {
  reminderQueue.push({ address, remainSec });
  if (!reminderShowing) showNextReminder();
}

function showNextReminder() {
  if (!reminderQueue.length) {
    reminderShowing = false;
    return;
  }
  reminderShowing = true;
  const item = reminderQueue.shift();
  document.getElementById("reminderAddress").textContent = item.address;
  document.getElementById("reminderTime").textContent = formatDuration(item.remainSec);
  openModal("modalReminder");
}

document.getElementById("reminderClose").addEventListener("click", () => {
  closeModal("modalReminder");
  setTimeout(showNextReminder, 250);
});

async function closeRow(id, projectValue) {
  try {
    await apiPatch(`/api/rows/${id}/close`, { projectValue });
    rows = rows.filter((r) => r.id !== id);
    renderTable();
  } catch (e) {
    showBanner(e.message);
    throw e;
  }
}

/* ---------------------------------------------------------
   Rendering
   --------------------------------------------------------- */
const rowsBody = document.getElementById("rowsBody");
const emptyState = document.getElementById("emptyState");
let flashId = null;

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
      if (row.id === flashId) tr.classList.add("row-flash");

      tr.innerHTML = `
        <td>${row.no}</td>
        <td><span class="cell-truncate" title="${escapeHtml(row.address)}">${escapeHtml(row.address)}</span></td>
        <td>${escapeHtml(row.wbs)}</td>
        <td>${stageBadge(row.stage)}</td>
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
            <button class="icon-btn icon-btn-close" data-action="close" title="Close project">✔</button>
            <button class="icon-btn icon-btn-danger" data-action="delete" title="Delete">🗑</button>
          </div>
        </td>
      `;

      tr.querySelector('[data-action="start"]').addEventListener("click", () => setRowState(row.id, "START"));
      tr.querySelector('[data-action="hold"]').addEventListener("click", () => setRowState(row.id, "HOLD"));
      tr.querySelector('[data-action="edit"]').addEventListener("click", () => openEdit(row.id));
      tr.querySelector('[data-action="history"]').addEventListener("click", () => openHistory(row.id));
      tr.querySelector('[data-action="close"]').addEventListener("click", () => openClose(row.id));
      tr.querySelector('[data-action="delete"]').addEventListener("click", () => deleteRow(row.id));

      rowsBody.appendChild(tr);
    });
}

function flashRow(id) {
  flashId = id;
  renderTable();
  document.querySelector(`tr[data-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => {
    flashId = null;
    renderTable();
  }, 2200);
}

/* ---------------------------------------------------------
   Modals — Add
   --------------------------------------------------------- */
document.getElementById("formAdd").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addRow({
    address: document.getElementById("fAddress").value.trim(),
    wbs: document.getElementById("fWbs").value.trim(),
    stage: document.getElementById("fStage").value,
    startDate: document.getElementById("fStartDate").value,
  });
  closeModal("modalAdd");
  document.getElementById("formAdd").reset();
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
  clearComment(document.getElementById("eId").value);
});

/* ---------------------------------------------------------
   Modals — Close
   --------------------------------------------------------- */
function openClose(id) {
  document.getElementById("cId").value = id;
  document.getElementById("cValue").value = "";
  openModal("modalClose");
}

document.getElementById("formClose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("cId").value;
  const value = parseFloat(document.getElementById("cValue").value);
  try {
    await closeRow(id, value);
    closeModal("modalClose");
  } catch {
    /* banner already shown, keep modal open */
  }
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
  CLOSED: { label: "Closed", dot: "dot-created" },
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
   Init
   --------------------------------------------------------- */
(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  initHeaderFooter("tracker", user);

  document.getElementById("btnAddNew")?.addEventListener("click", () => {
    document.getElementById("formAdd").reset();
    openModal("modalAdd");
  });

  await fetchRows();
  setInterval(() => {
    if (!syncing) {
      syncing = true;
      fetchRows();
    }
  }, POLL_MS);
  setInterval(() => {
    renderTable();
    checkReminders();
  }, TICK_MS);
})();

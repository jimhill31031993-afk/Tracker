/* =========================================================
   completed.js — the Completed projects page
   ========================================================= */

let rows = [];

async function fetchRows() {
  try {
    rows = await apiGet("/api/completed");
    renderTable();
  } catch (e) {
    console.error(e);
  }
}

async function saveValue(id, newValue) {
  try {
    const updated = await apiPatch(`/api/completed/${id}`, { projectValue: newValue });
    const row = rows.find((r) => r.id === id);
    if (row) Object.assign(row, updated);
    renderTable();
  } catch (e) {
    showBanner(e.message);
    renderTable();
  }
}

const rowsBody = document.getElementById("rowsBody");
const emptyState = document.getElementById("emptyState");

function renderTable() {
  rowsBody.innerHTML = "";
  emptyState.style.display = rows.length ? "none" : "block";

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.dataset.id = row.id;
    tr.className = row.onTime ? "row-on-time" : "row-late";

    tr.innerHTML = `
      <td>${row.no}</td>
      <td><span class="cell-truncate" title="${escapeHtml(row.address)}">${escapeHtml(row.address)}</span></td>
      <td>${escapeHtml(row.wbs)}</td>
      <td>${stageBadge(row.stage)}</td>
      <td class="mono">${row.startDate || "-"}</td>
      <td class="mono">${row.closedAt ? new Date(row.closedAt).toLocaleDateString() : "-"}</td>
      <td><span class="badge ${row.onTime ? "badge-good" : "badge-bad"}">${row.onTime ? "On time" : "Overdue"}</span></td>
      <td class="value-cell" data-id="${row.id}"></td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-action="timebar" title="Time breakdown">📊</button>
        </div>
      </td>
    `;

    tr.querySelector('[data-action="timebar"]').addEventListener("click", () => openTimeBar(row));

    const valueCell = tr.querySelector(".value-cell");
    renderValueCell(valueCell, row);

    rowsBody.appendChild(tr);
  });
}

function renderValueCell(cell, row) {
  cell.innerHTML = `
    <span class="value-display">${formatCurrency(row.projectValue)}</span>
    <button class="icon-btn value-edit-btn" title="Edit value">✎</button>
  `;
  cell.querySelector(".value-edit-btn").addEventListener("click", () => startEditValue(cell, row));
}

function startEditValue(cell, row) {
  cell.innerHTML = `
    <input type="number" class="value-input" min="0" step="0.01" value="${row.projectValue ?? 0}">
    <button class="icon-btn value-save-btn" title="Save">✓</button>
    <button class="icon-btn value-cancel-btn" title="Cancel">✕</button>
  `;
  const input = cell.querySelector(".value-input");
  input.focus();
  input.select();

  const save = async () => {
    const val = parseFloat(input.value);
    if (!Number.isFinite(val) || val < 0) {
      showBanner("Enter a valid project value");
      return;
    }
    await saveValue(row.id, val);
  };

  cell.querySelector(".value-save-btn").addEventListener("click", save);
  cell.querySelector(".value-cancel-btn").addEventListener("click", () => renderValueCell(cell, row));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") renderValueCell(cell, row);
  });
}

/* ---------------------------------------------------------
   Time Breakdown popup
   --------------------------------------------------------- */
const EXCEED_VISUAL_CAP_PCT = 60; // widest the red "exceeded" bar will visually grow to

function openTimeBar(row) {
  document.getElementById("timeBarTitle").textContent = `Time Breakdown — ${row.address} (${row.wbs})`;

  const track = document.getElementById("timebarTrack");
  const lines = document.getElementById("timebarLines");
  const allocDays = STAGE_DURATIONS[row.stage] ?? 0;

  if (!allocDays || !row.startDate) {
    track.innerHTML = `<p class="timebar-empty">This stage has no countdown, so there's no time breakdown to show.</p>`;
    lines.innerHTML = "";
    openModal("modalTimeBar");
    return;
  }

  const toDays = (sec) => (sec / 86400).toFixed(1);

  const allocSec = allocDays * 86400;
  const startMs = new Date(row.startDate + "T00:00:00").getTime();
  const endPoint = row.state === "HOLD" ? row.stateChangedAt : row.closedAt;
  const gross = elapsedWorkingSeconds(startMs, endPoint);
  const heldSec = row.heldAccumulatedSec || 0;
  const spentSec = Math.max(0, gross - heldSec);
  const balanceRaw = allocSec - spentSec;
  const exceedSec = balanceRaw < 0 ? -balanceRaw : 0;
  const balanceSec = Math.max(0, balanceRaw);

  const spentPct = Math.min(100, (spentSec / allocSec) * 100);
  const balancePct = Math.max(0, 100 - spentPct);
  const exceedPct = exceedSec > 0 ? Math.min(EXCEED_VISUAL_CAP_PCT, (exceedSec / allocSec) * 100) : 0;

  let html = `<div class="timebar-base">`;
  html += `<div class="timebar-seg timebar-seg-spent" style="width:${spentPct}%;">`;
  if (spentPct >= 14) html += `<span class="timebar-label">${toDays(spentSec)}d</span>`;
  html += `</div>`;
  if (balancePct > 0) {
    html += `<div class="timebar-seg timebar-seg-balance" style="width:${balancePct}%;">`;
    if (balancePct >= 14) html += `<span class="timebar-label">${toDays(balanceSec)}d</span>`;
    html += `</div>`;
  }
  html += `</div>`;

  if (exceedSec > 0) {
    html += `<div class="timebar-extend" style="width:${exceedPct}%;"><span class="timebar-label">+${toDays(exceedSec)}d</span></div>`;
  }

  let outsideLabels = "";
  if (spentPct > 0 && spentPct < 14) outsideLabels += `<span class="timebar-outside-label">Spent: ${toDays(spentSec)}d</span>`;
  if (balancePct > 0 && balancePct < 14) outsideLabels += `<span class="timebar-outside-label">Balance: ${toDays(balanceSec)}d</span>`;
  if (outsideLabels) html += `<div class="timebar-outside-labels">${outsideLabels}</div>`;

  track.innerHTML = html;

  lines.innerHTML = `
    <div class="timebar-line"><span>Allocated time:</span><strong>${toDays(allocSec)} days</strong></div>
    <div class="timebar-line"><span>Spent time (running, excl. hold):</span><strong>${toDays(spentSec)} days</strong></div>
    <div class="timebar-line"><span>Hold time (total):</span><strong>${toDays(heldSec)} days</strong></div>
    <div class="timebar-line"><span>Start date:</span><strong>${row.startDate}</strong></div>
    <div class="timebar-line"><span>Finished date:</span><strong>${row.closedAt ? new Date(row.closedAt).toLocaleDateString() : "-"}</strong></div>
    ${exceedSec > 0 ? `<div class="timebar-line timebar-line-exceed"><span>Exceeded allocation by:</span><strong>${toDays(exceedSec)} days</strong></div>` : ""}
  `;

  openModal("modalTimeBar");
}

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
  initHeaderFooter("completed", user);
  await fetchRows();
})();

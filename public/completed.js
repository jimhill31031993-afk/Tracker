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
      <td><span class="stage-pill">${escapeHtml(row.stage)}</span></td>
      <td class="mono">${row.startDate || "-"}</td>
      <td class="mono">${row.closedAt ? new Date(row.closedAt).toLocaleDateString() : "-"}</td>
      <td><span class="badge ${row.onTime ? "badge-good" : "badge-bad"}">${row.onTime ? "On time" : "Overdue"}</span></td>
      <td class="value-cell" data-id="${row.id}"></td>
    `;

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
   Init
   --------------------------------------------------------- */
(async function init() {
  const user = await requireAuthOrRedirect();
  if (!user) return;
  initHeaderFooter("completed", user);
  await fetchRows();
})();

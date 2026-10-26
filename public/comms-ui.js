/* =========================================================
   comms-ui.js — history pop-up + Excel download, shared by the
   Communication Tracker page and the Completed page.
   Needs common.js, comms-logic.js, xlsx-writer.js (loaded first).

   PHASE 1 = DEMO / DISCONNECTED: every event shown here is a manual
   entry (or clearly-labelled fictional demo data). Nothing is
   presented as a verified Outlook message.
   ========================================================= */
(function () {
  "use strict";
  const L = window.CommsLogic;
  const X = window.XlsxWriter;
  const MODAL_ID = "commsHistoryModal";

  function browserTz() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }
  function effectiveTz(settings) {
    return settings && settings.timezone && L.isValidTimeZone(settings.timezone) ? settings.timezone : browserTz();
  }

  function cpLabel(task) {
    if (!task || !task.counterpartyType) return "Counterparty not set";
    return `${L.COUNTERPARTY_LABELS[task.counterpartyType] || task.counterpartyType} — ${task.counterpartyName}`;
  }

  /* ---------------------------------------------------------
     Excel
     --------------------------------------------------------- */
  function downloadExcel({ task, events, tz, demo }) {
    const now = Date.now();
    const exp = L.buildExport({ task, events, tz, now, demo: !!demo });
    const bytes = X.build(L.exportWorkbookSpec(exp), new Date(now));
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = L.exportFileName(task, now, tz, !!demo);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function fetchHistory(rowId) {
    const d = await apiGet(`/api/comms/tasks/${encodeURIComponent(rowId)}/history`);
    return { task: d.task, events: d.events, tz: effectiveTz(d.settings) };
  }

  async function downloadForRow(rowId) {
    try {
      downloadExcel(await fetchHistory(rowId));
    } catch (e) {
      showBanner(e.message);
    }
  }

  async function openHistoryForRow(rowId) {
    try {
      const h = await fetchHistory(rowId);
      openHistory({ ...h, demo: false, editable: false });
    } catch (e) {
      showBanner(e.message);
    }
  }

  /* ---------------------------------------------------------
     History modal
     --------------------------------------------------------- */
  let lastFocus = null;
  let ctx = null;

  function ensureModal() {
    let el = document.getElementById(MODAL_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = MODAL_ID;
    el.className = "modal-backdrop";
    el.innerHTML = `
      <div class="modal modal-xl" role="dialog" aria-modal="true" aria-labelledby="commsHistTitle">
        <div class="modal-head">
          <h2 id="commsHistTitle">Communication history</h2>
          <button type="button" class="modal-close" data-hist-close aria-label="Close communication history">&times;</button>
        </div>
        <div class="ct-hist-body" id="commsHistBody"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener("click", (e) => {
      if (e.target === el) closeHistory();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeHistory();
      } else if (e.key === "Tab") {
        const f = [...el.querySelectorAll("button, select, input, [href], [tabindex]:not([tabindex='-1'])")].filter((n) => !n.disabled && n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
    el.querySelector("[data-hist-close]").addEventListener("click", closeHistory);
    return el;
  }

  function closeHistory() {
    const el = document.getElementById(MODAL_ID);
    if (!el) return;
    el.classList.remove("open");
    ctx = null;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  /* opts: { task, events, tz, demo, editable, reload?: async()=>({task,events}),
             onAddEvent?(direction), onMutated?() } */
  function openHistory(opts) {
    const el = ensureModal();
    if (!el.classList.contains("open")) lastFocus = document.activeElement;
    ctx = opts;
    renderHistory();
    el.classList.add("open");
    const closeBtn = el.querySelector("[data-hist-close]");
    if (closeBtn && !el.contains(document.activeElement)) closeBtn.focus();
  }

  function renderHistory() {
    const { task, events, tz, demo, editable } = ctx;
    const el = document.getElementById(MODAL_ID);
    const body = el.querySelector("#commsHistBody");
    const now = Date.now();
    const analysis = L.analyseEvents(events);
    const sorted = L.sortEvents(events, "desc");
    const byId = new Map(events.map((e) => [e.id, e]));

    el.querySelector("#commsHistTitle").textContent = `Communication history — ${task.address}`;

    const modeNote = demo
      ? `<div class="ct-banner ct-banner-demo" role="note"><strong>DEMO DATA</strong> — fictional records for preview only. Nothing here is saved or real.</div>`
      : `<div class="ct-banner ct-banner-mode" role="note"><strong>Demo/Disconnected.</strong> Outlook is not connected: these are manual entries and are <strong>not verified</strong> emails.</div>`;

    const rowsHtml = sorted
      .map((e) => {
        const a = analysis.get(e.id) || { status: "STANDALONE", candidates: [] };
        const dur = L.durationCell(e, analysis, now, task.status);
        const sum = L.describeSummary(e);
        const isIn = e.direction === "IN";
        const tags = [];
        tags.push(demo ? `<span class="ct-tag ct-tag-demo">Demo — fictional</span>` : `<span class="ct-tag">Manual · not verified</span>`);
        if (a.status === "REVIEW") tags.push(`<span class="ct-tag ct-tag-warn">Needs manual review</span>`);
        if (a.status === "MATCHED") {
          const other = byId.get(a.pairedId);
          tags.push(
            `<span class="ct-tag ct-tag-ok">${isIn ? "Replied" : "Reply"}${other ? " · " + escapeHtml(L.formatDateTime(other.occurredAt, tz)) : ""}</span>`
          );
        }

        let resolve = "";
        if (editable && !demo && !isIn && a.status === "REVIEW") {
          const opts = a.candidates
            .map((id) => byId.get(id))
            .filter(Boolean)
            .map((c) => `<option value="${escapeHtml(c.id)}">Reply to message received ${escapeHtml(L.formatDateTime(c.occurredAt, tz))}</option>`)
            .join("");
          resolve = `<label class="ct-resolve">Resolve match
            <select data-resolve="${escapeHtml(e.id)}"><option value="">Choose…</option>${opts}<option value="__none">Not a reply</option></select></label>`;
        }
        const del =
          editable && !demo
            ? `<button type="button" class="icon-btn icon-btn-danger" data-del="${escapeHtml(e.id)}" title="Delete this entry" aria-label="Delete this entry">🗑</button>`
            : "";

        return `<tr class="${a.status === "REVIEW" ? "ct-row-review" : ""}">
          <td class="mono ct-nowrap">${escapeHtml(L.formatDateTime(e.occurredAt, tz))}</td>
          <td><span class="ct-dir ${isIn ? "ct-dir-in" : "ct-dir-out"}"><span aria-hidden="true">${isIn ? "↓" : "↑"}</span> ${isIn ? "Received" : "Sent"}</span>
              <div class="ct-tags">${tags.join("")}</div></td>
          <td><span class="ct-addr-role">${isIn ? "From" : "To"}</span> ${escapeHtml(e.address)}</td>
          <td>${escapeHtml(dur.text)}${resolve}</td>
          <td>${
            sum.basis === "Unavailable"
              ? `<span class="ct-muted">${escapeHtml(sum.text)}</span>`
              : `${escapeHtml(sum.text)} <span class="ct-tag">${escapeHtml(sum.basis)}</span>`
          }</td>
          ${editable && !demo ? `<td class="ct-del-cell">${del}</td>` : ""}
        </tr>`;
      })
      .join("");

    const actions = [];
    if (editable && !demo && ctx.onAddEvent) {
      actions.push(`<button type="button" class="btn btn-ghost" data-add="IN">Record received message</button>`);
      actions.push(`<button type="button" class="btn btn-ghost" data-add="OUT">Record sent message</button>`);
    }
    actions.push(`<button type="button" class="btn btn-primary" data-xlsx>⬇ Download Excel (.xlsx)</button>`);

    body.innerHTML = `
      ${modeNote}
      <dl class="ct-hist-meta">
        <div><dt>Project / task</dt><dd>${escapeHtml(task.address)} <span class="ct-muted">(WBS ${escapeHtml(task.wbs)})</span></dd></div>
        <div><dt>Counterparty</dt><dd>${escapeHtml(cpLabel(task))}</dd></div>
        <div><dt>Task status</dt><dd>${task.status === "COMPLETED" ? "Completed — history is read-only" : "Active"}</dd></div>
        <div><dt>Times shown in</dt><dd>${escapeHtml(tz)}</dd></div>
      </dl>
      <div class="ct-hist-actions">${actions.join("")}</div>
      ${
        sorted.length
          ? `<div class="ct-table-wrap"><table class="ct-table">
              <caption class="ct-sr">Correspondence history for ${escapeHtml(task.address)}, newest first</caption>
              <thead><tr>
                <th scope="col">Received / sent</th>
                <th scope="col">Direction / type</th>
                <th scope="col">Sender / recipient email</th>
                <th scope="col">Response duration</th>
                <th scope="col">Summary (5–9 words)</th>
                ${editable && !demo ? `<th scope="col"><span class="ct-sr">Actions</span></th>` : ""}
              </tr></thead><tbody>${rowsHtml}</tbody></table></div>`
          : `<p class="empty-state ct-empty">No communication events have been recorded for this task.${
              task.status === "ACTIVE" && !demo ? " Use “Record received message” or “Record sent message” to add one manually." : ""
            }</p>`
      }
      <p class="ct-foot">Summaries marked “Unavailable” mean no message content has been accessed or approved for processing — none is invented.
      Response durations are shown only where a reply is linked or matched reliably.</p>`;

    body.querySelector("[data-xlsx]").addEventListener("click", () => downloadExcel({ task, events, tz, demo }));
    body.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => ctx.onAddEvent(b.dataset.add)));
    body.querySelectorAll("[data-resolve]").forEach((s) =>
      s.addEventListener("change", async () => {
        if (!s.value) return;
        try {
          await apiPatch(`/api/comms/events/${encodeURIComponent(s.dataset.resolve)}`, s.value === "__none" ? { notAReply: true } : { replyToId: s.value });
          await refresh();
        } catch (err) {
          showBanner(err.message);
        }
      })
    );
    body.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Delete this manually recorded entry? This cannot be undone.")) return;
        try {
          await apiDelete(`/api/comms/events/${encodeURIComponent(b.dataset.del)}`);
          await refresh();
        } catch (err) {
          showBanner(err.message);
        }
      })
    );
  }

  async function refresh() {
    if (!ctx) return;
    if (ctx.reload) {
      const fresh = await ctx.reload();
      ctx = Object.assign({}, ctx, fresh);
    }
    renderHistory();
    if (ctx.onMutated) ctx.onMutated();
  }

  window.CommsUI = { openHistory, closeHistory, openHistoryForRow, downloadExcel, downloadForRow, effectiveTz, browserTz, cpLabel, refreshHistory: refresh };
})();

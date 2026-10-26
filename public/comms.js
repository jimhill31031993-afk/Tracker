/* =========================================================
   comms.js — Communication Tracker page.

   PHASE 1 = DEMO / DISCONNECTED.
   * Tasks come from the existing tracker data (/api/comms/overview reads the
     existing `rows` table) — there is no second task register.
   * Events are entered by hand and always labelled "Manual · not verified".
   * No Outlook connection, no email sending or drafting.
   * "Preview demo data" swaps in FICTIONAL in-memory data (never saved, never
     mixed with the user's real records).
   ========================================================= */
(function () {
  "use strict";
  const L = window.CommsLogic;
  const UI = window.CommsUI;
  const $ = (id) => document.getElementById(id);
  const CFG = L.DEFAULT_CONFIG;
  const REFRESH_MS = 60 * 1000;

  const state = {
    demo: false,
    demoData: null,
    demoDismissed: {},
    demoPaused: false,
    loading: true,
    error: null,
    errorCode: null,
    tasks: [],
    events: [],
    dismissed: {},
    settings: { remindersPaused: false, timezone: null },
    expanded: new Set(),
    filters: { q: "", cp: "ALL", status: "ALL", due: "ALL" },
    now: Date.now(),
    centreOpen: false,
    closed: new Set(), // "key#cycle" closed during this page view (guards against a failed save re-popping)
  };

  const tz = () => (state.settings.timezone && L.isValidTimeZone(state.settings.timezone) ? state.settings.timezone : UI.browserTz());
  const isPaused = () => (state.demo ? state.demoPaused : !!state.settings.remindersPaused);
  const fmt = (ms) => L.formatDateTime(ms, tz());
  const hm = (ms) => L.formatAwaiting(ms / 1000).replace("Awaiting reply — ", ""); // "26h 10m" (unanswered email)
  const dh = (ms) => L.formatDuration(ms / 1000); // "8d 0h" (weekly update cycles)
  const eventsFor = (rowId) => state.events.filter((e) => e.rowId === rowId);

  function reminders() {
    return L.computeReminders({
      tasks: state.tasks,
      events: state.events,
      now: state.now,
      dismissed: state.dismissed,
      paused: isPaused(),
    });
  }

  /* ---------------------------------------------------------
     Data
     --------------------------------------------------------- */
  async function load() {
    if (state.demo) {
      if (!state.demoData) state.demoData = window.CommsDemo.build(Date.now());
      state.tasks = state.demoData.tasks;
      state.events = state.demoData.events;
      state.dismissed = state.demoDismissed;
    } else {
      const d = await apiGet("/api/comms/overview");
      state.tasks = d.tasks;
      state.events = d.events;
      state.dismissed = d.dismissed || {};
      state.settings = d.settings || { remindersPaused: false, timezone: null };
    }
    state.now = Date.now();
  }

  async function reloadAndRender() {
    try {
      await load();
      state.error = null;
    } catch (e) {
      showBanner(e.message);
    }
    renderAll();
    syncPopups();
  }

  /* ---------------------------------------------------------
     Filters
     --------------------------------------------------------- */
  function dueState(t) {
    const c = computeRemaining(t).cls;
    if (c === "remain-overdue") return "OVERDUE";
    if (c === "remain-danger" || c === "remain-warn") return "DUE_SOON";
    if (c === "remain-ok") return "ON_TRACK";
    return "NA";
  }
  const statusKey = (t) => (t.state === "START" ? "RUNNING" : t.state === "HOLD" ? "HOLD" : "NOT_STARTED");

  function matches(t) {
    const f = state.filters;
    if (f.cp !== "ALL") {
      if (f.cp === "UNASSIGNED" ? L.isTracked(t) : t.counterpartyType !== f.cp) return false;
    }
    if (f.status !== "ALL" && statusKey(t) !== f.status) return false;
    if (f.due !== "ALL" && dueState(t) !== f.due) return false;
    if (f.q) {
      const hay = `${t.address} ${t.wbs} ${t.stage} ${t.counterpartyName || ""} ${L.COUNTERPARTY_LABELS[t.counterpartyType] || ""}`.toLowerCase();
      if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------
     Rendering
     --------------------------------------------------------- */
  function renderBanner() {
    const b = $("ctModeBanner");
    if (state.demo) {
      b.className = "ct-banner ct-banner-demo";
      b.innerHTML = `<strong>DEMO DATA — fictional.</strong> You are previewing made-up tasks and messages held in memory only. Nothing is saved, and none of it is mixed with your real tasks. Choose “Back to my data” to leave.`;
    } else {
      b.className = "ct-banner ct-banner-mode";
      b.innerHTML = `<strong>Demo/Disconnected mode.</strong> Outlook is not connected, so this page does <strong>not</strong> read, track or verify real Outlook messages. Events appear only when you record them by hand and are labelled <em>Manual · not verified</em>. Last sync: never (no connector). This app never sends or drafts email.`;
    }
  }

  function renderControls() {
    const paused = isPaused();
    const p = $("ctPauseBtn");
    p.textContent = paused ? "▶ Resume reminders" : "⏸ Stop reminders";
    p.setAttribute("aria-pressed", paused ? "true" : "false");
    $("ctPauseNote").hidden = !paused;
    const d = $("ctDemoBtn");
    d.textContent = state.demo ? "Back to my data" : "Preview demo data";
    d.setAttribute("aria-pressed", state.demo ? "true" : "false");
    if (document.activeElement !== $("ctTz")) $("ctTz").value = tz();
  }

  function groupTasks(tasks) {
    const groups = new Map();
    for (const t of tasks) {
      const key = L.isTracked(t) ? L.groupKey(t.counterpartyType, t.counterpartyName) : "UNASSIGNED";
      if (!groups.has(key)) groups.set(key, { key, type: t.counterpartyType, name: t.counterpartyName, tasks: [] });
      groups.get(key).tasks.push(t);
    }
    const order = { CUSTOMER: 0, VECTOR_TEAM: 1, OTHER: 2 };
    return [...groups.values()].sort((a, b) => {
      if (a.key === "UNASSIGNED") return 1;
      if (b.key === "UNASSIGNED") return -1;
      return (order[a.type] - order[b.type]) || String(a.name).localeCompare(String(b.name));
    });
  }

  function weeklyChip(info) {
    if (!info) return "";
    const basis = info.basis === "LAST_SENT" ? "since last sent message" : "since tracking start (no sent message recorded)";
    if (info.due) {
      return info.overLimit
        ? `<span class="ct-chip ct-chip-over">⚠ Weekly update OVERDUE — ${escapeHtml(dh(info.elapsedMs))} ${basis}</span>`
        : `<span class="ct-chip ct-chip-due">📅 Weekly update due — ${escapeHtml(dh(info.elapsedMs))} ${basis}</span>`;
    }
    return `<span class="ct-chip ct-chip-ok">✓ Next weekly update due ${escapeHtml(fmt(info.dueAt))} (${info.basis === "LAST_SENT" ? "from last sent message" : "from tracking start"})</span>`;
  }

  function taskCard(t) {
    const evs = eventsFor(t.id);
    const analysis = L.analyseEvents(evs);
    const sorted = L.sortEvents(evs, "desc");
    const awaiting = evs.filter((e) => e.direction === "IN" && (analysis.get(e.id) || {}).status !== "MATCHED");
    const lastIn = sorted.find((e) => e.direction === "IN");
    const lastOut = sorted.find((e) => e.direction === "OUT");
    const open = state.expanded.has(t.id);
    const ds = dueState(t);
    const dsChip = {
      OVERDUE: `<span class="ct-chip ct-chip-over">⚠ Overdue</span>`,
      DUE_SOON: `<span class="ct-chip ct-chip-due">⏳ Due soon</span>`,
      ON_TRACK: `<span class="ct-chip ct-chip-ok">✓ On track</span>`,
      NA: `<span class="ct-chip ct-chip-na">No countdown</span>`,
    }[ds];
    const stat = { RUNNING: "Running", HOLD: "On hold", NOT_STARTED: "Not started" }[statusKey(t)];
    const id = escapeHtml(t.id);

    const detail = open
      ? `<div class="ct-detail" id="ct-detail-${id}">
          <div class="ct-detail-grid">
            <div>
              <h3>Tracking status</h3>
              <dl class="ct-kv">
                <dt>Counterparty</dt><dd>${escapeHtml(UI.cpLabel(t))} <button type="button" class="link-btn ct-link" data-action="cp" data-task="${id}">${L.isTracked(t) ? "Edit" : "Set counterparty"}</button></dd>
                <dt>Tracking started</dt><dd>${t.trackingStart ? escapeHtml(fmt(t.trackingStart)) : "—"}</dd>
                <dt>Last received</dt><dd>${lastIn ? escapeHtml(fmt(lastIn.occurredAt)) : "None recorded"}</dd>
                <dt>Last sent</dt><dd>${lastOut ? escapeHtml(fmt(lastOut.occurredAt)) : "None recorded"}</dd>
                <dt>Awaiting reply</dt><dd>${
                  awaiting.length
                    ? awaiting.map((e) => `${escapeHtml(L.formatAwaiting((state.now - e.occurredAt) / 1000))}`).join("<br>")
                    : "Nothing awaiting a recorded reply"
                }</dd>
                <dt>Records</dt><dd>${state.demo ? "Demo — fictional" : "Manual entries · not verified"}</dd>
              </dl>
            </div>
            <div>
              <h3>Recent communication</h3>
              ${
                sorted.length
                  ? `<ul class="ct-recent">${sorted
                      .slice(0, 5)
                      .map((e) => {
                        const dur = L.durationCell(e, analysis, state.now, t.status).text;
                        return `<li><strong>${e.direction === "IN" ? "↓ Received" : "↑ Sent"}</strong> · ${escapeHtml(fmt(e.occurredAt))}<br>${e.direction === "IN" ? "From" : "To"} ${escapeHtml(e.address)} · ${escapeHtml(dur)}</li>`;
                      })
                      .join("")}</ul>`
                  : `<p class="ct-muted">No communication events recorded for this task yet.</p>`
              }
            </div>
          </div>
          <div class="ct-detail-actions">
            <button type="button" class="btn btn-ghost" data-action="rec-in" data-task="${id}" ${state.demo ? 'disabled title="Demo data is read-only"' : ""}>Record received message</button>
            <button type="button" class="btn btn-ghost" data-action="rec-out" data-task="${id}" ${state.demo ? 'disabled title="Demo data is read-only"' : ""}>Record sent message</button>
          </div>
        </div>`
      : "";

    return `<article class="ct-task" data-task="${id}">
      <div class="ct-task-head">
        <button type="button" class="ct-toggle" data-action="toggle" data-task="${id}" aria-expanded="${open}" aria-controls="ct-detail-${id}" aria-label="${open ? "Collapse" : "Expand"} ${escapeHtml(t.address)}"><span class="ct-caret" aria-hidden="true">▸</span></button>
        <div class="ct-task-title">
          <strong>${escapeHtml(t.address)}</strong>
          <div class="ct-task-sub">
            <span>WBS ${escapeHtml(t.wbs)}</span>${stageBadge(t.stage)}<span>${stat}</span>${dsChip}
            <span>${evs.length} event${evs.length === 1 ? "" : "s"}</span>
            ${awaiting.length ? `<span class="ct-chip ct-chip-over">✉ ${awaiting.length} awaiting reply</span>` : ""}
          </div>
        </div>
        <div class="ct-task-actions">
          <button type="button" class="btn btn-ghost" data-action="history" data-task="${id}">View Communication History</button>
          <button type="button" class="btn btn-ghost" data-action="xlsx" data-task="${id}">⬇ Download Excel</button>
        </div>
      </div>${detail}
    </article>`;
  }

  function renderBoard() {
    const board = $("ctBoard");
    const R = reminders();
    const active = document.activeElement;
    const keep = active && board.contains(active) ? { task: active.closest("[data-task]")?.dataset.task, action: active.dataset.action } : null;

    const visible = state.tasks.filter(matches);
    const groupInfo = new Map(R.groups.map((g) => [g.key, g]));
    let html = "";
    if (state.tasks.length && !state.events.length) {
      html += `<p class="ct-state">No communication events have been recorded yet. Expand a task and choose “Record received message” or “Record sent message” to add one manually.</p>`;
    }
    for (const g of groupTasks(visible)) {
      const unassigned = g.key === "UNASSIGNED";
      html += `<section class="ct-group" aria-label="${escapeHtml(unassigned ? "Counterparty not set" : g.name)}">
        <div class="ct-group-head">
          <h2>${unassigned ? "Counterparty not set" : `${escapeHtml(L.COUNTERPARTY_LABELS[g.type])} — ${escapeHtml(g.name)}`}</h2>
          <span class="ct-chip">${g.tasks.length} task${g.tasks.length === 1 ? "" : "s"}</span>
          ${unassigned ? `<span class="ct-chip ct-chip-na">Set a counterparty to include these in weekly update reminders</span>` : weeklyChip(groupInfo.get(g.key))}
        </div>
        ${g.tasks.map(taskCard).join("")}
      </section>`;
    }
    board.innerHTML = html;

    if (keep && keep.task && keep.action) {
      const el = board.querySelector(`[data-task="${CSS.escape(keep.task)}"] [data-action="${keep.action}"], [data-task="${CSS.escape(keep.task)}"][data-action="${keep.action}"]`);
      if (el) el.focus();
    }
  }

  function renderState() {
    const el = $("ctState");
    el.className = "ct-state";
    if (state.loading) {
      el.textContent = "Loading tasks…";
    } else if (state.error) {
      el.classList.add("ct-state-error");
      el.textContent =
        state.errorCode === "MIGRATION_REQUIRED" || /schema_comms/.test(state.error)
          ? state.error
          : `Could not load the Communication Tracker: ${state.error}`;
    } else if (!state.tasks.length) {
      el.textContent = state.demo ? "No demo tasks." : "No active tasks yet. Tasks you add in the Tracker appear here automatically.";
    } else if (!state.tasks.some(matches)) {
      el.textContent = "No tasks match the current filters.";
    } else {
      el.textContent = "";
    }
  }

  /* When the NEXT display of a reminder is due (cycle c is first shown at after + (c-1) x repeat). */
  function nextCycleAt(r) {
    return r.kind === "UNANSWERED"
      ? r.receivedAt + (CFG.unansweredAfterHours + r.cycle * CFG.unansweredRepeatHours) * L.HOUR
      : r.anchor + CFG.weeklyDueAfterDays * L.DAY + r.cycle * CFG.weeklyRepeatHours * L.HOUR;
  }

  function renderCentre() {
    const R = reminders();
    const items = [...R.unanswered, ...R.weekly].sort((a, b) => b.elapsedMs - a.elapsedMs);
    $("ctCentreCount").textContent = String(items.length);
    $("ctCentre").hidden = !state.centreOpen;
    $("ctCentreBtn").setAttribute("aria-expanded", state.centreOpen ? "true" : "false");
    if (!state.centreOpen) return;

    const status = (r) =>
      isPaused() ? "Pop-ups paused" : r.popup ? "Pop-up showing" : `Closed for this cycle — returns ${fmt(nextCycleAt(r))}`;
    const li = (r) =>
      r.kind === "UNANSWERED"
        ? `<li class="ct-kind-un"><span aria-hidden="true">✉</span><div><strong>Unanswered incoming email</strong> — ${escapeHtml(r.taskName)} (${escapeHtml(r.counterpartyName ? L.COUNTERPARTY_LABELS[r.counterpartyType] + " — " + r.counterpartyName : "counterparty not set")})<br>
            Received ${escapeHtml(fmt(r.receivedAt))} from ${escapeHtml(r.fromAddress)} · no reply for ${escapeHtml(hm(r.elapsedMs))}${r.needsReview ? " · a sent message needs review" : ""}</div><span class="ct-status">${escapeHtml(status(r))}</span></li>`
        : `<li class="ct-kind-wk"><span aria-hidden="true">📅</span><div><strong>Weekly update due</strong> — ${escapeHtml(L.COUNTERPARTY_LABELS[r.groupType])} — ${escapeHtml(r.groupName)}<br>
            Covers ${r.tasks.length} active task${r.tasks.length === 1 ? "" : "s"}: ${r.tasks.map((t) => escapeHtml(t.name)).join("; ")}<br>
            ${r.basis === "LAST_SENT" ? "Last sent message" : "Tracking start (no sent message recorded)"}: ${escapeHtml(fmt(r.anchor))} · ${escapeHtml(dh(r.elapsedMs))} ago${r.overLimit ? " · past the 7-day limit" : ""}</div><span class="ct-status">${escapeHtml(status(r))}</span></li>`;

    $("ctCentre").innerHTML = `<h2>Reminder centre</h2>
      <p class="ct-muted" style="margin:0;font-size:12.5px">Everything currently due for active tasks, including reminders you have closed. Closing a pop-up hides that display only. Send weekly updates yourself in Outlook — this app never sends or drafts email.</p>
      ${items.length ? `<ul>${items.map(li).join("")}</ul>` : `<p class="ct-muted" style="margin:10px 0 0">Nothing is due right now.</p>`}`;
  }

  function renderAll() {
    renderBanner();
    renderControls();
    renderState();
    renderBoard();
    renderCentre();
  }

  /* ---------------------------------------------------------
     Pop-up reminders
     --------------------------------------------------------- */
  function popupEl(r) {
    const el = document.createElement("div");
    el.className = `ct-popup ${r.kind === "UNANSWERED" ? "ct-popup-un" : "ct-popup-wk"}`;
    el.setAttribute("role", "alert");
    el.tabIndex = -1;
    el.dataset.key = r.key;
    el.dataset.cycle = String(r.cycle);
    const demoTag = state.demo ? ` <span class="ct-tag ct-tag-demo">DEMO</span>` : "";
    if (r.kind === "UNANSWERED") {
      const cp = r.counterpartyName ? `${L.COUNTERPARTY_LABELS[r.counterpartyType]} — ${r.counterpartyName}` : "Counterparty not set";
      el.innerHTML = `
        <div class="ct-popup-label"><span aria-hidden="true">✉</span> UNANSWERED INCOMING EMAIL${demoTag}</div>
        <p><strong>${escapeHtml(r.taskName)}</strong> <span class="ct-muted">(WBS ${escapeHtml(r.wbs)})</span></p>
        <p>${escapeHtml(cp)}</p>
        <p>Received ${escapeHtml(fmt(r.receivedAt))} from ${escapeHtml(r.fromAddress)}</p>
        <p><strong>No reply recorded for ${escapeHtml(hm(r.elapsedMs))}</strong></p>
        ${r.needsReview ? `<p class="ct-popup-note">A sent message to this address needs manual review; it was not counted as a reply.</p>` : ""}
        <p class="ct-popup-note">Based on manual records (not verified). This reminder repeats every ${CFG.unansweredRepeatHours} hours until a reply is recorded.</p>
        <button type="button" class="ct-popup-close" aria-label="Close reminder: unanswered email for ${escapeHtml(r.taskName)}">&times;</button>`;
    } else {
      el.innerHTML = `
        <div class="ct-popup-label"><span aria-hidden="true">📅</span> WEEKLY UPDATE DUE${demoTag}</div>
        <p><strong>${escapeHtml(L.COUNTERPARTY_LABELS[r.groupType])} — ${escapeHtml(r.groupName)}</strong></p>
        <p>${r.basis === "LAST_SENT" ? `Last sent message: ${escapeHtml(fmt(r.anchor))}` : `No sent message recorded — counted from tracking start: ${escapeHtml(fmt(r.anchor))}`}</p>
        <p><strong>${escapeHtml(dh(r.elapsedMs))} elapsed${r.overLimit ? " — past the 7-day limit" : " — due before the 7-day limit"}</strong></p>
        <p>Send <strong>one combined weekly update</strong> covering ${r.tasks.length} active task${r.tasks.length === 1 ? "" : "s"}:</p>
        <ul>${r.tasks.map((t) => `<li>${escapeHtml(t.name)}</li>`).join("")}</ul>
        <p class="ct-popup-note">Send it yourself in Outlook. This app does not draft or send email.</p>
        <button type="button" class="ct-popup-close" aria-label="Close reminder: weekly update for ${escapeHtml(r.groupName)}">&times;</button>`;
    }
    return el;
  }

  let focusBeforePopup = null;

  function syncPopups(opts) {
    const box = $("ctPopups");
    const want = reminders().popups.filter((r) => !state.closed.has(`${r.key}#${r.cycle}`));
    const wantIds = new Set(want.map((r) => `${r.key}#${r.cycle}`));

    box.querySelectorAll(".ct-popup").forEach((el) => {
      if (!wantIds.has(`${el.dataset.key}#${el.dataset.cycle}`)) el.remove();
    });
    const shown = new Set([...box.querySelectorAll(".ct-popup")].map((el) => `${el.dataset.key}#${el.dataset.cycle}`));
    let count = shown.size;
    let added = false;
    for (const r of want) {
      const id = `${r.key}#${r.cycle}`;
      if (shown.has(id)) continue;
      if (count >= CFG.maxPopupsAtOnce) break;
      box.appendChild(popupEl(r));
      count++;
      added = true;
    }
    box.querySelectorAll(".ct-popup-more").forEach((n) => n.remove());
    if (want.length > count) {
      const more = document.createElement("div");
      more.className = "ct-popup-more";
      more.textContent = `+${want.length - count} more — open the Reminder centre to review them.`;
      box.appendChild(more);
    }
    if (added && opts && opts.focus && !document.querySelector(".modal-backdrop.open")) {
      focusBeforePopup = document.activeElement;
      const first = box.querySelector(".ct-popup .ct-popup-close");
      if (first) first.focus();
    }
  }

  async function dismiss(key, cycle) {
    state.dismissed[key] = Math.max(state.dismissed[key] || 0, cycle);
    state.closed.add(`${key}#${cycle}`);
    if (state.demo) {
      state.demoDismissed = state.dismissed;
    } else {
      try {
        await apiPost("/api/comms/reminders/dismiss", { key, cycle });
      } catch (e) {
        showBanner(e.message);
      }
    }
    renderCentre();
  }

  function closePopup(el) {
    const box = $("ctPopups");
    const siblings = [...box.querySelectorAll(".ct-popup")];
    const idx = siblings.indexOf(el);
    const next = siblings[idx + 1] || siblings[idx - 1];
    const key = el.dataset.key;
    const cycle = Number(el.dataset.cycle);
    el.remove();
    dismiss(key, cycle);
    syncPopups();
    if (next && document.contains(next)) next.querySelector(".ct-popup-close").focus();
    else if (focusBeforePopup && document.contains(focusBeforePopup)) focusBeforePopup.focus();
  }

  /* ---------------------------------------------------------
     Modals (record event / counterparty)
     --------------------------------------------------------- */
  const modalFocus = new Map();
  function openModal(id, focusEl) {
    modalFocus.set(id, document.activeElement);
    $(id).classList.add("open");
    (focusEl || $(id).querySelector("input:not([type=hidden]), select, button")).focus();
  }
  function closeModal(id) {
    $(id).classList.remove("open");
    const f = modalFocus.get(id);
    if (f && document.contains(f)) f.focus();
  }

  function trap(e, modal) {
    if (e.key !== "Tab") return;
    const f = [...modal.querySelectorAll("button, select, input:not([type=hidden]), textarea, [href]")].filter((n) => !n.disabled && n.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) {
      e.preventDefault();
      f[f.length - 1].focus();
    } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
      e.preventDefault();
      f[0].focus();
    }
  }

  /* ----- record a manual event ----- */
  function updateWhenHint() {
    const hint = $("ctEvWhenHint");
    const r = L.parseLocalInput($("ctEvWhen").value, tz());
    hint.className = "ct-hint";
    if (r.invalid) {
      hint.classList.add("ct-bad");
      hint.textContent = r.error || "Enter a valid date and time";
      return null;
    }
    if (r.ms > Date.now() + 5 * 60e3) {
      hint.classList.add("ct-bad");
      hint.textContent = "The date and time cannot be in the future.";
      return null;
    }
    hint.textContent = r.ambiguous ? "This local time occurs twice (clocks go back). The earlier one will be recorded." : `Recorded as ${L.formatDateTime(r.ms, tz())}`;
    return r.ms;
  }

  function updateDirectionUi() {
    const out = $("ctEvDirection").value === "OUT";
    $("ctEvAddrLabel").textContent = out ? "Recipient email" : "Sender email";
    $("ctEvReplyWrap").hidden = !out;
  }

  function fillReplyOptions(rowId) {
    const evs = eventsFor(rowId);
    const analysis = L.analyseEvents(evs);
    const open = L.sortEvents(evs.filter((e) => e.direction === "IN" && (analysis.get(e.id) || {}).status !== "MATCHED"), "desc");
    $("ctEvReply").innerHTML =
      `<option value="">I’m not sure — flag for review if it looks like a reply</option>` +
      open.map((e) => `<option value="${escapeHtml(e.id)}">Reply to message received ${escapeHtml(fmt(e.occurredAt))} from ${escapeHtml(e.address)}</option>`).join("") +
      `<option value="__none">Not a reply (e.g. a weekly update)</option>`;
  }

  function openEventModal(rowId, direction) {
    const t = state.tasks.find((x) => x.id === rowId);
    if (!t || state.demo) return;
    $("formCtEvent").reset();
    $("ctEvRow").value = rowId;
    $("ctEvDirection").value = direction;
    $("ctEvTzLabel").textContent = tz();
    $("ctEvWhen").value = L.toLocalInputValue(Date.now(), tz());
    $("ctEventTitle").textContent = `Record a message — ${t.address}`;
    $("ctEventNote").textContent =
      "Manual entry: recorded as NOT verified. This does not send or draft any email and does not read Outlook. No message content is stored.";
    $("ctEvError").textContent = "";
    $("ctEvWords").textContent = "0 words — leave blank if you don’t want a note";
    fillReplyOptions(rowId);
    updateDirectionUi();
    updateWhenHint();
    openModal("modalCtEvent");
  }

  async function submitEvent(e) {
    e.preventDefault();
    const err = $("ctEvError");
    err.textContent = "";
    const rowId = $("ctEvRow").value;
    const direction = $("ctEvDirection").value;
    const ms = updateWhenHint();
    if (ms === null) return (err.textContent = "Enter a valid date and time that is not in the future.");
    const address = $("ctEvAddr").value.trim();
    if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(address)) {
      return (err.textContent = direction === "IN" ? "Enter the sender’s email address." : "Enter the recipient’s email address.");
    }
    const summary = $("ctEvSummary").value.trim();
    if (summary) {
      const v = L.validateSummary(summary);
      if (!v.ok) return (err.textContent = `The summary must be 5–9 words (you entered ${v.words}).`);
    }
    const body = { direction, occurredAt: ms, tz: tz(), address, summary: summary || undefined, threadRef: $("ctEvThread").value.trim() || undefined };
    if (direction === "OUT") {
      const r = $("ctEvReply").value;
      if (r === "__none") body.notAReply = true;
      else if (r) body.replyToId = r;
    }
    try {
      await apiPost(`/api/comms/tasks/${encodeURIComponent(rowId)}/events`, body);
      closeModal("modalCtEvent");
      await reloadAndRender();
      await refreshOpenHistory(rowId);
    } catch (ex) {
      err.textContent = ex.message;
    }
  }

  /* ----- counterparty ----- */
  function openCpModal(rowId) {
    const t = state.tasks.find((x) => x.id === rowId);
    if (!t || state.demo) return;
    $("formCtCp").reset();
    $("ctCpRow").value = rowId;
    $("ctCpType").value = t.counterpartyType || "CUSTOMER";
    $("ctCpName").value = t.counterpartyName || "";
    $("ctCpStart").value = t.trackingStart ? L.toLocalInputValue(t.trackingStart, tz()) : "";
    $("ctCpError").textContent = "";
    $("ctCpTitle").textContent = `Counterparty — ${t.address}`;
    openModal("modalCtCp");
  }

  async function submitCp(e) {
    e.preventDefault();
    const err = $("ctCpError");
    err.textContent = "";
    const name = $("ctCpName").value.trim();
    if (!name) return (err.textContent = "Enter a name.");
    const body = { type: $("ctCpType").value, name };
    if ($("ctCpStart").value) {
      const r = L.parseLocalInput($("ctCpStart").value, tz());
      if (r.invalid) return (err.textContent = r.error);
      body.trackingStart = r.ms;
    }
    try {
      await apiPatch(`/api/comms/tasks/${encodeURIComponent($("ctCpRow").value)}/counterparty`, body);
      closeModal("modalCtCp");
      await reloadAndRender();
    } catch (ex) {
      err.textContent = ex.message;
    }
  }

  /* ----- history modal (shared UI) ----- */
  function historyOpts(task) {
    return {
      task,
      events: eventsFor(task.id),
      tz: tz(),
      demo: state.demo,
      editable: !state.demo && task.status === "ACTIVE",
      reload: async () => {
        await load();
        const fresh = state.tasks.find((x) => x.id === task.id) || task;
        return { task: fresh, events: eventsFor(task.id), tz: tz() };
      },
      onMutated: () => {
        renderAll();
        syncPopups();
      },
      onAddEvent: (dir) => {
        UI.closeHistory();
        openEventModal(task.id, dir);
      },
    };
  }

  let historyTaskId = null;
  function openHistory(rowId) {
    const t = state.tasks.find((x) => x.id === rowId);
    if (!t) return;
    historyTaskId = rowId;
    UI.openHistory(historyOpts(t));
  }
  async function refreshOpenHistory(rowId) {
    if (historyTaskId === rowId) {
      const t = state.tasks.find((x) => x.id === rowId);
      if (t) UI.openHistory(historyOpts(t));
    }
  }

  /* ---------------------------------------------------------
     Controls
     --------------------------------------------------------- */
  async function togglePause() {
    const wasPaused = isPaused();
    if (state.demo) {
      state.demoPaused = !wasPaused;
      if (wasPaused) {
        state.demoDismissed = {};
        state.dismissed = state.demoDismissed;
        state.closed.clear();
      }
    } else {
      try {
        await apiPatch("/api/comms/settings", { remindersPaused: !wasPaused });
        state.settings.remindersPaused = !wasPaused;
        if (wasPaused) {
          state.dismissed = {};
          state.closed.clear();
        }
      } catch (e) {
        return showBanner(e.message);
      }
    }
    state.now = Date.now(); // resume recalculates everything that is due right now
    renderAll();
    syncPopups();
  }

  async function toggleDemo() {
    state.demo = !state.demo;
    state.expanded.clear();
    state.closed.clear();
    $("ctPopups").innerHTML = "";
    UI.closeHistory();
    if (state.demo) {
      state.demoData = window.CommsDemo.build(Date.now());
      state.demoDismissed = {};
      state.demoPaused = false;
    }
    await reloadAndRender();
    syncPopups({ focus: false });
  }

  async function changeTz() {
    const v = $("ctTz").value.trim();
    if (!L.isValidTimeZone(v)) {
      showBanner("Unknown time zone. Choose one from the list, e.g. Pacific/Auckland.");
      $("ctTz").value = tz();
      return;
    }
    if (state.demo) state.settings.timezone = v;
    else {
      try {
        await apiPatch("/api/comms/settings", { timezone: v });
        state.settings.timezone = v;
      } catch (e) {
        return showBanner(e.message);
      }
    }
    renderAll();
  }

  /* ---------------------------------------------------------
     Wiring
     --------------------------------------------------------- */
  function wire() {
    $("ctSearch").addEventListener("input", (e) => {
      state.filters.q = e.target.value.trim();
      renderState();
      renderBoard();
    });
    [["ctFilterCp", "cp"], ["ctFilterStatus", "status"], ["ctFilterDue", "due"]].forEach(([id, k]) =>
      $(id).addEventListener("change", (e) => {
        state.filters[k] = e.target.value;
        renderState();
        renderBoard();
      })
    );
    $("ctTz").addEventListener("change", changeTz);
    $("ctPauseBtn").addEventListener("click", togglePause);
    $("ctDemoBtn").addEventListener("click", toggleDemo);
    $("ctCentreBtn").addEventListener("click", () => {
      state.centreOpen = !state.centreOpen;
      renderCentre();
    });

    $("ctBoard").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const id = btn.dataset.task;
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return;
      switch (btn.dataset.action) {
        case "toggle": {
          if (state.expanded.has(id)) state.expanded.delete(id);
          else state.expanded.add(id);
          const card = btn.closest(".ct-task");
          const tmp = document.createElement("div");
          tmp.innerHTML = taskCard(task);
          card.replaceWith(tmp.firstElementChild); // only this task changes; others untouched
          const again = $("ctBoard").querySelector(`[data-task="${CSS.escape(id)}"] [data-action="toggle"]`);
          if (again) again.focus();
          break;
        }
        case "history":
          openHistory(id);
          break;
        case "xlsx":
          UI.downloadExcel({ task, events: eventsFor(id), tz: tz(), demo: state.demo });
          break;
        case "rec-in":
          openEventModal(id, "IN");
          break;
        case "rec-out":
          openEventModal(id, "OUT");
          break;
        case "cp":
          openCpModal(id);
          break;
      }
    });

    $("ctPopups").addEventListener("click", (e) => {
      const b = e.target.closest(".ct-popup-close");
      if (b) closePopup(b.closest(".ct-popup"));
    });

    document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(b.dataset.close)));
    document.querySelectorAll(".modal-backdrop").forEach((bd) => {
      if (!bd.id || bd.id === "commsHistoryModal") return;
      bd.addEventListener("click", (e) => {
        if (e.target === bd) closeModal(bd.id);
      });
      bd.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          closeModal(bd.id);
        } else trap(e, bd);
      });
    });

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || document.querySelector(".modal-backdrop.open")) return;
      const box = $("ctPopups");
      const focused = document.activeElement && document.activeElement.closest(".ct-popup");
      const target = focused || box.querySelector(".ct-popup");
      if (target) closePopup(target);
    });

    $("formCtEvent").addEventListener("submit", submitEvent);
    $("formCtCp").addEventListener("submit", submitCp);
    $("ctEvDirection").addEventListener("change", updateDirectionUi);
    $("ctEvWhen").addEventListener("input", updateWhenHint);
    $("ctEvSummary").addEventListener("input", () => {
      const v = L.validateSummary($("ctEvSummary").value);
      const w = $("ctEvWords");
      const blank = !$("ctEvSummary").value.trim();
      w.className = "ct-hint" + (!blank && !v.ok ? " ct-bad" : "");
      w.textContent = blank ? "0 words — leave blank if you don’t want a note" : `${v.words} word${v.words === 1 ? "" : "s"} — ${v.ok ? "OK" : "needs 5–9 words"}`;
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tick(true);
    });
  }

  async function tick(reload) {
    state.now = Date.now();
    if (reload && !state.demo) {
      try {
        await load();
        state.error = null;
      } catch {
        /* keep showing the last good data */
      }
    }
    renderAll();
    syncPopups();
  }

  function fillTzList() {
    const list = $("ctTzList");
    let zones = [];
    try {
      zones = Intl.supportedValuesOf("timeZone");
    } catch {
      zones = ["Pacific/Auckland", "Australia/Sydney", "Asia/Singapore", "Europe/London", "America/New_York", "UTC"];
    }
    list.innerHTML = zones.map((z) => `<option value="${escapeHtml(z)}"></option>`).join("");
  }

  (async function init() {
    const user = await requireAuthOrRedirect();
    if (!user) return;
    initHeaderFooter("comms", user);
    fillTzList();
    wire();
    renderAll();
    try {
      await load();
    } catch (e) {
      state.error = e.message;
    }
    state.loading = false;
    renderAll();
    syncPopups({ focus: true });
    setInterval(() => tick(true), REFRESH_MS);
  })();
})();

/* =========================================================
   comms-logic.js — Communication Tracker pure logic.
   No DOM, no network, no storage: everything here is deterministic
   and unit-tested (tests/*.test.js). Works in the browser (global
   CommsLogic) and in Node (module.exports).

   PHASE 1 = DEMO / DISCONNECTED. Events are entered manually and are
   never "verified" Outlook messages.
   ========================================================= */
(function (root) {
  "use strict";

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;

  /* Reminder rules. Calendar (elapsed) time: no weekend/holiday
     adjustment, because Phase 1 has no verified send/receive times
     to apply a business-day convention to. DST never shifts these:
     "24 hours" is 24 elapsed hours, "6 days" is 6 x 24 elapsed hours. */
  const DEFAULT_CONFIG = Object.freeze({
    unansweredAfterHours: 24,
    unansweredRepeatHours: 24,
    weeklyDueAfterDays: 6, // one day before the 7-day limit
    weeklyLimitDays: 7,
    weeklyRepeatHours: 24,
    maxPopupsAtOnce: 5,
  });

  const COUNTERPARTY_TYPES = Object.freeze(["CUSTOMER", "VECTOR_TEAM", "OTHER"]);
  const COUNTERPARTY_LABELS = Object.freeze({
    CUSTOMER: "Customer",
    VECTOR_TEAM: "Vector team",
    OTHER: "Other",
  });

  /* ---------------------------------------------------------
     Durations
     --------------------------------------------------------- */
  function splitDuration(sec) {
    sec = Math.max(0, Math.floor(sec));
    return {
      d: Math.floor(sec / 86400),
      h: Math.floor((sec % 86400) / 3600),
      m: Math.floor((sec % 3600) / 60),
    };
  }

  /* "2h 14m", "45m", "1d 3h", "<1m" */
  function formatDuration(sec) {
    if (!Number.isFinite(sec) || sec < 0) return "—";
    if (sec < 60) return "<1m";
    const { d, h, m } = splitDuration(sec);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /* "Awaiting reply — 26h 10m" (hours kept as hours, as in the spec) */
  function formatAwaiting(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `Awaiting reply — ${h}h ${m}m`;
  }

  /* ---------------------------------------------------------
     Summary word count (5-9 words)
     --------------------------------------------------------- */
  function countWords(text) {
    if (typeof text !== "string") return 0;
    return text
      .trim()
      .split(/\s+/)
      .filter((tok) => /[\p{L}\p{N}]/u.test(tok)).length;
  }

  function validateSummary(text) {
    const words = countWords(text);
    return { ok: words >= 5 && words <= 9, words };
  }

  /* ---------------------------------------------------------
     Time zones (IANA), DST-safe
     --------------------------------------------------------- */
  const _partsFmt = new Map();
  function partsFormatter(tz) {
    let f = _partsFmt.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-GB", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
      _partsFmt.set(tz, f);
    }
    return f;
  }

  function isValidTimeZone(tz) {
    if (typeof tz !== "string" || !tz || tz.length > 64) return false;
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  /* Wall-clock components of an instant in a zone. */
  function zonedParts(ms, tz) {
    const out = {};
    for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
      if (p.type !== "literal") out[p.type] = parseInt(p.value, 10);
    }
    return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
  }

  /* Offset (ms) of the zone from UTC at a given instant. */
  function offsetAt(ms, tz) {
    const p = zonedParts(ms, tz);
    const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return wallAsUtc - Math.floor(ms / 1000) * 1000;
  }

  /* Convert a wall-clock time entered in `tz` to a UTC instant.
     invalid   = the time does not exist (spring-forward gap)
     ambiguous = the time occurs twice (fall-back); the earlier is used. */
  function zonedWallToUtc(year, month, day, hour, minute, tz) {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    const offsets = new Set([offsetAt(guess - DAY, tz), offsetAt(guess + DAY, tz)]);
    const valid = [];
    for (const off of offsets) {
      const cand = guess - off;
      if (offsetAt(cand, tz) === off) valid.push(cand);
    }
    if (valid.length === 0) return { ms: null, invalid: true, ambiguous: false };
    valid.sort((a, b) => a - b);
    return { ms: valid[0], invalid: false, ambiguous: valid.length > 1 };
  }

  /* Parse "YYYY-MM-DDTHH:mm" (datetime-local value) in a zone. */
  function parseLocalInput(value, tz) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!m) return { ms: null, invalid: true, ambiguous: false, error: "Enter a date and time" };
    const [y, mo, d, h, mi] = m.slice(1).map(Number);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) {
      return { ms: null, invalid: true, ambiguous: false, error: "Enter a valid date and time" };
    }
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCMonth() !== mo - 1) {
      return { ms: null, invalid: true, ambiguous: false, error: "That date does not exist" };
    }
    const r = zonedWallToUtc(y, mo, d, h, mi, tz);
    if (r.invalid) r.error = "That local time does not exist (clocks move forward). Choose another time.";
    return r;
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  function tzAbbrev(ms, tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(ms));
      const p = parts.find((x) => x.type === "timeZoneName");
      return p ? p.value : tz;
    } catch {
      return tz;
    }
  }

  /* "2026-10-26 14:05 NZDT" */
  function formatDateTime(ms, tz) {
    if (!Number.isFinite(ms)) return "—";
    const p = zonedParts(ms, tz);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)} ${tzAbbrev(ms, tz)}`;
  }

  /* "YYYY-MM-DDTHH:mm" for a datetime-local input, in tz */
  function toLocalInputValue(ms, tz) {
    const p = zonedParts(ms, tz);
    return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
  }

  /* Excel serial number for the wall-clock time in tz (Excel has no zones). */
  function excelSerial(ms, tz) {
    const p = zonedParts(ms, tz);
    const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return wall / DAY + 25569;
  }

  /* ---------------------------------------------------------
     Event ordering + reply matching
     --------------------------------------------------------- */
  const dirRank = (d) => (d === "IN" ? 0 : 1);

  /* Chronological; IN before OUT when timestamps are equal; id as tiebreak. */
  function sortEvents(events, order) {
    const asc = (a, b) =>
      a.occurredAt - b.occurredAt || dirRank(a.direction) - dirRank(b.direction) || String(a.id).localeCompare(String(b.id));
    const arr = [...events].sort(asc);
    return order === "desc" ? arr.reverse() : arr;
  }

  const norm = (s) => String(s || "").trim().toLowerCase();

  /* Pair received messages with sent replies — ONLY when reliable.
     Reliable = the user explicitly linked the reply (replyToId), or both
     events carry the same non-empty thread reference.
     A sent message to an address with open received messages but no link
     is NOT paired: it is flagged REVIEW (nothing is invented).

     Returns Map(eventId -> {
       status: 'MATCHED' | 'AWAITING' | 'REVIEW' | 'STANDALONE',
       pairedId, durationSec, candidates: [inIds] }) */
  function analyseEvents(events) {
    const sorted = sortEvents(events, "asc");
    const result = new Map();
    const ins = sorted.filter((e) => e.direction === "IN");
    const byId = new Map(ins.map((e) => [e.id, e]));
    const inMatchedBy = new Map(); // inId -> out event
    const outPaired = new Map(); // outId -> in event

    for (const out of sorted.filter((e) => e.direction === "OUT")) {
      let target = null;
      if (out.replyToId && !out.notAReply) {
        const cand = byId.get(out.replyToId);
        if (cand && cand.occurredAt <= out.occurredAt) target = cand;
      }
      if (!target && !out.notAReply && norm(out.threadRef)) {
        const cands = ins.filter(
          (i) => norm(i.threadRef) === norm(out.threadRef) && i.occurredAt <= out.occurredAt && !inMatchedBy.has(i.id)
        );
        if (cands.length) target = cands[cands.length - 1];
      }
      if (target && !inMatchedBy.has(target.id)) {
        inMatchedBy.set(target.id, out);
        outPaired.set(out.id, target);
      }
    }

    const reviewCandidates = new Map(); // inId -> flagged (appears as candidate)
    for (const out of sorted.filter((e) => e.direction === "OUT")) {
      const paired = outPaired.get(out.id);
      if (paired) {
        result.set(out.id, {
          status: "MATCHED",
          pairedId: paired.id,
          durationSec: Math.max(0, Math.round((out.occurredAt - paired.occurredAt) / 1000)),
          candidates: [],
        });
        continue;
      }
      let candidates = [];
      if (!out.notAReply) {
        candidates = ins
          .filter((i) => i.occurredAt <= out.occurredAt && !inMatchedBy.has(i.id) && norm(i.address) === norm(out.address))
          .map((i) => i.id);
      }
      candidates.forEach((id) => reviewCandidates.set(id, true));
      result.set(out.id, {
        status: candidates.length ? "REVIEW" : "STANDALONE",
        pairedId: null,
        durationSec: null,
        candidates,
      });
    }

    for (const i of ins) {
      const out = inMatchedBy.get(i.id);
      if (out) {
        result.set(i.id, {
          status: "MATCHED",
          pairedId: out.id,
          durationSec: Math.max(0, Math.round((out.occurredAt - i.occurredAt) / 1000)),
          candidates: [],
        });
      } else {
        result.set(i.id, {
          status: reviewCandidates.has(i.id) ? "REVIEW" : "AWAITING",
          pairedId: null,
          durationSec: null,
          candidates: [],
        });
      }
    }
    return result;
  }

  /* ---------------------------------------------------------
     Reminders
     --------------------------------------------------------- */
  function groupKey(type, name) {
    return `${type}:${encodeURIComponent(String(name || "").trim().toLowerCase())}`;
  }

  function isTracked(t) {
    return !!(t && t.counterpartyType && t.counterpartyName);
  }

  /* cycle number of a repeating reminder: 0 = not due yet;
     1 = first display; 2 = one repeat interval later; ... */
  function cycleFor(elapsedMs, afterMs, repeatMs) {
    if (elapsedMs < afterMs) return 0;
    return 1 + Math.floor((elapsedMs - afterMs) / repeatMs);
  }

  /* tasks:   [{id,status,address,wbs,counterpartyType,counterpartyName,trackingStart}]
     events:  [{id,rowId,direction,occurredAt,address,replyToId,threadRef,notAReply}]
     dismissed: {reminderKey: dismissedCycle}   paused: boolean
     Only ACTIVE tasks ever produce reminders. Pausing never changes what is
     DUE — it only turns off pop-ups (`popup` flag). */
  function computeReminders({ tasks, events, now, config, dismissed, paused }) {
    const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    dismissed = dismissed || {};
    const active = (tasks || []).filter((t) => t.status === "ACTIVE");
    const byRow = new Map();
    for (const e of events || []) {
      if (!byRow.has(e.rowId)) byRow.set(e.rowId, []);
      byRow.get(e.rowId).push(e);
    }

    const unanswered = [];
    for (const t of active) {
      const rowEvents = byRow.get(t.id) || [];
      const analysis = analyseEvents(rowEvents);
      for (const e of rowEvents) {
        if (e.direction !== "IN") continue;
        const a = analysis.get(e.id);
        if (!a || a.status === "MATCHED") continue; // a verified/linked reply clears it
        const elapsedMs = now - e.occurredAt;
        const cycle = cycleFor(elapsedMs, cfg.unansweredAfterHours * HOUR, cfg.unansweredRepeatHours * HOUR);
        if (!cycle) continue;
        const key = `UNANS:${e.id}`;
        unanswered.push({
          kind: "UNANSWERED",
          key,
          cycle,
          rowId: t.id,
          taskName: t.address,
          wbs: t.wbs,
          counterpartyType: t.counterpartyType || null,
          counterpartyName: t.counterpartyName || null,
          eventId: e.id,
          fromAddress: e.address,
          receivedAt: e.occurredAt,
          elapsedMs,
          needsReview: a.status === "REVIEW",
          popup: !paused && cycle > (dismissed[key] || 0),
        });
      }
    }

    // Weekly: one reminder per counterparty group, never per task.
    const groupsMap = new Map();
    for (const t of active.filter(isTracked)) {
      const key = groupKey(t.counterpartyType, t.counterpartyName);
      if (!groupsMap.has(key)) {
        groupsMap.set(key, { key, type: t.counterpartyType, name: String(t.counterpartyName).trim(), tasks: [] });
      }
      groupsMap.get(key).tasks.push(t);
    }

    const groups = [];
    const weekly = [];
    for (const g of groupsMap.values()) {
      let lastOut = null;
      let earliestStart = null;
      for (const t of g.tasks) {
        for (const e of byRow.get(t.id) || []) {
          if (e.direction === "OUT" && (lastOut === null || e.occurredAt > lastOut)) lastOut = e.occurredAt;
        }
        if (Number.isFinite(t.trackingStart) && (earliestStart === null || t.trackingStart < earliestStart)) {
          earliestStart = t.trackingStart;
        }
      }
      const anchor = lastOut !== null ? lastOut : earliestStart;
      const basis = lastOut !== null ? "LAST_SENT" : "TRACKING_START";
      const info = {
        key: g.key,
        type: g.type,
        name: g.name,
        tasks: g.tasks,
        anchor,
        basis,
        elapsedMs: anchor === null ? null : now - anchor,
        dueAt: anchor === null ? null : anchor + cfg.weeklyDueAfterDays * DAY,
        limitAt: anchor === null ? null : anchor + cfg.weeklyLimitDays * DAY,
        due: false,
        overLimit: false,
      };
      if (anchor !== null) {
        const cycle = cycleFor(now - anchor, cfg.weeklyDueAfterDays * DAY, cfg.weeklyRepeatHours * HOUR);
        info.due = cycle > 0;
        info.overLimit = now - anchor >= cfg.weeklyLimitDays * DAY;
        if (cycle > 0) {
          const key = `WEEKLY:${g.key}`;
          weekly.push({
            kind: "WEEKLY",
            key,
            cycle,
            groupType: g.type,
            groupName: g.name,
            tasks: g.tasks.map((t) => ({ id: t.id, name: t.address, wbs: t.wbs })),
            anchor,
            basis,
            elapsedMs: now - anchor,
            overLimit: info.overLimit,
            popup: !paused && cycle > (dismissed[key] || 0),
          });
        }
      }
      groups.push(info);
    }

    const popups = [...unanswered, ...weekly]
      .filter((r) => r.popup)
      .sort((a, b) => (a.kind === b.kind ? b.elapsedMs - a.elapsedMs : a.kind === "UNANSWERED" ? -1 : 1));

    return { unanswered, weekly, groups, popups, paused: !!paused };
  }

  /* ---------------------------------------------------------
     Table + export rows
     --------------------------------------------------------- */
  const SUMMARY_UNAVAILABLE = "Unavailable — message content not accessed (Phase 1)";

  function describeSummary(e) {
    if (e.summary && e.summaryBasis === "MANUAL") return { text: e.summary, basis: "Manual note" };
    if (e.summary && e.summaryBasis === "METADATA") return { text: e.summary, basis: "Metadata-based" };
    return { text: SUMMARY_UNAVAILABLE, basis: "Unavailable" };
  }

  function durationCell(e, analysis, now, taskStatus) {
    const a = analysis.get(e.id);
    if (!a) return { text: "—", seconds: null };
    if (a.status === "MATCHED") return { text: formatDuration(a.durationSec), seconds: a.durationSec };
    if (e.direction === "IN") {
      if (taskStatus === "ACTIVE") {
        const sec = Math.max(0, Math.floor((now - e.occurredAt) / 1000));
        return { text: a.status === "REVIEW" ? `${formatAwaiting(sec)} (possible reply — review)` : formatAwaiting(sec), seconds: sec };
      }
      return { text: "No reply recorded", seconds: null };
    }
    return { text: a.status === "REVIEW" ? "Needs review" : "—", seconds: null };
  }

  function matchLabel(e, analysis) {
    const a = analysis.get(e.id);
    if (!a) return "";
    if (a.status === "MATCHED") return "Matched";
    if (a.status === "REVIEW") return "Needs manual review";
    if (a.status === "AWAITING") return "No reply recorded";
    return "Not linked to a received message";
  }

  /* Rows for the Excel export (also reused by tests). */
  function buildExport({ task, events, tz, now, demo }) {
    const analysis = analyseEvents(events);
    const rows = sortEvents(events, "asc").map((e) => {
      const dur = durationCell(e, analysis, now, task.status);
      const s = describeSummary(e);
      return {
        serial: excelSerial(e.occurredAt, tz),
        tzLabel: tzAbbrev(e.occurredAt, tz),
        direction: e.direction === "IN" ? "Received (incoming)" : "Sent (outgoing)",
        address: e.address,
        addressRole: e.direction === "IN" ? "Sender" : "Recipient",
        duration: dur.text,
        durationSec: dur.seconds,
        summary: s.text,
        summaryBasis: s.basis,
        match: matchLabel(e, analysis),
        source: demo ? "DEMO — fictional" : "Manual entry — not verified",
      };
    });
    const cp = task.counterpartyType
      ? `${COUNTERPARTY_LABELS[task.counterpartyType] || task.counterpartyType} — ${task.counterpartyName}`
      : "Not set";
    return {
      header: [
        "Date & time",
        "Time zone",
        "Direction / type",
        "Sender / recipient",
        "Email address",
        "Response duration",
        "Response (seconds)",
        "Summary (5–9 words)",
        "Summary basis",
        "Match status",
        "Record source",
      ],
      rows,
      info: [
        ["Communication history", demo ? "DEMO DATA — fictional, not a real task" : ""],
        ["Project / task", task.address],
        ["WBS", task.wbs],
        ["Task status", task.status === "COMPLETED" ? "Completed" : "Active"],
        ["Counterparty", cp],
        ["Mode", "Demo/Disconnected — Outlook is not connected. Events are entered manually and are NOT verified emails."],
        ["Display time zone", tz],
        ["Exported at", formatDateTime(now, tz)],
        ["Event count", String(rows.length)],
      ],
    };
  }

  /* Workbook spec consumed by XlsxWriter.build (shared by the UI and tests). */
  function exportWorkbookSpec(exp) {
    const widths = [20, 10, 20, 14, 32, 32, 12, 46, 16, 26, 28];
    const types = ["datetime", "text", "text", "text", "text", "text", "number", "text", "text", "text", "text"];
    return {
      sheets: [
        {
          name: "Communication history",
          columns: exp.header.map((h, i) => ({ header: h, width: widths[i], type: types[i] })),
          rows: exp.rows.map((r) => [
            r.serial, r.tzLabel, r.direction, r.addressRole, r.address, r.duration, r.durationSec, r.summary, r.summaryBasis, r.match, r.source,
          ]),
        },
        { name: "Task info", kv: exp.info },
      ],
    };
  }

  function exportFileName(task, now, tz, demo) {
    const safe = (v) => String(v || "").replace(/[^\w-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
    const p = zonedParts(now, tz);
    const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
    const label = safe(task.wbs) || safe(task.address) || "task";
    return `${demo ? "DEMO_" : ""}communication-history_${label}_${date}.xlsx`;
  }

  const api = {
    HOUR,
    DAY,
    DEFAULT_CONFIG,
    COUNTERPARTY_TYPES,
    COUNTERPARTY_LABELS,
    SUMMARY_UNAVAILABLE,
    formatDuration,
    formatAwaiting,
    countWords,
    validateSummary,
    isValidTimeZone,
    zonedParts,
    zonedWallToUtc,
    parseLocalInput,
    formatDateTime,
    toLocalInputValue,
    tzAbbrev,
    excelSerial,
    sortEvents,
    analyseEvents,
    groupKey,
    isTracked,
    cycleFor,
    computeReminders,
    describeSummary,
    durationCell,
    matchLabel,
    buildExport,
    exportWorkbookSpec,
    exportFileName,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CommsLogic = api;
})(typeof self !== "undefined" ? self : globalThis);

// src/comms.js
// Communication Tracker API — PHASE 1: DEMO / DISCONNECTED.
//
// * Every route is called by src/index.js only AFTER the existing session
//   check; every query is scoped to user.id (same isolation as /api/rows).
// * Reuses the existing `rows` table for tasks. No second task register.
// * Events are MANUAL entries and are never "verified". There is NO mailbox
//   connector, no OAuth, no Microsoft Graph code, no token handling, and no
//   email send/draft capability anywhere in this file.
// * Stores metadata only: no message bodies, subjects or attachments.

const COUNTERPARTY_TYPES = ["CUSTOMER", "VECTOR_TEAM", "OTHER"];
const MIN_EVENT_MS = Date.UTC(2000, 0, 1);
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const REMINDER_KEY_RE = /^(UNANS|WEEKLY):[\w:%.~-]{1,300}$/;

/* The connector boundary. Phase 1 has NO code path that can enable it:
   it is a constant, not an environment switch. */
export const CONNECTOR_STATUS = Object.freeze({
  mode: "DEMO_DISCONNECTED",
  connected: false,
  enabled: false,
  lastSync: null,
  message:
    "Outlook is not connected. This version does not read or track real Outlook messages. " +
    "Events are entered manually and are never verified.",
});

export async function handleComms(request, env, url, user, deps = {}) {
  const now = deps.now ? deps.now() : Date.now();
  if (env.COMMS_ENABLED === "false") {
    return json({ error: "Communication Tracker is switched off", code: "DISABLED" }, 404);
  }
  try {
    return await route(request, env, url, user, now);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) {
      return json(
        {
          error:
            "The Communication Tracker database tables have not been created yet. Run schema_comms.sql once in the D1 Console, then reload.",
          code: "MIGRATION_REQUIRED",
        },
        503
      );
    }
    throw err;
  }
}

async function route(request, env, url, user, now) {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/comms/status" && method === "GET") {
    return json({ ...CONNECTOR_STATUS, settings: await getSettings(env, user) });
  }
  if (path === "/api/comms/overview" && method === "GET") return await overview(env, user, now);
  if (path === "/api/comms/settings" && method === "PATCH") return await patchSettings(request, env, user, now);
  if (path === "/api/comms/reminders/dismiss" && method === "POST") return await dismissReminder(request, env, user, now);

  let m = path.match(/^\/api\/comms\/tasks\/([^/]+)\/history$/);
  if (m && method === "GET") return await taskHistory(env, user, m[1]);

  m = path.match(/^\/api\/comms\/tasks\/([^/]+)\/counterparty$/);
  if (m && method === "PATCH") return await setCounterparty(request, env, user, m[1], now);

  m = path.match(/^\/api\/comms\/tasks\/([^/]+)\/events$/);
  if (m && method === "POST") return await createEvent(request, env, user, m[1], now);

  m = path.match(/^\/api\/comms\/events\/([^/]+)$/);
  if (m && method === "PATCH") return await patchEvent(request, env, user, m[1]);
  if (m && method === "DELETE") return await deleteEvent(env, user, m[1]);

  return json({ error: "Not found" }, 404);
}

/* ===========================================================
   Overview — all ACTIVE tasks (from `rows`) + their events
   =========================================================== */
async function overview(env, user, now) {
  await purgeOrphans(env, user);

  const { results: taskRows } = await env.DB.prepare(
    `SELECT r.*, m.counterparty_type, m.counterparty_name, m.tracking_start
       FROM rows r
       LEFT JOIN comm_task_meta m ON m.row_id = r.id AND m.user_id = r.user_id
      WHERE r.user_id = ? AND r.status = 'ACTIVE'
      ORDER BY r.no ASC`
  )
    .bind(user.id)
    .all();

  const { results: eventRows } = await env.DB.prepare(
    `SELECT e.* FROM comm_events e
       JOIN rows r ON r.id = e.row_id AND r.user_id = e.user_id
      WHERE e.user_id = ? AND r.status = 'ACTIVE'
      ORDER BY e.occurred_at ASC`
  )
    .bind(user.id)
    .all();

  const { results: stateRows } = await env.DB.prepare(
    "SELECT reminder_key, dismissed_cycle FROM comm_reminder_state WHERE user_id = ?"
  )
    .bind(user.id)
    .all();
  const dismissed = {};
  stateRows.forEach((s) => (dismissed[s.reminder_key] = s.dismissed_cycle));

  return json({
    ...CONNECTOR_STATUS,
    serverTime: now,
    settings: await getSettings(env, user),
    tasks: taskRows.map(taskOut),
    events: eventRows.map(eventOut),
    dismissed,
  });
}

/* Task/meta cleanup when a task was deleted through the existing tracker
   (we deliberately do not modify that code path). User-scoped. */
async function purgeOrphans(env, user) {
  try {
    await env.DB.prepare(
      "DELETE FROM comm_events WHERE user_id = ? AND row_id NOT IN (SELECT id FROM rows WHERE user_id = ?)"
    )
      .bind(user.id, user.id)
      .run();
    await env.DB.prepare(
      "DELETE FROM comm_task_meta WHERE user_id = ? AND row_id NOT IN (SELECT id FROM rows WHERE user_id = ?)"
    )
      .bind(user.id, user.id)
      .run();
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) throw err;
    /* best effort otherwise */
  }
}

async function taskHistory(env, user, rowId) {
  const row = await env.DB.prepare(
    `SELECT r.*, m.counterparty_type, m.counterparty_name, m.tracking_start
       FROM rows r
       LEFT JOIN comm_task_meta m ON m.row_id = r.id AND m.user_id = r.user_id
      WHERE r.id = ? AND r.user_id = ?`
  )
    .bind(rowId, user.id)
    .first();
  if (!row) return json({ error: "Task not found" }, 404);

  const { results } = await env.DB.prepare(
    "SELECT * FROM comm_events WHERE user_id = ? AND row_id = ? ORDER BY occurred_at ASC"
  )
    .bind(user.id, rowId)
    .all();

  return json({
    ...CONNECTOR_STATUS,
    settings: await getSettings(env, user),
    task: taskOut(row),
    events: results.map(eventOut),
  });
}

/* ===========================================================
   Counterparty (optional metadata on an existing task)
   =========================================================== */
async function setCounterparty(request, env, user, rowId, now) {
  const body = await safeJson(request);
  const type = String(body.type || "").toUpperCase();
  const name = String(body.name || "").trim();
  if (!COUNTERPARTY_TYPES.includes(type)) return json({ error: "Choose Customer, Vector team or Other" }, 400);
  if (name.length < 1 || name.length > 120) return json({ error: "Enter a counterparty name (max 120 characters)" }, 400);

  const row = await env.DB.prepare("SELECT id, status FROM rows WHERE id = ? AND user_id = ?").bind(rowId, user.id).first();
  if (!row) return json({ error: "Task not found" }, 404);

  let trackingStart = null;
  if (body.trackingStart !== undefined && body.trackingStart !== null) {
    trackingStart = Number(body.trackingStart);
    if (!Number.isFinite(trackingStart) || trackingStart < MIN_EVENT_MS || trackingStart > now + CLOCK_SKEW_MS) {
      return json({ error: "Tracking start must be a valid date that is not in the future" }, 400);
    }
  }

  const existing = await env.DB.prepare("SELECT tracking_start FROM comm_task_meta WHERE row_id = ? AND user_id = ?")
    .bind(rowId, user.id)
    .first();
  const start = trackingStart ?? (existing ? existing.tracking_start : now);

  await env.DB.prepare(
    `INSERT INTO comm_task_meta (row_id, user_id, counterparty_type, counterparty_name, tracking_start, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(row_id) DO UPDATE SET
       counterparty_type = excluded.counterparty_type,
       counterparty_name = excluded.counterparty_name,
       tracking_start    = excluded.tracking_start,
       updated_at        = excluded.updated_at
     WHERE comm_task_meta.user_id = excluded.user_id`
  )
    .bind(rowId, user.id, type, name, start, now)
    .run();

  return json({ rowId, counterpartyType: type, counterpartyName: name, trackingStart: start });
}

/* ===========================================================
   Events (manual entry — never verified)
   =========================================================== */
async function createEvent(request, env, user, rowId, now) {
  const body = await safeJson(request);
  const row = await env.DB.prepare("SELECT id, status FROM rows WHERE id = ? AND user_id = ?").bind(rowId, user.id).first();
  if (!row) return json({ error: "Task not found" }, 404);
  if (row.status !== "ACTIVE") return json({ error: "Events can only be added to active tasks" }, 400);

  const direction = body.direction === "IN" ? "IN" : body.direction === "OUT" ? "OUT" : null;
  if (!direction) return json({ error: "Direction must be IN (received) or OUT (sent)" }, 400);

  const occurredAt = Number(body.occurredAt);
  if (!Number.isFinite(occurredAt) || occurredAt < MIN_EVENT_MS) return json({ error: "Enter a valid date and time" }, 400);
  if (occurredAt > now + CLOCK_SKEW_MS) return json({ error: "The date and time cannot be in the future" }, 400);

  const address = String(body.address || "").trim().slice(0, 254);
  if (!EMAIL_RE.test(address)) {
    return json({ error: direction === "IN" ? "Enter the sender's email address" : "Enter the recipient's email address" }, 400);
  }

  let tz = body.tz ? String(body.tz) : null;
  if (tz && !validTimeZone(tz)) return json({ error: "Unknown time zone" }, 400);

  let summary = null;
  let summaryBasis = "UNAVAILABLE";
  if (body.summary !== undefined && body.summary !== null && String(body.summary).trim() !== "") {
    summary = String(body.summary).trim().replace(/\s+/g, " ");
    const words = countWords(summary);
    if (words < 5 || words > 9) return json({ error: `The summary must be 5–9 words (you entered ${words})` }, 400);
    summaryBasis = "MANUAL";
  }

  const threadRef = body.threadRef ? String(body.threadRef).trim().slice(0, 120) || null : null;

  let replyToId = null;
  const notAReply = body.notAReply ? 1 : 0;
  if (body.replyToId) {
    if (direction !== "OUT") return json({ error: "Only a sent message can be a reply" }, 400);
    if (notAReply) return json({ error: "Choose either a reply link or 'not a reply'" }, 400);
    const target = await env.DB.prepare(
      "SELECT id, direction, occurred_at FROM comm_events WHERE id = ? AND user_id = ? AND row_id = ?"
    )
      .bind(String(body.replyToId), user.id, rowId)
      .first();
    if (!target || target.direction !== "IN") return json({ error: "The linked message was not found on this task" }, 400);
    if (target.occurred_at > occurredAt) return json({ error: "A reply cannot be sent before the message it answers" }, 400);
    replyToId = target.id;
  }
  if (notAReply && direction !== "OUT") return json({ error: "Only a sent message can be marked 'not a reply'" }, 400);

  const id = crypto.randomUUID();
  const dedupeKey = `${direction}|${occurredAt}|${address.toLowerCase()}`;
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO comm_events
       (id, user_id, row_id, direction, occurred_at, tz, address, summary, summary_basis, source,
        reply_to_id, thread_ref, not_a_reply, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', ?, ?, ?, ?, ?)`
  )
    .bind(id, user.id, rowId, direction, occurredAt, tz, address, summary, summaryBasis, replyToId, threadRef, notAReply, dedupeKey, now)
    .run();

  if (!res.meta || res.meta.changes === 0) {
    return json({ error: "That event is already recorded (same direction, time and address)", code: "DUPLICATE" }, 409);
  }
  const saved = await env.DB.prepare("SELECT * FROM comm_events WHERE id = ?").bind(id).first();
  return json(eventOut(saved), 201);
}

/* Resolve a suggested match: link to a received message, or rule it out. */
async function patchEvent(request, env, user, id) {
  const body = await safeJson(request);
  const ev = await env.DB.prepare("SELECT * FROM comm_events WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!ev) return json({ error: "Event not found" }, 404);
  if (ev.direction !== "OUT") return json({ error: "Only sent messages can be linked to a received message" }, 400);

  const task = await env.DB.prepare("SELECT status FROM rows WHERE id = ? AND user_id = ?").bind(ev.row_id, user.id).first();
  if (!task || task.status !== "ACTIVE") return json({ error: "Only events on active tasks can be edited" }, 400);

  if (body.notAReply === true) {
    await env.DB.prepare("UPDATE comm_events SET not_a_reply = 1, reply_to_id = NULL WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  } else if (body.replyToId) {
    const target = await env.DB.prepare(
      "SELECT id, direction, occurred_at FROM comm_events WHERE id = ? AND user_id = ? AND row_id = ?"
    )
      .bind(String(body.replyToId), user.id, ev.row_id)
      .first();
    if (!target || target.direction !== "IN") return json({ error: "The linked message was not found on this task" }, 400);
    if (target.occurred_at > ev.occurred_at) return json({ error: "A reply cannot be sent before the message it answers" }, 400);
    await env.DB.prepare("UPDATE comm_events SET reply_to_id = ?, not_a_reply = 0 WHERE id = ? AND user_id = ?").bind(target.id, id, user.id).run();
  } else if (body.replyToId === null) {
    await env.DB.prepare("UPDATE comm_events SET reply_to_id = NULL, not_a_reply = 0 WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  } else {
    return json({ error: "Nothing to change" }, 400);
  }
  const saved = await env.DB.prepare("SELECT * FROM comm_events WHERE id = ?").bind(id).first();
  return json(eventOut(saved));
}

async function deleteEvent(env, user, id) {
  const ev = await env.DB.prepare("SELECT row_id FROM comm_events WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!ev) return json({ error: "Event not found" }, 404);
  const task = await env.DB.prepare("SELECT status FROM rows WHERE id = ? AND user_id = ?").bind(ev.row_id, user.id).first();
  if (!task || task.status !== "ACTIVE") return json({ error: "Only events on active tasks can be deleted" }, 400);

  await env.DB.prepare("UPDATE comm_events SET reply_to_id = NULL WHERE user_id = ? AND reply_to_id = ?").bind(user.id, id).run();
  await env.DB.prepare("DELETE FROM comm_events WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true });
}

/* ===========================================================
   Settings (pause persists per user) + reminder dismissal
   =========================================================== */
async function getSettings(env, user) {
  const s = await env.DB.prepare("SELECT reminders_paused, timezone FROM comm_settings WHERE user_id = ?").bind(user.id).first();
  return { remindersPaused: !!(s && s.reminders_paused), timezone: s ? s.timezone : null };
}

async function patchSettings(request, env, user, now) {
  const body = await safeJson(request);
  const current = await env.DB.prepare("SELECT reminders_paused, timezone FROM comm_settings WHERE user_id = ?").bind(user.id).first();
  let paused = current ? current.reminders_paused : 0;
  let timezone = current ? current.timezone : null;

  if (body.remindersPaused !== undefined) paused = body.remindersPaused ? 1 : 0;
  if (body.timezone !== undefined) {
    if (body.timezone !== null && !validTimeZone(String(body.timezone))) return json({ error: "Unknown time zone" }, 400);
    timezone = body.timezone;
  }

  await env.DB.prepare(
    `INSERT INTO comm_settings (user_id, reminders_paused, timezone, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET reminders_paused = excluded.reminders_paused,
       timezone = excluded.timezone, updated_at = excluded.updated_at`
  )
    .bind(user.id, paused, timezone, now)
    .run();

  // Resuming recalculates from scratch: previously closed displays are cleared so
  // everything that is due right now is shown again. History is untouched.
  if (body.remindersPaused === false) {
    await env.DB.prepare("DELETE FROM comm_reminder_state WHERE user_id = ?").bind(user.id).run();
  }
  return json({ remindersPaused: !!paused, timezone });
}

async function dismissReminder(request, env, user, now) {
  const body = await safeJson(request);
  const key = String(body.key || "");
  const cycle = Number(body.cycle);
  if (!REMINDER_KEY_RE.test(key)) return json({ error: "Invalid reminder" }, 400);
  if (!Number.isInteger(cycle) || cycle < 0 || cycle > 1000000) return json({ error: "Invalid reminder cycle" }, 400);

  await env.DB.prepare(
    `INSERT INTO comm_reminder_state (user_id, reminder_key, dismissed_cycle, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, reminder_key) DO UPDATE SET
       dismissed_cycle = MAX(comm_reminder_state.dismissed_cycle, excluded.dismissed_cycle),
       updated_at = excluded.updated_at`
  )
    .bind(user.id, key, cycle, now)
    .run();
  return json({ ok: true });
}

/* ===========================================================
   Helpers
   =========================================================== */
function taskOut(r) {
  return {
    id: r.id,
    no: r.no,
    address: r.address,
    wbs: r.wbs,
    stage: r.stage,
    startDate: r.start_date,
    state: r.state,
    stateChangedAt: r.state_changed_at,
    heldAccumulatedSec: r.held_accumulated_sec,
    status: r.status,
    closedAt: r.closed_at,
    counterpartyType: r.counterparty_type || null,
    counterpartyName: r.counterparty_name || null,
    trackingStart: r.tracking_start ?? null,
  };
}

function eventOut(e) {
  return {
    id: e.id,
    rowId: e.row_id,
    direction: e.direction,
    occurredAt: e.occurred_at,
    tz: e.tz,
    address: e.address,
    summary: e.summary,
    summaryBasis: e.summary_basis,
    source: e.source,
    verified: false, // Phase 1: nothing is ever verified against Outlook
    replyToId: e.reply_to_id,
    threadRef: e.thread_ref,
    notAReply: !!e.not_a_reply,
  };
}

function countWords(text) {
  return String(text)
    .trim()
    .split(/\s+/)
    .filter((tok) => /[\p{L}\p{N}]/u.test(tok)).length;
}

function validTimeZone(tz) {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function safeJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

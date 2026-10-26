-- schema_comms.sql — Communication Tracker (Phase 1: Demo/Disconnected)
--
-- ADDITIVE ONLY. Creates 4 new tables + indexes. It does NOT alter, drop or
-- touch the existing `rows`, `users` or `sessions` tables, and it is safe to
-- run more than once (every statement uses IF NOT EXISTS).
--
-- Run once in: Cloudflare dashboard -> D1 -> site_control_db -> Console.
-- Rollback (removes ONLY communication data; tasks are unaffected):
--   DROP TABLE IF EXISTS comm_reminder_state;
--   DROP TABLE IF EXISTS comm_settings;
--   DROP TABLE IF EXISTS comm_events;
--   DROP TABLE IF EXISTS comm_task_meta;

-- Counterparty + tracking start for an existing task (rows.id). Optional:
-- a task with no row here simply shows "Counterparty not set".
CREATE TABLE IF NOT EXISTS comm_task_meta (
  row_id            TEXT PRIMARY KEY,           -- = rows.id (no duplicate task register)
  user_id           TEXT NOT NULL,
  counterparty_type TEXT NOT NULL,              -- 'CUSTOMER' | 'VECTOR_TEAM' | 'OTHER'
  counterparty_name TEXT NOT NULL,
  tracking_start    INTEGER NOT NULL,           -- UTC ms; weekly-reminder anchor when no outgoing history
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_meta_user ON comm_task_meta(user_id);

-- Communication events. Phase 1: every event is source 'MANUAL' and is NEVER
-- verified. No message bodies, subjects or attachments are stored.
CREATE TABLE IF NOT EXISTS comm_events (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  row_id        TEXT NOT NULL,                  -- = rows.id
  direction     TEXT NOT NULL,                  -- 'IN' (received) | 'OUT' (sent)
  occurred_at   INTEGER NOT NULL,               -- UTC ms
  tz            TEXT,                           -- IANA zone the user entered it in (display hint only)
  address       TEXT NOT NULL,                  -- sender (IN) or recipient (OUT) email
  summary       TEXT,                           -- optional 5-9 word manual note; NULL = unavailable
  summary_basis TEXT NOT NULL DEFAULT 'UNAVAILABLE', -- 'MANUAL' | 'UNAVAILABLE' (reserved: 'METADATA')
  source        TEXT NOT NULL DEFAULT 'MANUAL', -- reserved for an approved connector later
  reply_to_id   TEXT,                           -- OUT -> the IN event it answers (explicit match)
  thread_ref    TEXT,                           -- optional conversation/project reference
  not_a_reply   INTEGER NOT NULL DEFAULT 0,     -- user ruled out a suggested match
  dedupe_key    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_events_row ON comm_events(user_id, row_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_comm_events_dedupe ON comm_events(user_id, row_id, dedupe_key);

-- Per-user settings (reminder pause persists here; timezone for display).
CREATE TABLE IF NOT EXISTS comm_settings (
  user_id          TEXT PRIMARY KEY,
  reminders_paused INTEGER NOT NULL DEFAULT 0,
  timezone         TEXT,
  updated_at       INTEGER NOT NULL
);

-- Which reminder cycle the user closed (dismisses ONE display; the next cycle
-- is a new reminder).
CREATE TABLE IF NOT EXISTS comm_reminder_state (
  user_id         TEXT NOT NULL,
  reminder_key    TEXT NOT NULL,
  dismissed_cycle INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, reminder_key)
);

-- Run this once in the D1 database's "Console" tab in the Cloudflare dashboard.

CREATE TABLE IF NOT EXISTS rows (
  id                    TEXT PRIMARY KEY,
  no                    INTEGER NOT NULL,
  address               TEXT NOT NULL,
  wbs                   TEXT NOT NULL,
  stage                 TEXT NOT NULL,
  start_date            TEXT NOT NULL,
  state                 TEXT,              -- NULL | 'START' | 'HOLD'
  state_changed_at      INTEGER NOT NULL,  -- epoch ms
  held_accumulated_sec  REAL NOT NULL DEFAULT 0,
  comment               TEXT NOT NULL DEFAULT '',
  history               TEXT NOT NULL DEFAULT '[]',  -- JSON array
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rows_no ON rows(no);

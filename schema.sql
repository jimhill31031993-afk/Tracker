-- Full schema — only needed for a brand-new database.
-- If you already have data, use schema_update.sql instead.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rows (
  id                    TEXT PRIMARY KEY,
  user_id               TEXT NOT NULL,
  no                    INTEGER NOT NULL,
  address               TEXT NOT NULL,
  wbs                   TEXT NOT NULL,
  stage                 TEXT NOT NULL,
  start_date            TEXT NOT NULL,
  state                 TEXT,
  state_changed_at      INTEGER NOT NULL,
  held_accumulated_sec  REAL NOT NULL DEFAULT 0,
  comment               TEXT NOT NULL DEFAULT '',
  history               TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'ACTIVE',   -- 'ACTIVE' | 'COMPLETED'
  project_value         REAL,
  closed_at             INTEGER,
  on_time               INTEGER,                          -- 1 | 0, set when closed
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rows_user ON rows(user_id);
CREATE INDEX IF NOT EXISTS idx_rows_status ON rows(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

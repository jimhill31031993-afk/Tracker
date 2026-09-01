-- Run this in your D1 database's Console tab (site_control_db).
-- Safe to run once. If a line errors with "duplicate column" or
-- "table already exists", that specific line already ran before —
-- just remove that line and re-run the rest.

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

ALTER TABLE rows ADD COLUMN user_id TEXT;
ALTER TABLE rows ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE rows ADD COLUMN project_value REAL;
ALTER TABLE rows ADD COLUMN closed_at INTEGER;
ALTER TABLE rows ADD COLUMN on_time INTEGER;

CREATE INDEX IF NOT EXISTS idx_rows_user ON rows(user_id);
CREATE INDEX IF NOT EXISTS idx_rows_status ON rows(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Optional cleanup: any rows created before this migration have no
-- owner and will never show up for anyone. Safe to delete them:
-- DELETE FROM rows WHERE user_id IS NULL;

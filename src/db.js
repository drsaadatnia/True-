import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  role          TEXT NOT NULL CHECK (role IN ('coach', 'client')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  coach_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  goal          TEXT NOT NULL DEFAULT '',
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exercises (
  id           INTEGER PRIMARY KEY,
  coach_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT '',
  video_url    TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS workouts (
  id             INTEGER PRIMARY KEY,
  coach_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  title          TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'completed', 'missed')),
  client_comment TEXT NOT NULL DEFAULT '',
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS workouts_client_date ON workouts(client_id, date);

CREATE TABLE IF NOT EXISTS workout_items (
  id          INTEGER PRIMARY KEY,
  workout_id  INTEGER NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  exercise_id INTEGER REFERENCES exercises(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  sets        TEXT NOT NULL DEFAULT '',
  reps        TEXT NOT NULL DEFAULT '',
  load        TEXT NOT NULL DEFAULT '',
  rest        TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS templates (
  id         INTEGER PRIMARY KEY,
  coach_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  client_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metrics (
  id        INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  weight    REAL,
  body_fat  REAL,
  notes     TEXT NOT NULL DEFAULT ''
);
`;

export function openDb(path = process.env.DB_PATH || 'data/truecoach.db') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. */
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Turso / libSQL schema. Every statement is idempotent; run on the first request of each function instance
// (lib/db.js) and by scripts/migrate.mjs from the box.
const SCHEMA_VERSION = 2;   // 2: entries.paid is the source of truth for web entries (+ paid_at), see COLUMNS
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
     id             INTEGER PRIMARY KEY AUTOINCREMENT,
     week           INTEGER NOT NULL,
     name           TEXT    NOT NULL,
     name_key       TEXT    NOT NULL,              -- lowercased, spaces collapsed: unique per week
     tag            TEXT    NOT NULL,
     picks          TEXT    NOT NULL DEFAULT '{}', -- JSON {"TB @ DAL": "Dallas", ...}
     tiebreaker     INTEGER,
     edit_code_hash TEXT    NOT NULL,              -- sha256, the code itself is never stored
     paid           INTEGER NOT NULL DEFAULT 0,    -- 1 = paid. Source of truth for web entries (admin portal /admin)
     paid_at        TEXT,                          -- ISO UTC, set when paid is toggled on, NULL when off (or seeded)
     source         TEXT    NOT NULL DEFAULT 'web',
     notes          TEXT    NOT NULL DEFAULT '',
     version        INTEGER NOT NULL DEFAULT 1,    -- bumped on every update (compare-and-swap)
     created_at     TEXT    NOT NULL,              -- ISO UTC
     updated_at     TEXT    NOT NULL,
     UNIQUE (week, name_key)
   )`,
  `CREATE INDEX IF NOT EXISTS entries_week ON entries (week, created_at)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     bucket     TEXT PRIMARY KEY,                  -- e.g. ip:<hash>:<window>, bad:<week>:<name_key>:<hour>
     count      INTEGER NOT NULL,
     expires_at INTEGER NOT NULL                   -- epoch ms
   )`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `INSERT INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(meta.value AS INTEGER) < ${SCHEMA_VERSION}`,
];
// Columns added after the first release: CREATE TABLE IF NOT EXISTS won't add them to an existing table, so lib/db.js
// migrate() adds each missing one with ALTER TABLE (SQLite has no ADD COLUMN IF NOT EXISTS).
const COLUMNS = [{table: 'entries', name: 'paid_at', ddl: 'ALTER TABLE entries ADD COLUMN paid_at TEXT'}];
module.exports = {SCHEMA, SCHEMA_VERSION, COLUMNS};

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { DB_FILE, DATA_DIR } from '../config.js';
import { broadcast } from '../monitor/hub.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA busy_timeout = 5000;`);

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  instruction  TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',   -- queued|running|paused|completed|failed|cancelled
  pid          INTEGER,
  workspace    TEXT,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  result       TEXT,
  exit_code    INTEGER,
  log_file     TEXT
);
CREATE TABLE IF NOT EXISTS logs (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  ts       TEXT NOT NULL,
  level    TEXT NOT NULL DEFAULT 'info',
  source   TEXT NOT NULL DEFAULT 'system',
  message  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS system_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  cpu           REAL,
  gpu_util      REAL,
  gpu_mem_used  INTEGER,
  gpu_mem_total INTEGER,
  gpu_temp      REAL,
  cpu_temp      REAL,
  mem_used      INTEGER,
  mem_total     INTEGER,
  disk_free     INTEGER,
  disk_total    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_stats_ts ON system_stats(ts);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---- migration: add model/provider columns to tasks ----
for (const col of ['model', 'provider']) {
  try { db.exec('ALTER TABLE tasks ADD COLUMN ' + col + ' TEXT'); } catch { /* already exists */ }
}

// ---- migration: add temperature columns to system_stats ----
for (const col of ['gpu_temp', 'cpu_temp']) {
  try { db.exec('ALTER TABLE system_stats ADD COLUMN ' + col + ' REAL'); } catch { /* already exists */ }
}

// ---- helpers ----
export function nowIso() {
  return new Date().toISOString();
}

export function addLog(level, source, message) {
  const ts = nowIso();
  const text = String(message);
  const stmt = db.prepare('INSERT INTO logs (ts, level, source, message) VALUES (?, ?, ?, ?)');
  const info = stmt.run(ts, level, source, text.slice(0, 4000));
  const id = Number(info.lastInsertRowid);
  try {
    broadcast('log', { id, ts, level, source, message: text.slice(0, 4000) });
  } catch { /* hub not ready */ }
  return id;
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function nextTaskId() {
  // DSH-001, DSH-002, ...
  const row = db.prepare('SELECT id FROM tasks ORDER BY created_at DESC, id DESC LIMIT 1').get();
  if (!row) return 'DSH-001';
  const m = /^DSH-(\d+)$/.exec(row.id);
  if (!m) return 'DSH-001';
  return 'DSH-' + String(Number(m[1]) + 1).padStart(3, '0');
}
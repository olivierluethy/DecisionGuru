import Database from 'better-sqlite3';
import { DB_PATH } from '../config.js';
import { SCHEMA } from './schema.js';
import { DEFAULT_SETTINGS } from '@decisionguru/shared';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA);

// Lightweight migrations for DBs created before a column existed.
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('transactions', 'category', "category TEXT DEFAULT 'trade'");
ensureColumn('instruments', 'resolutionSource', 'resolutionSource TEXT');
ensureColumn('instruments', 'unresolved', 'unresolved INTEGER DEFAULT 0');

// Seed settings row if absent.
const settingsRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as
  | { value: string }
  | undefined;
if (!settingsRow) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'app',
    JSON.stringify(DEFAULT_SETTINGS),
  );
}

export function getSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('app') as
    | { value: string }
    | undefined;
  if (!row) return DEFAULT_SETTINGS;
  try {
    // Merge with defaults so newly added keys get sensible values.
    const stored = JSON.parse(row.value);
    return {
      ...DEFAULT_SETTINGS,
      ...stored,
      tax: { ...DEFAULT_SETTINGS.tax, ...(stored.tax ?? {}) },
      benchmarks: stored.benchmarks ?? DEFAULT_SETTINGS.benchmarks,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(value: unknown) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('app', JSON.stringify(value));
}

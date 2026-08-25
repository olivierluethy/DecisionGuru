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

// Migration: the stable instrument key is the ISIN, not the Yahoo symbol. A corporate-action
// chain (e.g. an ISIN change) legitimately maps several ISINs to one ticker, which the old
// UNIQUE(symbol) constraint forbade. Rebuild the table keyed on ISIN when the old constraint
// is still present.
function symbolIsUnique(): boolean {
  const idxs = db.prepare('PRAGMA index_list(instruments)').all() as Array<{ name: string; unique: number; origin: string }>;
  for (const ix of idxs) {
    if (ix.origin !== 'u' || !ix.unique) continue;
    const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(ix.name)})`).all() as Array<{ name: string }>;
    if (cols.length === 1 && cols[0].name === 'symbol') return true;
  }
  return false;
}

if (symbolIsUnique()) {
  db.pragma('foreign_keys = OFF');
  const rebuild = db.transaction(() => {
    db.exec(`
      CREATE TABLE instruments_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        isin TEXT,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'stock',
        currency TEXT NOT NULL DEFAULT 'USD',
        domicile TEXT,
        exchange TEXT,
        country TEXT,
        sector TEXT,
        incomeYieldOverride REAL,
        allocationOverride TEXT,
        resolutionSource TEXT,
        unresolved INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO instruments_new
        (id, symbol, isin, name, kind, currency, domicile, exchange, country, sector,
         incomeYieldOverride, allocationOverride, resolutionSource, unresolved, createdAt)
      SELECT id, symbol, isin, name, kind, currency, domicile, exchange, country, sector,
         incomeYieldOverride, allocationOverride, resolutionSource, unresolved, createdAt
      FROM instruments;
      DROP TABLE instruments;
      ALTER TABLE instruments_new RENAME TO instruments;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_instruments_isin ON instruments(isin) WHERE isin IS NOT NULL;
    `);
  });
  rebuild();
  db.pragma('foreign_keys = ON');
  console.log('[db] migrated instruments to ISIN-keyed (dropped UNIQUE(symbol))');
}

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

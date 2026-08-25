export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS instruments (
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
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(symbol)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrumentId INTEGER NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  date TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unitPrice REAL NOT NULL DEFAULT 0,
  fees REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  grossAmount REAL,
  netAmount REAL,
  withholding REAL,
  category TEXT DEFAULT 'trade',
  note TEXT,
  source TEXT,
  dedupeKey TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_instrument ON transactions(instrumentId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_dedupe ON transactions(dedupeKey) WHERE dedupeKey IS NOT NULL;

CREATE TABLE IF NOT EXISTS price_cache (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS quote_cache (
  symbol TEXT PRIMARY KEY,
  price REAL NOT NULL,
  currency TEXT,
  name TEXT,
  fetchedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dividend_cache (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS fund_cache (
  symbol TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetchedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_cache (
  base TEXT NOT NULL,
  quote TEXT NOT NULL,
  date TEXT NOT NULL,
  rate REAL NOT NULL,
  PRIMARY KEY (base, quote, date)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  targetId INTEGER,
  body TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS import_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  mapping TEXT NOT NULL,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Permanent ISIN -> Yahoo symbol resolution cache. Populated by the curated seed or a
-- (rate-limited) Yahoo search; a resolved ISIN is never looked up again.
CREATE TABLE IF NOT EXISTS symbol_map (
  isin TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  currency TEXT,
  kind TEXT,
  country TEXT,
  name TEXT,
  exchange TEXT,
  source TEXT,           -- 'curated' | 'yahoo' | 'manual'
  resolvedAt INTEGER NOT NULL
);
`;

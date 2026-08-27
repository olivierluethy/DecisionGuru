"""SQLite layer — stdlib sqlite3, reusing the same DB file & schema as the Node backend.

better-sqlite3 was synchronous and single-threaded; we mirror that with one shared
connection (check_same_thread=False) guarded by a re-entrant lock. All DB work is called
from the threadpool, so the lock simply serialises access the way better-sqlite3 did.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any

from .config import settings
from .logging import get_logger
from ..reference.defaults import DEFAULT_SETTINGS

log = get_logger("db")

SCHEMA = """
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
  resolutionSource TEXT,
  unresolved INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_instruments_isin ON instruments(isin) WHERE isin IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS fundamentals_cache (
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

CREATE TABLE IF NOT EXISTS symbol_map (
  isin TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  currency TEXT,
  kind TEXT,
  country TEXT,
  name TEXT,
  exchange TEXT,
  source TEXT,
  resolvedAt INTEGER NOT NULL
);

-- DEGIRO Account statement (Kontoauszug) events: cash movements, dividends,
-- taxes, fees, deposits, FX conversions. Separate from `transactions` (positions).
-- instrumentId has NO foreign-key constraint so an account import never fails when
-- the matching position hasn't been imported yet; it is backfilled on ISIN later.
CREATE TABLE IF NOT EXISTS account_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT,
  valueDate TEXT,
  name TEXT,
  isin TEXT,
  description TEXT,
  type TEXT NOT NULL,
  fx REAL,
  currency TEXT,
  amount REAL NOT NULL DEFAULT 0,
  balanceCurrency TEXT,
  balance REAL,
  orderId TEXT,
  instrumentId INTEGER,
  reversed INTEGER NOT NULL DEFAULT 0,
  source TEXT,
  dedupeKey TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_dedupe ON account_events(dedupeKey) WHERE dedupeKey IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_account_isin ON account_events(isin);

-- Per-ticker news headlines (Yahoo Finance RSS), cached & de-duplicated. `id` is a
-- stable hash of the article link so re-fetching upserts instead of duplicating.
CREATE TABLE IF NOT EXISTS news_cache (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT,
  link TEXT,
  publishedAt TEXT,
  summary TEXT,
  fetchedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_news_symbol ON news_cache(symbol, publishedAt);

-- Persisted investment decision plans: a named set of holdings to sell, the reinvest
-- targets (symbol + intended CHF), the intended outcome, and a baseline snapshot taken
-- at creation so the plan can later be compared against the actual result.
CREATE TABLE IF NOT EXISTS decision_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  baseline TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  name TEXT,
  kind TEXT NOT NULL DEFAULT 'stock',
  addedAt TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

_lock = threading.RLock()
_conn: sqlite3.Connection


def _ensure_column(conn: sqlite3.Connection, table: str, column: str, ddl: str) -> None:
    cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in cols:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


def init_db() -> sqlite3.Connection:
    global _conn
    conn = sqlite3.connect(settings.db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    # Lightweight migrations for DBs created before a column existed.
    _ensure_column(conn, "transactions", "category", "category TEXT DEFAULT 'trade'")
    _ensure_column(conn, "instruments", "resolutionSource", "resolutionSource TEXT")
    _ensure_column(conn, "instruments", "unresolved", "unresolved INTEGER DEFAULT 0")
    conn.commit()
    # Seed settings row if absent.
    row = conn.execute("SELECT value FROM settings WHERE key = ?", ("app",)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)",
            ("app", json.dumps(DEFAULT_SETTINGS)),
        )
        conn.commit()
    _conn = conn
    log.info("DB ready at %s", settings.db_path)
    return conn


def conn() -> sqlite3.Connection:
    return _conn


class _Cursor:
    """Thin better-sqlite3-like wrapper: .all()/.get()/.run() under the shared lock."""

    def __init__(self, sql: str):
        self.sql = sql

    def all(self, params: Any = ()) -> list[sqlite3.Row]:
        with _lock:
            return _conn.execute(self.sql, params).fetchall()

    def get(self, params: Any = ()) -> sqlite3.Row | None:
        with _lock:
            return _conn.execute(self.sql, params).fetchone()

    def run(self, params: Any = ()) -> sqlite3.Cursor:
        with _lock:
            cur = _conn.execute(self.sql, params)
            _conn.commit()
            return cur


def q(sql: str) -> _Cursor:
    return _Cursor(sql)


def execute(sql: str, params: Any = ()) -> sqlite3.Cursor:
    with _lock:
        cur = _conn.execute(sql, params)
        _conn.commit()
        return cur


def transaction(fn) -> Any:
    """Run fn(conn) inside a single committed transaction under the lock."""
    with _lock:
        try:
            result = fn(_conn)
            _conn.commit()
            return result
        except Exception:
            _conn.rollback()
            raise


# ---- settings helpers (mirror Node getSettings/saveSettings) ----------------

def get_settings() -> dict:
    row = q("SELECT value FROM settings WHERE key = ?").get(("app",))
    if not row:
        return json.loads(json.dumps(DEFAULT_SETTINGS))
    try:
        stored = json.loads(row["value"])
        return {
            **DEFAULT_SETTINGS,
            **stored,
            "tax": {**DEFAULT_SETTINGS["tax"], **(stored.get("tax") or {})},
            "benchmarks": stored.get("benchmarks") or DEFAULT_SETTINGS["benchmarks"],
        }
    except Exception:
        return json.loads(json.dumps(DEFAULT_SETTINGS))


def save_settings(value: Any) -> None:
    execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        ("app", json.dumps(value)),
    )

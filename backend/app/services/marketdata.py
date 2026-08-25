"""Market-data service: persistent SQLite caches in front of the MarketDataProvider.

Mirrors the retired Node marketdata service, including the per-symbol history cooldown
so one analysis (sampling many dates) never fans a single backfill into dozens of calls.
"""
from __future__ import annotations

import json
import threading
import time

import pandas as pd

from ..core import db
from ..core.config import settings
from ..core.logging import get_logger
from ..core.timefmt import iso_from_ms, iso_now
from ..providers.yfinance_provider import provider

log = get_logger("marketdata")

HISTORY_COOLDOWN_MS = settings.history_cooldown_ms
_last_history_attempt: dict[str, float] = {}
_history_lock = threading.Lock()


def _now_ms() -> int:
    return int(time.time() * 1000)


# ---- price history ----------------------------------------------------------

def _fetch_chart(symbol: str, from_date: str) -> None:
    result = provider.chart(symbol, from_date)

    def _tx(conn):
        for r in result.prices:
            conn.execute(
                "INSERT OR REPLACE INTO price_cache (symbol, date, close) VALUES (?, ?, ?)",
                (symbol, r["date"], r["close"]),
            )
        for d in result.dividends:
            conn.execute(
                "INSERT OR REPLACE INTO dividend_cache (symbol, date, amount) VALUES (?, ?, ?)",
                (symbol, d["date"], d["amount"]),
            )

    db.transaction(_tx)


def ensure_history(symbol: str, from_date: str) -> None:
    cov = db.q(
        "SELECT MIN(date) AS mn, MAX(date) AS mx, COUNT(*) AS c FROM price_cache WHERE symbol = ?"
    ).get((symbol,))
    today = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    c = cov["c"] if cov else 0
    mn = cov["mn"] if cov else None
    mx = cov["mx"] if cov else None
    needs_backfill = (not c) or (not mn) or (pd.Timestamp(from_date) < pd.Timestamp(mn))
    is_stale = (not mx) or (pd.Timestamp(mx) < (pd.Timestamp(today) - pd.Timedelta(days=3)))
    if not needs_backfill and not is_stale:
        return

    with _history_lock:
        last = _last_history_attempt.get(symbol, 0)
        if _now_ms() - last < HISTORY_COOLDOWN_MS:
            return
        _last_history_attempt[symbol] = _now_ms()

    start = from_date if needs_backfill else (mx or from_date)
    try:
        _fetch_chart(symbol, start)
    except Exception as exc:  # noqa: BLE001
        log.warning("history fetch failed for %s: %s", symbol, exc)


def get_history(symbol: str, from_date: str, to: str | None = None) -> list[dict]:
    ensure_history(symbol, from_date)
    end = to or pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    rows = db.q(
        "SELECT date, close FROM price_cache WHERE symbol = ? AND date >= ? AND date <= ? ORDER BY date"
    ).all((symbol, from_date, end))
    return [{"date": r["date"], "close": r["close"]} for r in rows]


def price_on(symbol: str, date: str) -> float | None:
    ensure_history(symbol, date)
    row = db.q(
        "SELECT close FROM price_cache WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 1"
    ).get((symbol, date))
    if row:
        return row["close"]
    fallback = db.q(
        "SELECT close FROM price_cache WHERE symbol = ? ORDER BY date ASC LIMIT 1"
    ).get((symbol,))
    return fallback["close"] if fallback else None


def get_dividends(symbol: str, from_date: str) -> list[dict]:
    ensure_history(symbol, from_date)
    rows = db.q(
        "SELECT date, amount AS close FROM dividend_cache WHERE symbol = ? AND date >= ? ORDER BY date"
    ).all((symbol, from_date))
    return [{"date": r["date"], "close": r["close"]} for r in rows]


# ---- quote ------------------------------------------------------------------

def get_quote(symbol: str) -> dict:
    cached = db.q("SELECT * FROM quote_cache WHERE symbol = ?").get((symbol,))
    fresh = cached and (_now_ms() - cached["fetchedAt"] < settings.cache_ttl_quote * 1000)
    if cached and fresh:
        return {
            "symbol": symbol,
            "price": cached["price"],
            "currency": cached["currency"],
            "name": cached["name"],
            "time": iso_from_ms(cached["fetchedAt"]),
            "stale": False,
        }
    try:
        q = provider.quote(symbol)
        price = q.price if q else 0.0
        currency = (q.currency if q else "USD") or "USD"
        name = (q.name if q else symbol) or symbol
        if price and price > 0:
            db.execute(
                "INSERT OR REPLACE INTO quote_cache (symbol, price, currency, name, fetchedAt) "
                "VALUES (?, ?, ?, ?, ?)",
                (symbol, price, currency, name, _now_ms()),
            )
            return {"symbol": symbol, "price": price, "currency": currency, "name": name,
                    "time": iso_now(), "stale": False}
        if cached:
            return {"symbol": symbol, "price": cached["price"], "currency": cached["currency"],
                    "name": cached["name"], "time": iso_from_ms(cached["fetchedAt"]), "stale": True}
        return {"symbol": symbol, "price": 0, "currency": currency, "name": name,
                "time": iso_now(), "stale": True}
    except Exception as exc:  # noqa: BLE001
        log.warning("quote failed for %s: %s", symbol, exc)
        if cached:
            return {"symbol": symbol, "price": cached["price"], "currency": cached["currency"],
                    "name": cached["name"], "time": iso_from_ms(cached["fetchedAt"]), "stale": True}
        return {"symbol": symbol, "price": 0, "currency": "USD", "name": symbol,
                "time": iso_now(), "stale": True}


# ---- fund / instrument profile ----------------------------------------------

def get_fund_summary(symbol: str) -> dict | None:
    cached = db.q("SELECT payload, fetchedAt FROM fund_cache WHERE symbol = ?").get((symbol,))
    if cached and (_now_ms() - cached["fetchedAt"] < settings.cache_ttl_fund * 1000):
        return json.loads(cached["payload"])
    try:
        summary = provider.fund_summary(symbol)
        if summary is not None:
            db.execute(
                "INSERT OR REPLACE INTO fund_cache (symbol, payload, fetchedAt) VALUES (?, ?, ?)",
                (symbol, json.dumps(summary), _now_ms()),
            )
        return summary
    except Exception as exc:  # noqa: BLE001
        log.warning("quoteSummary failed for %s: %s", symbol, exc)
        if cached:
            return json.loads(cached["payload"])
        return None


# ---- search -----------------------------------------------------------------

def search_symbol(query: str) -> list[dict]:
    if not query or not query.strip():
        return []
    hits = provider.search(query)
    return [
        {"symbol": h.symbol, "name": h.name, "exchange": h.exchange, "kind": h.kind, "type": h.type}
        for h in hits
    ]

"""Market-data service: persistent SQLite caches in front of the MarketDataProvider.

Mirrors the retired Node marketdata service, including the per-symbol history cooldown
so one analysis (sampling many dates) never fans a single backfill into dozens of calls.
"""
from __future__ import annotations

import json
import threading
import time

import pandas as pd

from . import refresh
from ..core import db
from ..core.config import settings
from ..core.logging import get_logger
from ..core.timefmt import iso_from_ms
from ..providers.base import normalize_minor_currency
from ..providers.yfinance_provider import provider

log = get_logger("marketdata")

HISTORY_COOLDOWN_MS = settings.history_cooldown_ms
_last_history_attempt: dict[str, float] = {}
_history_lock = threading.Lock()

QUOTE_COOLDOWN_MS = settings.quote_cooldown_ms
_last_quote_attempt: dict[str, float] = {}
_quote_lock = threading.Lock()


def _quote_cooldown_ok(symbol: str) -> bool:
    """True if enough time has passed to attempt another quote fetch for `symbol`.

    Prevents a symbol that never returns a price (delisted / illiquid) from
    re-enqueuing a Yahoo call on every portfolio poll."""
    with _quote_lock:
        last = _last_quote_attempt.get(symbol, 0.0)
        if _now_ms() - last < QUOTE_COOLDOWN_MS:
            return False
        _last_quote_attempt[symbol] = _now_ms()
        return True


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
    # Never block the request path: backfill runs in the background pool. Whatever
    # is already cached is served now; the fresh rows land on a later poll.
    refresh.enqueue_history(symbol, lambda: _fetch_chart(symbol, start))


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

def _refresh_quote(symbol: str) -> None:
    """Fetch a fresh quote and write the cache. Runs in the background pool."""
    q = provider.quote(symbol)
    price = q.price if q else 0.0
    if price and price > 0:
        currency = (q.currency if q else "USD") or "USD"
        name = (q.name if q else symbol) or symbol
        db.execute(
            "INSERT OR REPLACE INTO quote_cache (symbol, price, currency, name, fetchedAt) "
            "VALUES (?, ?, ?, ?, ?)",
            (symbol, price, currency, name, _now_ms()),
        )


def get_quote(symbol: str) -> dict:
    """Stale-while-revalidate: never blocks on Yahoo.

    Fresh cache → served as-is. Stale cache → served immediately + background
    refresh. No cache row → a ``pending`` sentinel + background refresh; the real
    price lands on a later poll.
    """
    cached = db.q("SELECT * FROM quote_cache WHERE symbol = ?").get((symbol,))
    fresh = cached and (_now_ms() - cached["fetchedAt"] < settings.cache_ttl_quote * 1000)
    if cached and fresh:
        # Defensive minor-unit normalisation (e.g. a legacy GBp row) — idempotent.
        price, currency = normalize_minor_currency(cached["price"], cached["currency"])
        return {
            "symbol": symbol,
            "price": price,
            "currency": currency,
            "name": cached["name"],
            "time": iso_from_ms(cached["fetchedAt"]),
            "stale": False,
            "pending": False,
        }

    # Only enqueue a background refresh past the per-symbol cooldown, so a
    # never-priced symbol doesn't spin the pool on every poll.
    if _quote_cooldown_ok(symbol):
        refresh.enqueue_quote(symbol, lambda: _refresh_quote(symbol))

    if cached:
        price, currency = normalize_minor_currency(cached["price"], cached["currency"])
        return {"symbol": symbol, "price": price, "currency": currency,
                "name": cached["name"], "time": iso_from_ms(cached["fetchedAt"]),
                "stale": True, "pending": False}
    return {"symbol": symbol, "price": 0, "currency": "USD", "name": symbol,
            "time": None, "stale": True, "pending": True}


def listing_currency(symbol: str, fallback: str | None = None) -> str | None:
    """The symbol's quote (listing) currency, normalised to its major unit.

    Used by the value-series builder to apply the correct FX to cached closes,
    which the price_cache stores without a currency of their own."""
    row = db.q("SELECT currency FROM quote_cache WHERE symbol = ?").get((symbol,))
    if row and row["currency"]:
        _, major = normalize_minor_currency(1.0, row["currency"])
        return major or row["currency"]
    return fallback


def repair_minor_units() -> int:
    """One-time repair of legacy minor-unit (GBp) rows written before normalisation.

    Divides quote_cache prices and the affected symbols' price_cache/dividend_cache
    closes by 100 and rewrites the currency to the major unit. Idempotent — after a
    row is fixed its currency is GBP and it is skipped. Returns rows touched."""
    touched = 0
    minor_rows = db.q(
        "SELECT symbol, price, currency FROM quote_cache "
        "WHERE currency IN ('GBp', 'GBX', 'ZAc', 'ILA')"
    ).all()
    for r in minor_rows:
        symbol = r["symbol"]
        new_price, new_ccy = normalize_minor_currency(r["price"], r["currency"])
        # factor = raw / normalised (e.g. 9120 / 91.20 = 100)
        factor = (r["price"] / new_price) if new_price else 100.0
        db.execute(
            "UPDATE quote_cache SET price = ?, currency = ? WHERE symbol = ?",
            (new_price, new_ccy, symbol),
        )
        db.execute("UPDATE price_cache SET close = close / ? WHERE symbol = ?", (factor, symbol))
        db.execute("UPDATE dividend_cache SET amount = amount / ? WHERE symbol = ?", (factor, symbol))
        touched += 1
    if touched:
        log.info("repair_minor_units: normalised %d symbol(s) from minor units", touched)
    return touched


def repair_misresolved_instruments() -> int:
    """Reconcile persisted resolution against the curated ISIN seed.

    The curated map (``reference/isin_map.py``) is authoritative for the ISINs it
    lists. But the resolved symbol is also persisted in ``symbol_map`` and
    ``instruments``, and the historical caches are keyed by that symbol — so
    correcting the seed alone leaves the wrong series in place. This walks every
    curated ISIN and, wherever a *non-manual* persisted row still points at a
    different symbol, rewrites it to the curated one and purges the orphaned
    symbol's cache rows so the corrected symbol backfills clean on next poll.

    Idempotent: once every row agrees with the seed there is nothing to do.
    Manual overrides (``source``/``resolutionSource`` == 'manual') are never
    touched. Returns the number of ISINs repaired."""
    from ..reference.isin_map import CURATED_ISIN_MAP

    repaired = 0
    replaced_symbols: set[str] = set()
    for isin, seed in CURATED_ISIN_MAP.items():
        want = seed["symbol"]
        changed = False

        sm = db.q("SELECT symbol, source FROM symbol_map WHERE isin = ?").get((isin,))
        if sm and sm["symbol"] != want and (sm["source"] or "") != "manual":
            replaced_symbols.add(sm["symbol"])
            db.execute(
                "UPDATE symbol_map SET symbol = ?, currency = ?, kind = ? WHERE isin = ?",
                (want, seed["currency"], seed["kind"], isin),
            )
            changed = True

        insts = db.q(
            "SELECT id, symbol, resolutionSource FROM instruments WHERE isin = ?"
        ).all((isin,))
        for inst in insts:
            if inst["symbol"] != want and (inst["resolutionSource"] or "") != "manual":
                replaced_symbols.add(inst["symbol"])
                db.execute(
                    "UPDATE instruments SET symbol = ?, currency = ?, kind = ? WHERE id = ?",
                    (want, seed["currency"], seed["kind"], inst["id"]),
                )
                changed = True

        if changed:
            repaired += 1

    # Purge cache rows for symbols that were replaced and are no longer referenced
    # by any instrument or symbol_map row (leaves shared/still-used symbols intact).
    for old in replaced_symbols:
        still_used = (
            db.q("SELECT 1 FROM instruments WHERE symbol = ? LIMIT 1").get((old,))
            or db.q("SELECT 1 FROM symbol_map WHERE symbol = ? LIMIT 1").get((old,))
        )
        if still_used:
            continue
        for tbl in ("price_cache", "dividend_cache", "quote_cache", "fund_cache"):
            db.execute(f"DELETE FROM {tbl} WHERE symbol = ?", (old,))

    if repaired:
        log.info(
            "repair_misresolved_instruments: corrected %d ISIN(s); purged cache for %s",
            repaired, sorted(replaced_symbols) or "none",
        )
    return repaired


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

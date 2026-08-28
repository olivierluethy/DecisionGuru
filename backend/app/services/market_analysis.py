"""Market analysis — how a company performs vs its sector, the broad market and its
competitors, plus a market-vs-company-weakness read. All price reads are CACHED-ONLY
(direct price_cache SELECTs) so a competitor loop never hits the rate-limited provider;
returns are price-return % (currency-neutral) for one consistent cross-security method.
"""
from __future__ import annotations

import statistics

import pandas as pd

from ..core import db

# (key, months) — the horizons the UI offers.
WINDOWS: list[tuple[str, int]] = [
    ("1M", 1), ("3M", 3), ("6M", 6), ("1Y", 12), ("3Y", 36), ("5Y", 60),
]
_MONTHS = dict(WINDOWS)


def cached_closes(symbol: str, from_date: str) -> list[dict]:
    """Positive daily closes from the cache only (ascending). Never fetches."""
    rows = db.q(
        "SELECT date, close FROM price_cache WHERE symbol = ? AND date >= ? AND close > 0 "
        "ORDER BY date"
    ).all((symbol, from_date))
    return [{"date": r["date"], "close": float(r["close"])} for r in rows]


def _close_on_or_before(rows: list[dict], target: str) -> dict | None:
    best = None
    for r in rows:
        if r["date"] <= target:
            best = r
        else:
            break
    return best


def _five_years_ago() -> str:
    return (pd.Timestamp.utcnow().normalize() - pd.DateOffset(years=5)).strftime("%Y-%m-%d")


def returns_for(symbol: str) -> dict[str, float | None]:
    """Price-return fraction per WINDOWS key from cached closes; None where history is short."""
    rows = cached_closes(symbol, _five_years_ago())
    out: dict[str, float | None] = {key: None for key, _ in WINDOWS}
    if len(rows) < 2:
        return out
    last = rows[-1]
    today = pd.Timestamp(last["date"])
    for key, months in WINDOWS:
        target = (today - pd.DateOffset(months=months)).strftime("%Y-%m-%d")
        if target < rows[0]["date"]:
            continue  # not enough cached history for this window
        start = _close_on_or_before(rows, target)
        if start and start["close"] > 0:
            out[key] = round(last["close"] / start["close"] - 1, 6)
    return out


def single_return(symbol: str, months: int) -> float | None:
    """Price return over a single trailing window (months), cached-only. None if short."""
    rows = cached_closes(symbol, _five_years_ago())
    if len(rows) < 2:
        return None
    last = rows[-1]
    target = (pd.Timestamp(last["date"]) - pd.DateOffset(months=months)).strftime("%Y-%m-%d")
    if target < rows[0]["date"]:
        return None
    start = _close_on_or_before(rows, target)
    if not start or start["close"] <= 0:
        return None
    return round(last["close"] / start["close"] - 1, 6)


def rebased_series(symbol: str, months: int) -> list[dict]:
    """Closes over the trailing window rebased to 100 at the first point. [] when <2 points."""
    start_date = (pd.Timestamp.utcnow().normalize() - pd.DateOffset(months=months)).strftime("%Y-%m-%d")
    rows = cached_closes(symbol, start_date)
    if len(rows) < 2:
        return []
    base = rows[0]["close"]
    if base <= 0:
        return []
    return [{"date": r["date"], "value": round(r["close"] / base * 100.0, 4)} for r in rows]


def peer_median(returns_by_symbol: dict[str, dict], key: str) -> float | None:
    """Median of the peers' `key`-window returns, ignoring missing (None) values."""
    vals = [r.get(key) for r in returns_by_symbol.values() if r.get(key) is not None]
    return round(statistics.median(vals), 6) if vals else None


# How far apart (in return fraction) the subject and its reference must be before the gap
# is called out rather than treated as in line with the market.
_MATERIAL = 0.05


def classify(subject: float | None, sector: float | None, peer_med: float | None,
             benchmark: float | None) -> str | None:
    """Descriptive market-vs-company read — never a recommendation, never forces a Sell.

    Compares the subject's return against a sector reference (the sector ETF return, else
    the peer median) over the same horizon. Distinguishes broad-market weakness (subject
    and the market both down together) from company-specific weakness (subject down while
    the market is up)."""
    ref = sector if sector is not None else peer_med
    if subject is None or ref is None:
        return None
    gap = subject - ref
    if ref < -0.03 and subject < -0.03 and abs(gap) <= _MATERIAL:
        return "market-wide-weakness"
    if gap < -_MATERIAL:
        return "company-specific-weakness"
    if gap > _MATERIAL:
        if peer_med is not None and (subject - peer_med) > _MATERIAL:
            return "outperforming-peers"
        return "outperforming-sector"
    return "inline"

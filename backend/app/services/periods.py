"""Multi-horizon price performance — 1Y / 2Y / 3Y / 5Y and the full holding period,
side by side, from the cached daily closes only.

This is deliberately a *price* return (no dividends, no tax): the momentum lens the
strategy views place next to the total-return counterfactual, so a short-term spike
can be read against long-term performance instead of being mistaken for it. Never
blocks on a live fetch — it reads the same cached series the movement scanner uses.
"""
from __future__ import annotations

import pandas as pd

from .marketdata import get_history

WINDOWS = [("1Y", 1), ("2Y", 2), ("3Y", 3), ("5Y", 5)]


def _close_on_or_before(rows: list[dict], target: str) -> dict | None:
    best = None
    for r in rows:
        if r["date"] <= target:
            best = r
        else:
            break
    return best


def _entry(key: str, label: str, years: float, start: dict, last: dict) -> dict:
    pct = last["close"] / start["close"] - 1
    cagr = (last["close"] / start["close"]) ** (1 / years) - 1 if years >= 0.1 else None
    return {
        "key": key,
        "label": label,
        "years": round(years, 2),
        "fromDate": start["date"],
        "toDate": last["date"],
        "startClose": round(float(start["close"]), 4),
        "endClose": round(float(last["close"]), 4),
        "changePct": round(float(pct), 6),
        "cagr": round(float(cagr), 6) if cagr is not None else None,
    }


def period_returns(symbol: str, entry_date: str | None = None) -> dict:
    """Price return over each trailing window plus (when given) the full holding period."""
    today = pd.Timestamp.utcnow().normalize()
    today_s = today.strftime("%Y-%m-%d")
    back5 = (today - pd.DateOffset(years=5)).strftime("%Y-%m-%d")
    from_date = min(entry_date, back5) if entry_date else back5

    rows = get_history(symbol, from_date, today_s)
    if len(rows) < 2:
        return {"symbol": symbol, "asOf": today_s, "periods": []}

    last = rows[-1]
    first_date = rows[0]["date"]
    periods: list[dict] = []

    for key, yrs in WINDOWS:
        target = (today - pd.DateOffset(years=yrs)).strftime("%Y-%m-%d")
        if target < first_date:  # not enough cached history to honour this window
            continue
        start = _close_on_or_before(rows, target)
        if not start or start["close"] <= 0:
            continue
        periods.append(_entry(key, f"{yrs}Y", float(yrs), start, last))

    if entry_date:
        start = _close_on_or_before(rows, entry_date)
        if start and start["close"] > 0:
            yrs = max((today - pd.Timestamp(entry_date)).days / 365.25, 0.01)
            periods.append(_entry("HOLDING", "Holding", yrs, start, last))

    return {"symbol": symbol, "asOf": last["date"], "periods": periods}

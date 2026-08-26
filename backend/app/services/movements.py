"""Price-movement detection — turns a raw close series into a small set of explainable
chart annotations: major up-legs (surges), major down-legs (drops) and long stagnation
stretches (near-zero growth). Deterministic and threshold-based so every marker is
defensible ("dropped 34% over 4 months"), never a black box.

Consumed by the market-data router to annotate the full-history price chart and by the
per-position and research views. Operates on the cached daily closes only — never blocks
on a live fetch.
"""
from __future__ import annotations

from datetime import date

import pandas as pd

from .marketdata import get_history

# A confirmed swing leg must move at least this fraction from the prior pivot.
SWING_THRESHOLD = 0.18
# A stagnation stretch must last at least this many days …
STAGNATION_MIN_DAYS = 365
# … while staying inside this peak-to-trough band (fraction of the window mean).
STAGNATION_BAND = 0.14


def _to_frame(points: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(points)
    if df.empty:
        return df
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    return df


def _zigzag_legs(df: pd.DataFrame, threshold: float) -> list[dict]:
    """Percentage zig-zag: collapse the series into monotonic legs, each confirmed only
    once price reverses `threshold` from the running extreme. Returns big legs only."""
    if len(df) < 2:
        return []
    closes = df["close"].to_numpy()
    dates = df["date"]

    legs: list[dict] = []

    def emit(a: int, b: int) -> None:
        if a == b:
            return
        start, end = closes[a], closes[b]
        if start <= 0:
            return
        pct = (end - start) / start
        if abs(pct) < threshold:
            return
        legs.append({
            "kind": "surge" if pct > 0 else "drop",
            "from": dates.iloc[a].strftime("%Y-%m-%d"),
            "to": dates.iloc[b].strftime("%Y-%m-%d"),
            "startClose": round(float(start), 4),
            "endClose": round(float(end), 4),
            "changePct": round(float(pct), 4),
            "days": int((dates.iloc[b] - dates.iloc[a]).days),
        })

    pivot_i = 0           # last confirmed pivot
    trend = 0             # +1 up, -1 down, 0 undecided
    high_i = low_i = 0    # running extremes since the last pivot

    for i in range(1, len(closes)):
        price = closes[i]
        if price > closes[high_i]:
            high_i = i
        if price < closes[low_i]:
            low_i = i

        if trend >= 0 and closes[high_i] > 0 and (price - closes[high_i]) / closes[high_i] <= -threshold:
            # down-reversal off the running high → confirm the up-leg to that high
            emit(pivot_i, high_i)
            pivot_i, trend = high_i, -1
            low_i = i
        elif trend <= 0 and closes[low_i] > 0 and (price - closes[low_i]) / closes[low_i] >= threshold:
            # up-reversal off the running low → confirm the down-leg to that low
            emit(pivot_i, low_i)
            pivot_i, trend = low_i, 1
            high_i = i

    # final open leg to whichever extreme extends the current trend
    emit(pivot_i, high_i if trend >= 0 else low_i)
    return legs


def _stagnation_windows(df: pd.DataFrame, min_days: int, band: float) -> list[dict]:
    """Maximal stretches where the price stayed inside a tight band for a long time —
    the 'dead money' periods the strategy assistant should surface."""
    if len(df) < 3:
        return []
    dates = df["date"].to_numpy()
    closes = df["close"].to_numpy()
    n = len(closes)
    windows: list[dict] = []
    i = 0
    while i < n - 1:
        j = i + 1
        lo = hi = closes[i]
        best_j = -1
        while j < n:
            lo = min(lo, closes[j])
            hi = max(hi, closes[j])
            mean = (hi + lo) / 2
            if mean <= 0:
                break
            if (hi - lo) / mean > band:
                break
            if (pd.Timestamp(dates[j]) - pd.Timestamp(dates[i])).days >= min_days:
                best_j = j
            j += 1
        if best_j > i:
            start, end = closes[i], closes[best_j]
            pct = (end - start) / start if start else 0.0
            windows.append({
                "kind": "stagnation",
                "from": pd.Timestamp(dates[i]).strftime("%Y-%m-%d"),
                "to": pd.Timestamp(dates[best_j]).strftime("%Y-%m-%d"),
                "changePct": round(float(pct), 4),
                "days": int((pd.Timestamp(dates[best_j]) - pd.Timestamp(dates[i])).days),
            })
            i = best_j  # jump past the stretch so windows don't overlap
        else:
            i += 1
    return windows


def detect_movements(points: list[dict], *, swing: float = SWING_THRESHOLD,
                     stagnation_days: int = STAGNATION_MIN_DAYS,
                     stagnation_band: float = STAGNATION_BAND) -> dict:
    """Detect major legs + stagnation stretches from a `[{date, close}]` series."""
    df = _to_frame(points)
    if df.empty:
        return {"legs": [], "stagnation": [], "coverage": None}
    legs = _zigzag_legs(df, swing)
    stag = _stagnation_windows(df, stagnation_days, stagnation_band)
    # Keep the annotation set legible: the biggest moves first, capped.
    legs.sort(key=lambda l: -abs(l["changePct"]))
    return {
        "legs": legs[:12],
        "stagnation": stag[:6],
        "coverage": {
            "from": df["date"].iloc[0].strftime("%Y-%m-%d"),
            "to": df["date"].iloc[-1].strftime("%Y-%m-%d"),
            "points": int(len(df)),
        },
    }


def movements_for_symbol(symbol: str, from_date: str | None = None) -> dict:
    """Full-history movement markers for one symbol, from cached closes."""
    start = from_date or "1990-01-01"
    history = get_history(symbol, start, date.today().strftime("%Y-%m-%d"))
    return detect_movements(history)

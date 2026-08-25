"""Money-weighted return + growth helpers — port of math.ts (Newton + bisection XIRR)."""
from __future__ import annotations

import math

import pandas as pd


def _days_between(a: str, b: str) -> int:
    return (pd.Timestamp(b).normalize() - pd.Timestamp(a).normalize()).days


def _pow(base: float, exp: float) -> float:
    """JS Math.pow semantics: a negative base with a non-integer exponent yields NaN
    (Python's ** would return a complex number, diverging from the ported algorithm)."""
    if base < 0 and exp != int(exp):
        return math.nan
    try:
        return base ** exp
    except (ValueError, OverflowError):
        return math.nan


def _clamp_rate(r: float) -> float | None:
    if not math.isfinite(r):
        return None
    if r < -0.9999 or r > 100:
        return None
    return r


def xirr(flows: list[dict], guess: float = 0.1) -> float | None:
    """flows: [{date: 'YYYY-MM-DD', amount: float}] (negative = outflow)."""
    valid = [f for f in flows if math.isfinite(f["amount"]) and f["amount"] != 0]
    if len(valid) < 2:
        return None
    if not any(f["amount"] > 0 for f in valid) or not any(f["amount"] < 0 for f in valid):
        return None

    t0 = valid[0]["date"]
    years = [_days_between(t0, f["date"]) / 365 for f in valid]
    amounts = [f["amount"] for f in valid]

    def npv(r: float) -> float:
        return sum(a / _pow(1 + r, y) for a, y in zip(amounts, years))

    def dnpv(r: float) -> float:
        return sum(-(y * a) / _pow(1 + r, y + 1) for a, y in zip(amounts, years))

    # Newton
    rate = guess
    for _ in range(100):
        f = npv(rate)
        d = dnpv(rate)
        if abs(d) < 1e-12:
            break
        nxt = rate - f / d
        if not math.isfinite(nxt):
            break
        if abs(nxt - rate) < 1e-8:
            return _clamp_rate(nxt)
        rate = nxt

    # Bisection fallback on [-0.9999, 10]
    lo, hi = -0.9999, 10.0
    flo = npv(lo)
    fhi = npv(hi)
    if flo * fhi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        fm = npv(mid)
        if abs(fm) < 1e-7:
            return _clamp_rate(mid)
        if flo * fm < 0:
            hi = mid
            fhi = fm
        else:
            lo = mid
            flo = fm
    return _clamp_rate((lo + hi) / 2)


def cagr(start_value: float, end_value: float, years: float) -> float | None:
    if start_value <= 0 or years <= 0 or end_value <= 0:
        return None
    return (end_value / start_value) ** (1 / years) - 1


def years_between(a: str, b: str) -> float:
    return max(_days_between(a, b) / 365, 0.0)

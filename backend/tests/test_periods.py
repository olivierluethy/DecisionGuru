"""Multi-horizon price-return periods, including the full holding period.

Regression cover for the tz bug: with an ``entry_date`` the service subtracts
``today`` from ``pd.Timestamp(entry_date)``. ``today`` used to come from the
tz-aware (and deprecated) ``pd.Timestamp.utcnow()``, so the subtraction raised
``TypeError: Cannot subtract tz-naive and tz-aware datetime-like objects``.
``get_history`` is stubbed so the tests stay hermetic (no DB, no network).
"""
from __future__ import annotations

import pandas as pd
import pytest

from app.services import periods as P


def test_holding_period_with_entry_date_does_not_crash_on_tz(monkeypatch):
    today = pd.Timestamp.now(tz="UTC").normalize().tz_localize(None)
    d_today = today.strftime("%Y-%m-%d")
    d_1y = (today - pd.DateOffset(years=1)).strftime("%Y-%m-%d")
    d_2y = (today - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
    d_3y = (today - pd.DateOffset(years=3)).strftime("%Y-%m-%d")
    rows = [
        {"date": d_3y, "close": 150.0},
        {"date": d_2y, "close": 200.0},
        {"date": d_1y, "close": 250.0},
        {"date": d_today, "close": 300.0},
    ]
    monkeypatch.setattr(P, "get_history", lambda *a, **k: rows)

    r = P.period_returns("TSTP", d_3y)  # entry = 3 years ago

    keys = {p["key"] for p in r["periods"]}
    assert "HOLDING" in keys
    holding = next(p for p in r["periods"] if p["key"] == "HOLDING")
    assert holding["years"] == pytest.approx(3.0, abs=0.02)
    assert holding["changePct"] == pytest.approx(300.0 / 150.0 - 1, abs=1e-6)
    # Trailing windows that the cached history can honour are present too.
    assert {"1Y", "2Y", "3Y"} <= keys


def test_no_entry_date_returns_windows_only(monkeypatch):
    today = pd.Timestamp.now(tz="UTC").normalize().tz_localize(None)
    d_today = today.strftime("%Y-%m-%d")
    d_2y = (today - pd.DateOffset(years=2)).strftime("%Y-%m-%d")
    rows = [{"date": d_2y, "close": 100.0}, {"date": d_today, "close": 120.0}]
    monkeypatch.setattr(P, "get_history", lambda *a, **k: rows)

    r = P.period_returns("TSTQ")

    keys = {p["key"] for p in r["periods"]}
    assert "HOLDING" not in keys
    assert {"1Y", "2Y"} <= keys

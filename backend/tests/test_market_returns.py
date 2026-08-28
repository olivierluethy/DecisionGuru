"""Cached-only price-return + rebased-series helpers for market analysis."""
from __future__ import annotations

import pandas as pd
import pytest

from app.core import db
from app.services import market_analysis as ma


def _seed(symbol: str, points: list[tuple[str, float]]) -> None:
    for d, c in points:
        db.execute(
            "INSERT OR REPLACE INTO price_cache (symbol, date, close) VALUES (?, ?, ?)",
            (symbol, d, c),
        )


@pytest.fixture(autouse=True)
def _clean():
    db.execute("DELETE FROM price_cache WHERE symbol LIKE 'TST%'")
    yield
    db.execute("DELETE FROM price_cache WHERE symbol LIKE 'TST%'")


def test_returns_for_computes_window_fractions():
    today = pd.Timestamp.utcnow().normalize()
    d_today = today.strftime("%Y-%m-%d")
    d_1m = (today - pd.DateOffset(months=1)).strftime("%Y-%m-%d")
    d_1y = (today - pd.DateOffset(months=12)).strftime("%Y-%m-%d")
    _seed("TSTA", [(d_1y, 100.0), (d_1m, 110.0), (d_today, 120.0)])
    r = ma.returns_for("TSTA")
    assert r["1Y"] == pytest.approx(0.20, abs=1e-6)   # 120/100 - 1
    assert r["1M"] == pytest.approx(120.0 / 110.0 - 1, abs=1e-6)
    assert r["5Y"] is None                             # no 5y-old close cached


def test_returns_for_insufficient_history_all_none():
    _seed("TSTB", [("2026-08-01", 50.0)])              # single point
    r = ma.returns_for("TSTB")
    assert all(v is None for v in r.values())


def test_rebased_series_starts_at_100():
    today = pd.Timestamp.utcnow().normalize()
    d0 = (today - pd.DateOffset(months=1)).strftime("%Y-%m-%d")
    d1 = today.strftime("%Y-%m-%d")
    _seed("TSTC", [(d0, 200.0), (d1, 220.0)])
    s = ma.rebased_series("TSTC", 3)
    assert len(s) == 2
    assert s[0]["value"] == pytest.approx(100.0, abs=1e-6)
    assert s[-1]["value"] == pytest.approx(110.0, abs=1e-6)  # 220/200 × 100


def test_single_return_matches_returns_for():
    today = pd.Timestamp.utcnow().normalize()
    d_6m = (today - pd.DateOffset(months=6)).strftime("%Y-%m-%d")
    d_now = today.strftime("%Y-%m-%d")
    _seed("TSTD", [(d_6m, 80.0), (d_now, 100.0)])
    assert ma.single_return("TSTD", 6) == pytest.approx(0.25, abs=1e-6)

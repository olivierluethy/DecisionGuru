"""Forecast / Prognose engine (issue #8, the Motivationshebel).

Covers the money math of the per-day opportunity cost, the tz-safe news-recency check, and
that build_forecast composes a coherent, chronologically ordered timeline + "today" list on
top of the (here stubbed) decision engine.
"""
from __future__ import annotations

import pandas as pd

from app.services import forecast as F


# --- per-day opportunity cost (the motivation lever) --------------------------------------

def test_daily_drag_flat_holding_is_benchmark_daily_return():
    # A flat holding vs a 7.3% p.a. benchmark on CHF 20'000: the whole benchmark drift is drag.
    drag = F._daily_drag_chf(20_000.0, 0.0, 0.073)
    assert drag is not None
    # 20000 * ((1.073)^(1/365.25) - 1) ≈ 3.86
    assert 3.5 < drag < 4.2


def test_daily_drag_larger_when_holding_loses():
    flat = F._daily_drag_chf(20_000.0, 0.0, 0.073)
    losing = F._daily_drag_chf(20_000.0, -0.10, 0.073)
    assert losing > flat


def test_daily_drag_zero_when_holding_beats_benchmark():
    assert F._daily_drag_chf(20_000.0, 0.20, 0.073) == 0.0


def test_daily_drag_none_when_benchmark_unknown_or_no_value():
    assert F._daily_drag_chf(20_000.0, 0.0, None) is None
    assert F._daily_drag_chf(0.0, 0.0, 0.073) is None


def test_daily_return_none_safe_and_signed():
    assert F._daily_return(None) is None
    assert F._daily_return(0.0) == 0.0
    assert F._daily_return(0.10) > 0
    assert F._daily_return(-0.10) < 0


# --- news recency is timezone-safe --------------------------------------------------------

def test_news_recency_handles_tz_aware_and_naive():
    today = F._utc_today()
    assert F._news_is_recent(pd.Timestamp.now("UTC").isoformat(), today) is True
    assert F._news_is_recent("2000-01-01T00:00:00+02:00", today) is False
    assert F._news_is_recent("not-a-date", today) is False
    assert F._news_is_recent(None, today) is False


# --- build_forecast composes a coherent timeline ------------------------------------------

def _stub_recs():
    return {
        "recommendations": [
            {"instrumentId": 1, "symbol": "TSLA", "name": "Tesla", "action": "sell",
             "conviction": "high", "currentValueCHF": 24_000.0, "holdingCagr": -0.05,
             "benchmarkSymbol": "VWRL.SW", "benchmarkName": "FTSE All-World",
             "opportunityCostCHF": 3_200.0, "reason": "In the sell zone.",
             "reinvest": [{"symbol": "VWRL.SW", "name": "FTSE All-World"}],
             "verdict": {"drivers": {"marginOfSafetyPct": -0.35}}},
            {"instrumentId": 2, "symbol": "NESN.SW", "name": "Nestle", "action": "buy",
             "conviction": "medium", "currentValueCHF": 12_000.0, "holdingCagr": 0.03,
             "benchmarkSymbol": "VWRL.SW", "benchmarkName": "FTSE All-World",
             "opportunityCostCHF": 0.0, "reason": "Undervalued.",
             "reinvest": None, "verdict": {"drivers": {"marginOfSafetyPct": 0.18}}},
        ],
        "cashSignal": {"symbol": "VWRL.SW", "name": "FTSE All-World", "cashCHF": 5_000.0,
                       "reason": "Idle cash."},
        "summary": {"counts": {"sell": 1, "buy": 1, "hold": 3}, "portfolioValueCHF": 90_000.0,
                    "idleCashCHF": 5_000.0, "reallocatableCHF": 22_000.0},
    }


def _patch(monkeypatch):
    monkeypatch.setattr(F, "build_recommendations", lambda s: _stub_recs())
    monkeypatch.setattr(F, "benchmark_cagr", lambda s, **k: 0.075)
    monkeypatch.setattr(F, "rivalry_check", lambda i, s=None: {"available": False})
    monkeypatch.setattr(F, "get_news", lambda s, limit=1: {"items": [
        {"title": f"{s} moves", "link": "http://x", "publisher": "Reuters",
         "publishedAt": pd.Timestamp.now("UTC").isoformat()},
    ]})


def test_build_forecast_flags_the_sell_with_a_per_day_cost(monkeypatch):
    _patch(monkeypatch)
    out = F.build_forecast({}, horizon_days=30)

    assert out["dailyOpportunityCostCHF"] > 0
    assert out["atRiskValueCHF"] == 24_000.0
    # Today: the cash deploy + the sell.
    kinds = {a["kind"] for a in out["today"]["actions"]}
    assert kinds == {"deploy-cash", "sell"}
    sell = next(a for a in out["today"]["actions"] if a["kind"] == "sell")
    assert sell["symbol"] == "TSLA"
    assert sell["opportunityCostPerDayCHF"] > 0
    assert sell["opportunityCostCumulativeCHF"] == 3_200.0


def test_build_forecast_timeline_is_dated_and_ordered(monkeypatch):
    _patch(monkeypatch)
    out = F.build_forecast({}, horizon_days=30)

    dates = [e["date"] for e in out["timeline"]]
    assert dates == sorted(dates)  # chronological

    by_kind = {}
    for e in out["timeline"]:
        by_kind.setdefault(e["kind"], []).append(e)

    # A high-conviction sell lands one day out and pairs with a reinvest on the same date.
    sell = by_kind["sell"][0]
    reinvest = by_kind["reinvest"][0]
    assert sell["offsetDays"] == 1
    assert reinvest["date"] == sell["date"]
    assert reinvest["target"]["symbol"] == "VWRL.SW"

    # A genuinely fresh headline surfaces as a 'this happened' entry today.
    news = by_kind["news"][0]
    assert news["status"] == "occurred"
    assert news["offsetDays"] == 0

    # Buy-more sits later than the sell (no clock running against you).
    buy_more = next(e for e in by_kind["buy"] if e["symbol"] == "NESN.SW")
    assert buy_more["offsetDays"] > sell["offsetDays"]


def test_build_forecast_empty_portfolio_is_quiet(monkeypatch):
    monkeypatch.setattr(F, "build_recommendations", lambda s: {
        "recommendations": [], "cashSignal": None,
        "summary": {"counts": {"sell": 0, "buy": 0, "hold": 0}, "portfolioValueCHF": 0.0,
                    "idleCashCHF": 0.0, "reallocatableCHF": 0.0},
    })
    out = F.build_forecast({}, horizon_days=30)
    assert out["dailyOpportunityCostCHF"] == 0.0
    assert out["today"]["count"] == 0
    assert out["timeline"] == []

"""Phase-2c: bear / base / bull scenario valuation (VALUE_INVESTING_AUDIT §3 F-10).

Instead of a single "magic" point, the engine now also produces three explicit scenarios
that vary the *assumptions* (growth, discount rate, terminal growth) → an intrinsic value
range and a margin-of-safety range. Wide scenario spread lowers confidence / raises a
valuation-uncertainty flag. The base scenario is consistent with the earnings DCF model.
"""
from __future__ import annotations

from app.services import valuation as V


def mk_data(**snap):
    base = {
        "currency": "USD", "sector": "Technology",
        "trailingEps": 5.0, "forwardEps": 5.2, "priceToBook": 3.0,
        "returnOnEquity": 0.22, "profitMargins": 0.18, "dividendYield": 1.0,
        "payoutRatio": 0.3, "totalDebt": 1e9, "ebitda": 3e9,
        "revenueGrowth": 0.07, "earningsGrowth": 0.07,
    }
    base.update(snap)
    hist = [{"year": 2021, "netIncome": 1e9}, {"year": 2023, "netIncome": 1.2e9}]
    return {"snapshot": base, "history": hist, "financialCurrency": base["currency"]}


def test_scenarios_present_and_ordered():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(), settings=None)
    s = va["scenarios"]
    assert set(s) == {"bear", "base", "bull"}
    assert s["bear"]["intrinsicValue"] < s["base"]["intrinsicValue"] < s["bull"]["intrinsicValue"]


def test_bear_more_conservative_assumptions_than_bull():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(), settings=None)
    s = va["scenarios"]
    assert s["bear"]["assumptions"]["growth"] < s["bull"]["assumptions"]["growth"]
    assert s["bear"]["assumptions"]["discountRate"] > s["bull"]["assumptions"]["discountRate"]


def test_base_scenario_matches_the_earnings_dcf_model():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(), settings=None)
    assert va["scenarios"]["base"]["intrinsicValue"] == va["models"]["dcf"]


def test_margin_of_safety_range_tracks_scenarios():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(), settings=None)
    s = va["scenarios"]
    assert s["bear"]["marginOfSafety"] < s["bull"]["marginOfSafety"]
    vr = va["valuationRange"]
    assert vr["low"] == s["bear"]["intrinsicValue"]
    assert vr["high"] == s["bull"]["intrinsicValue"]
    assert va["valuationUncertainty"] in {"low", "moderate", "high"}


def test_no_scenarios_without_positive_earnings():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(trailingEps=None, forwardEps=None),
                          settings=None)
    assert va["scenarios"] is None
    assert va["valuationRange"] is None

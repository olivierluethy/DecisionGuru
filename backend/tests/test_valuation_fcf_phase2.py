"""Phase-2b: cash-based valuation lane — FCF & owner earnings (VALUE_INVESTING_AUDIT §3 F-8).

The old engine relabeled accounting EPS as "owner earnings." This adds a genuine cash lane:
normalized free cash flow per share (median of the available years, to smooth one-off
capex) drives an additional DCF model, and owner earnings (NI + D&A − capex) is reported.
Everything degrades gracefully when no cash-flow data is cached.
"""
from __future__ import annotations

from app.services import valuation as V


def mk_data(cashflow=None, **snap):
    base = {
        "currency": "USD", "sector": "Consumer Defensive",
        "trailingEps": 3.0, "forwardEps": 3.2, "priceToBook": 4.0,
        "returnOnEquity": 0.30, "profitMargins": 0.20, "dividendYield": 2.5,
        "payoutRatio": 0.5, "totalDebt": 1e9, "ebitda": 5e9,
        "revenueGrowth": 0.06, "earningsGrowth": 0.06,
    }
    base.update(snap)
    hist = [{"year": 2021, "netIncome": 4e9}, {"year": 2023, "netIncome": 4.5e9}]
    data = {"snapshot": base, "history": hist, "financialCurrency": base["currency"]}
    if cashflow is not None:
        data["cashflow"] = cashflow
    return data


SHARES = 1e8
CF = {
    "sharesOutstanding": SHARES,
    "years": [
        {"year": 2021, "freeCashFlow": 5e8, "operatingCashFlow": 7e8, "capex": -2e8,
         "dna": 1e8, "netIncome": 5.5e8},
        {"year": 2022, "freeCashFlow": 5.5e8, "operatingCashFlow": 7.5e8, "capex": -2e8,
         "dna": 1e8, "netIncome": 5.5e8},
        {"year": 2023, "freeCashFlow": 6e8, "operatingCashFlow": 8e8, "capex": -2e8,
         "dna": 1e8, "netIncome": 5.5e8},
    ],
}


def test_fcf_model_added_to_the_range_when_cashflow_present():
    va = V.value_analysis("KO", 50.0, "USD", data=mk_data(cashflow=CF), settings=None)
    assert "fcf" in va["models"]
    assert va["intrinsic"]["mid"] is not None


def test_latest_fcf_per_share_and_yield_exposed():
    va = V.value_analysis("KO", 50.0, "USD", data=mk_data(cashflow=CF), settings=None)
    assert va["fcfPerShare"] == 6.0                 # latest 6e8 / 1e8
    assert abs(va["fcfYield"] - (6.0 / 50.0)) < 1e-9


def test_normalized_fcf_uses_median_to_smooth_capex_lumpiness():
    va = V.value_analysis("KO", 50.0, "USD", data=mk_data(cashflow=CF), settings=None)
    assert va["normalizedFcfPerShare"] == 5.5       # median(5.0, 5.5, 6.0)


def test_owner_earnings_is_ni_plus_dna_minus_capex():
    va = V.value_analysis("KO", 50.0, "USD", data=mk_data(cashflow=CF), settings=None)
    # latest: (5.5e8 + 1e8 − 2e8) / 1e8 = 4.5
    assert va["ownerEarningsPerShare"] == 4.5


def test_degrades_gracefully_without_cashflow():
    va = V.value_analysis("KO", 50.0, "USD", data=mk_data(cashflow=None), settings=None)
    assert "fcf" not in va["models"]
    assert va["fcfPerShare"] is None
    assert va["ownerEarningsPerShare"] is None
    assert va["intrinsic"]["mid"] is not None        # other models still value it

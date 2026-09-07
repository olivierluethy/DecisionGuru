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
    # Net income (4e8/1e8 = 4.0) sits BELOW the cash the owner receives (FCF 5–6/share) — an
    # amortization-heavy profile → the engine should value on owner earnings / free cash flow.
    hist = [{"year": 2021, "netIncome": 4e8}, {"year": 2022, "netIncome": 4e8},
            {"year": 2023, "netIncome": 4e8}]
    bal = {"years": [{"year": y, "stockholdersEquity": 4e9, "sharesOutstanding": 1e8}
                     for y in (2021, 2022, 2023)]}
    data = {"snapshot": base, "history": hist, "balance": bal, "financialCurrency": base["currency"]}
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


def test_free_cash_flow_drives_the_valuation_when_it_is_the_cleaner_measure():
    # Area 3: FCF/share (6e8/1e8 = 6, above the 5.5 accounting earnings, stable) becomes the
    # earning-power measure, not a "model" in a median.
    va = V.value_analysis("KO", 50.0, "USD", data=mk_data(cashflow=CF), settings=None)
    assert va["reliableValue"] is True and va["fairValue"] is not None
    assert "free cash flow" in va["earningPower"]["measure"]


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
    assert va["fcfPerShare"] is None
    assert va["ownerEarningsPerShare"] is None
    # Without cash-flow data the engine falls back to normalized net income and still values it.
    assert va["reliableValue"] is True and va["fairValue"] is not None
    assert "net income" in va["earningPower"]["measure"]

"""Phase-1 regression tests for the valuation engine.

Covers the Value-Investing brief's Scenario A (debt-free leverage), B (pence/minor
units), D (model midpoint), and F (sub-1% dividend yield). Each asserts a correction
described in VALUE_INVESTING_AUDIT.md §3/§7.
"""
from __future__ import annotations

from app.services import valuation as V


def mk_data(**snap):
    """A minimal fundamentals payload for value_analysis(data=...)."""
    base = {
        "currency": "USD",
        "sector": "Technology",
        "trailingEps": 5.0,
        "forwardEps": 5.5,
        "priceToBook": 2.0,
        "returnOnEquity": 0.20,
        "profitMargins": 0.15,
        "dividendYield": 2.0,       # yfinance 1.6.0 percent units
        "payoutRatio": 0.4,
        "totalDebt": 1_000_000.0,
        "ebitda": 2_000_000.0,
        "revenueGrowth": 0.08,
        "earningsGrowth": 0.08,
    }
    base.update(snap)
    hist = [
        {"year": 2021, "netIncome": 1_000_000.0},
        {"year": 2023, "netIncome": 1_300_000.0},
    ]
    return {"snapshot": base, "history": hist, "financialCurrency": base["currency"]}


def _check(va, label):
    return next(c for c in va["quality"]["checks"] if c["label"].startswith(label))


# --- Scenario D: model midpoint is the median, not the index-max -----------------
def test_median_of_two_models_is_their_midpoint():
    assert V._median([100.0, 200.0]) == 150.0


def test_median_of_three_is_the_middle():
    assert V._median([100.0, 150.0, 180.0]) == 150.0


def test_intrinsic_mid_is_the_earning_power_fair_value():
    # Area 3: intrinsic.mid is the earning-power fair value (with justified growth), and
    # intrinsic.low is the no-growth anchor — not a median of a model set.
    d = {"snapshot": {"currency": "USD", "sector": "Technology", "trailingEps": 5.0,
                      "forwardEps": 5.2, "priceToBook": 2.0, "returnOnEquity": 0.15, "profitMargins": 0.15},
         "history": [{"year": 2021, "netIncome": 400.0}, {"year": 2022, "netIncome": 400.0},
                     {"year": 2023, "netIncome": 400.0}],
         "cashflow": {"sharesOutstanding": 100.0, "years": [{"year": y, "freeCashFlow": 400.0} for y in (2021, 2022, 2023)]},
         "balance": {"years": [{"year": y, "stockholdersEquity": 2000.0, "sharesOutstanding": 100.0} for y in (2021, 2022, 2023)]},
         "financialCurrency": "USD"}
    va = V.value_analysis("TEST", price=100.0, currency="USD", data=d, settings=None)
    assert va["intrinsic"]["mid"] == va["fairValue"]
    assert va["intrinsic"]["low"] == va["noGrowthValue"]


# --- Scenario A: a debt-free company must not FAIL the leverage check ------------
def test_debt_free_company_passes_leverage():
    va = V.value_analysis("TEST", 100.0, "USD", data=mk_data(totalDebt=0.0, ebitda=2_000_000.0),
                          settings=None)
    lev = _check(va, "Debt / EBITDA")
    assert lev["pass"] is True
    assert lev.get("applicable", True) is True


def test_unknown_debt_is_not_applicable_not_a_fail():
    va = V.value_analysis("TEST", 100.0, "USD", data=mk_data(totalDebt=None, ebitda=None),
                          settings=None)
    lev = _check(va, "Debt / EBITDA")
    assert lev["applicable"] is False
    # n/a checks must not drag the score: max counts applicable checks only.
    q = va["quality"]
    assert q["max"] == sum(1 for c in q["checks"] if c.get("applicable", True))
    assert q["max"] < len(q["checks"])


def test_high_leverage_still_fails():
    va = V.value_analysis("TEST", 100.0, "USD", data=mk_data(totalDebt=10_000_000.0, ebitda=1_000_000.0),
                          settings=None)
    lev = _check(va, "Debt / EBITDA")
    assert lev["pass"] is False
    assert lev["applicable"] is True


# --- Scenario F: a genuine 0.9% yield stays 0.9%, never 90% ----------------------
def test_sub_one_percent_dividend_yield_not_inflated():
    va = V.value_analysis("TEST", 100.0, "USD", data=mk_data(dividendYield=0.9), settings=None)
    assert abs(va["dividendYield"] - 0.009) < 1e-9


def test_normal_dividend_yield_normalised_from_percent():
    va = V.value_analysis("TEST", 100.0, "USD", data=mk_data(dividendYield=2.38), settings=None)
    assert abs(va["dividendYield"] - 0.0238) < 1e-9


# --- Scenario B: a pence-quoted (GBp) instrument normalises to GBP ---------------
def test_minor_unit_eps_and_currency_normalised():
    # Caller passes the price already normalised to the major unit (GBP), while the
    # fundamentals snapshot is still quoted in pence (GBp) — EPS must normalise by its
    # own source unit regardless of the price currency.
    data = mk_data(currency="GBp", trailingEps=500.0, forwardEps=520.0, priceToBook=2.0)
    # Balance sheet in pence too — book value per share must normalise by its own (GBp) unit,
    # like EPS. equity 50000 GBp / 100 sh = 500 GBp → 5.00 GBP.
    data["balance"] = {"years": [{"year": 2023, "stockholdersEquity": 50_000.0, "sharesOutstanding": 100.0}]}
    va = V.value_analysis("TEST.L", 50.0, "GBP", data=data, settings=None)
    assert va["currency"] == "GBP"
    assert va["eps"] == 5.0
    assert va["forwardEps"] == 5.2
    # Book value per share normalizes by its own (GBp) unit → GBP scale (5.00, not 500).
    assert va["bookValuePerShare"] == 5.0


def test_minor_unit_eps_normalised_when_price_currency_absent():
    # Screener path: currency arg is the snapshot's own (still GBp); still normalises.
    va = V.value_analysis("TEST.L", 50.0, None,
                          data=mk_data(currency="GBp", trailingEps=500.0, priceToBook=2.0),
                          settings=None)
    assert va["currency"] == "GBP"
    assert va["eps"] == 5.0

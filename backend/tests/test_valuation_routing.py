# backend/tests/test_valuation_routing.py
"""Area 2 — business-type routing + abstention.

An earnings-growth model must not run as the official fair value for a business where it is
economically inappropriate (financials / REITs), and a company without enough positive-earnings
history gets NO RELIABLE FAIR VALUE rather than a forward-EPS fantasy."""
from __future__ import annotations

from app.services import valuation as v


def _op(**over):
    """A normal operating company: 3+ positive earnings years, balance sheet present."""
    d = {
        "financialCurrency": "USD",
        "snapshot": {"currency": "USD", "sector": "Technology",
                     "trailingEps": 5.0, "forwardEps": 5.5, "priceToBook": 2.0},
        "history": [{"year": 2021, "netIncome": 100.0},
                    {"year": 2022, "netIncome": 110.0},
                    {"year": 2023, "netIncome": 120.0}],
        "cashflow": {"sharesOutstanding": 100.0, "years": [
            {"year": 2021, "freeCashFlow": 100.0}, {"year": 2022, "freeCashFlow": 110.0},
            {"year": 2023, "freeCashFlow": 120.0}]},
        "balance": {"years": [
            {"year": 2021, "stockholdersEquity": 1000.0, "sharesOutstanding": 100.0},
            {"year": 2022, "stockholdersEquity": 1000.0, "sharesOutstanding": 100.0},
            {"year": 2023, "stockholdersEquity": 1000.0, "sharesOutstanding": 100.0}]},
    }
    for k, val in over.items():
        if k == "sector":
            d["snapshot"]["sector"] = val
        elif k == "priceToBook":
            d["snapshot"]["priceToBook"] = val
        elif k == "history":
            d["history"] = val
        elif k == "equity":
            for yr in d["balance"]["years"]:
                yr["stockholdersEquity"] = val
    return d


def test_operating_company_uses_earnings_framework():
    out = v.value_analysis("X", 50.0, "USD", data=_op(), settings=None)
    assert out["valuationFramework"] == "earnings"
    assert out["reliableValue"] is True
    assert out["fairValue"] and out["fairValue"] > 0


def test_reit_routes_to_book_nav_near_book_is_fair():
    # Real Estate → NAV. equity 1408 / 100 sh = 14.08 NAV; price 12.9 ≈ 0.92× book → fair.
    d = _op(sector="Real Estate", equity=1408.0, priceToBook=0.916)
    out = v.value_analysis("DXLIKE", 12.9, "USD", data=d, settings=None)
    assert out["valuationFramework"] == "book_nav"
    assert out["reliableValue"] is True
    assert abs(out["fairValue"] - 14.08) < 0.05          # NAV, not an earnings DCF
    assert out["models"] == {}                            # earnings models are not the basis
    assert out["bookNav"] and out["bookNav"]["navPerShare"] == 14.08
    assert out["band"]["band"] == "fair"


def test_below_nav_is_flagged_not_an_auto_buy():
    # equity 3240/100 = 32.4 NAV; price 18.73 ≈ 0.58× → below NAV, with a mandatory caveat.
    d = _op(sector="Real Estate", equity=3240.0, priceToBook=0.578)
    out = v.value_analysis("VNALIKE", 18.73, "USD", data=d, settings=None)
    assert out["valuationFramework"] == "book_nav"
    assert out["band"]["band"] == "undervalued"           # a discount to NAV…
    assert out["bookNav"]["caveat"]                        # …but never an automatic buy
    assert "leverage" in out["bookNav"]["caveat"].lower()


def test_corrupt_book_data_abstains():
    # Absurd price-to-book (Berkshire: A-share book vs B-share price) → no reliable value.
    d = _op(sector="Financial Services", priceToBook=0.001)
    out = v.value_analysis("BRKLIKE", 500.0, "USD", data=d, settings=None)
    assert out["reliableValue"] is False
    assert out["fairValue"] is None
    assert out["band"] is None
    assert "book" in (out["reliabilityReason"] or "").lower()


def test_no_positive_earnings_history_abstains_over_forward_eps():
    # 3 years on record, only 1 profitable — the forward-EPS DCF must NOT manufacture a value.
    d = _op(history=[{"year": 2021, "netIncome": -30.0},
                     {"year": 2022, "netIncome": 100.0},
                     {"year": 2023, "netIncome": -50.0}])
    out = v.value_analysis("ASANLIKE", 10.0, "USD", data=d, settings=None)
    assert out["reliableValue"] is False
    assert out["fairValue"] is None
    assert out["valuationFramework"] == "earnings"        # right framework, just not enough data
    assert "positive-earnings" in (out["reliabilityReason"] or "").lower()

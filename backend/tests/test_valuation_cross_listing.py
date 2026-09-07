# backend/tests/test_valuation_cross_listing.py
"""Cross-listing handling.

The cash-lane DISPLAY figures (FCF/share, owner earnings, FCF yield) come from the cash-flow
statement in the REPORTING currency; when the security trades in a different currency they are
dropped so nothing is shown in the wrong currency. And under Area 3 a cross-listing ABSTAINS
from a fair value entirely — sustainable earning power can't be normalized in the trading
currency/share basis, so it returns NO RELIABLE FAIR VALUE rather than a mismatched number."""
from __future__ import annotations

from app.services import valuation as v


def _data(trading: str, reporting: str) -> dict:
    return {
        "financialCurrency": reporting,
        "snapshot": {"currency": trading, "sector": "Technology", "trailingEps": 5.0,
                     "forwardEps": 5.0, "priceToBook": 2.0, "returnOnEquity": 0.15, "profitMargins": 0.15},
        "history": [{"year": 2022, "netIncome": 100.0}, {"year": 2023, "netIncome": 110.0},
                    {"year": 2024, "netIncome": 120.0}],
        "cashflow": {"sharesOutstanding": 100.0, "years": [
            {"year": 2022, "freeCashFlow": 400.0, "dna": 20.0, "capex": -30.0, "netIncome": 100.0},
            {"year": 2023, "freeCashFlow": 450.0, "dna": 21.0, "capex": -31.0, "netIncome": 110.0},
            {"year": 2024, "freeCashFlow": 500.0, "dna": 22.0, "capex": -32.0, "netIncome": 120.0}]},
        "balance": {"years": [{"year": y, "stockholdersEquity": 1000.0, "sharesOutstanding": 100.0}
                              for y in (2022, 2023, 2024)]},
    }


def test_cash_display_figures_present_when_currencies_match():
    va = v.value_analysis("X", 50.0, "USD", data=_data("USD", "USD"), settings=None)
    assert va["reliableValue"] is True and va["fairValue"] is not None
    assert va["fcfPerShare"] is not None
    assert va["normalizedFcfPerShare"] is not None
    assert va["ownerEarningsPerShare"] is not None
    assert va["fcfYield"] is not None


def test_cross_listing_abstains_and_drops_cash_figures():
    va = v.value_analysis("X", 50.0, "USD", data=_data("USD", "EUR"), settings=None)
    # NO RELIABLE FAIR VALUE — earning power can't be normalized in the trading basis.
    assert va["reliableValue"] is False and va["fairValue"] is None
    assert "cross-listing" in (va["reliabilityReason"] or "")
    # The wrong-currency cash display figures are gone, and book can't be placed either.
    assert va["fcfPerShare"] is None and va["ownerEarningsPerShare"] is None and va["fcfYield"] is None
    assert va["bookValuePerShare"] is None

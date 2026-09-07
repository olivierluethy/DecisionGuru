# backend/tests/test_valuation_price_independence.py
"""Intrinsic value must be estimated from FUNDAMENTALS, independent of the market price —
otherwise the chain becomes Price → Fair Value → Margin of Safety and the MoS is no longer a
real discount to an independent estimate.

The one price dependency was `bvps = price / priceToBook`, which fed the Graham number, so a
higher price produced a higher "intrinsic" value. Book value per share must come from the
balance sheet (equity ÷ shares), which does not move with the quote."""
from __future__ import annotations

import math
from app.services import valuation as v


def _fixture():
    # Tuned so the Graham number is a MIDDLE (decisive) model: with a price-coupled bvps the
    # median fair value moves with price; with the balance-sheet book (equity/shares = 10.0) it
    # does not. Growth is 0 (flat net income), so gg/dcf/fcf are price-independent constants.
    return {
        "financialCurrency": "USD",
        "snapshot": {"currency": "USD", "trailingEps": 4.0, "priceToBook": 2.0},
        "history": [{"year": 2020, "netIncome": 100.0}, {"year": 2021, "netIncome": 100.0},
                    {"year": 2022, "netIncome": 100.0}],
        "cashflow": {"sharesOutstanding": 100.0, "years": [
            {"year": 2020, "freeCashFlow": 550.0},
            {"year": 2021, "freeCashFlow": 550.0},
            {"year": 2022, "freeCashFlow": 550.0}]},
        "balance": {"years": [
            {"year": 2020, "stockholdersEquity": 1000.0, "sharesOutstanding": 100.0},
            {"year": 2021, "stockholdersEquity": 1000.0, "sharesOutstanding": 100.0},
            {"year": 2022, "stockholdersEquity": 1000.0, "sharesOutstanding": 100.0}]},
    }


def test_fair_value_is_independent_of_price():
    d = _fixture()
    lo = v.value_analysis("X", 50.0, "USD", data=d)
    hi = v.value_analysis("X", 100.0, "USD", data=d)
    assert lo["fairValue"] == hi["fairValue"], (
        f"intrinsic value moved with price: {lo['fairValue']} -> {hi['fairValue']}")


def test_book_value_comes_from_balance_sheet_not_price():
    d = _fixture()
    out = v.value_analysis("X", 50.0, "USD", data=d)
    assert out["bookValuePerShare"] == 10.0          # 1000 / 100, NOT price/p2b (= 25.0)
    # …and the fair value is reliable and price-independent (unchanged if the price were higher).
    assert out["reliableValue"] is True and out["fairValue"] is not None


def test_cross_listing_drops_graham_number_no_currency_mix():
    # Balance-sheet book is in the reporting currency; for an ADR (trades USD, reports EUR) it
    # cannot be placed against the trading-currency EPS, so the Graham number is dropped rather
    # than mixing currencies (consistent with the cash-lane abstention).
    d = _fixture()
    d["financialCurrency"] = "EUR"          # reporting ≠ trading (USD) → cross-listing
    out = v.value_analysis("X", 50.0, "USD", data=d)
    assert "grahamNumber" not in out["models"]
    assert out["bookValuePerShare"] is None

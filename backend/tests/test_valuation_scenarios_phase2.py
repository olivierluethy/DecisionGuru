"""Superseded by Area 3. The Phase-2 bear/base/bull scenarios are replaced by the earning-power
engine's no-growth ANCHOR plus a growth-SENSITIVITY read (0% / assumed g), which is a cleaner,
Graham/Buffett-aligned way to express valuation uncertainty. These tests now guard that new shape."""
from __future__ import annotations

from app.services import valuation as V


def mk_data(rows=None, **snap):
    base = {
        "currency": "USD", "sector": "Technology",
        "trailingEps": 5.0, "forwardEps": 5.2, "priceToBook": 3.0,
        "returnOnEquity": 0.22, "profitMargins": 0.18, "dividendYield": 1.0,
        "payoutRatio": 0.3, "totalDebt": 1e9, "ebitda": 3e9,
    }
    base.update(snap)
    rows = rows or [(2021, 400.0, 400.0), (2022, 430.0, 430.0), (2023, 470.0, 470.0), (2024, 510.0, 510.0)]
    hist = [{"year": y, "netIncome": ni} for (y, ni, _) in rows]
    cf = {"sharesOutstanding": 100.0, "years": [{"year": y, "freeCashFlow": f} for (y, _, f) in rows]}
    bal = {"years": [{"year": y, "stockholdersEquity": 4000.0, "sharesOutstanding": 100.0} for (y, _, _) in rows]}
    return {"snapshot": base, "history": hist, "cashflow": cf, "balance": bal,
            "financialCurrency": base["currency"]}


def test_no_growth_anchor_is_exposed_as_the_fundamental_base():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(), settings=None)
    assert va["reliableValue"] is True
    ep = va["earningPower"]
    assert ep is not None
    assert va["noGrowthValue"] == ep["noGrowthValue"]         # the anchor is visible
    # The intrinsic range runs from the no-growth anchor to the with-growth fair value.
    assert va["intrinsic"]["low"] == va["noGrowthValue"]
    assert va["intrinsic"]["mid"] == va["fairValue"]


def test_growth_only_lifts_value_above_the_anchor():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(), settings=None)  # rising series → supported growth
    assert va["growthBasis"] == "supported"
    assert va["fairValue"] >= va["noGrowthValue"]


def test_sensitivity_block_reports_value_at_zero_and_at_growth():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(), settings=None)
    s = va["earningPower"]["sensitivity"]
    assert s["at0"] is not None and s["atGrowth"] is not None
    assert s["atGrowth"] >= s["at0"]


def test_old_scenarios_field_is_retired_for_the_earnings_framework():
    va = V.value_analysis("T", 80.0, "USD", data=mk_data(), settings=None)
    assert va["scenarios"] is None and va["valuationRange"] is None


def test_no_value_without_a_normalizable_earnings_series():
    # Two years only → can't normalize a level → NO RELIABLE FAIR VALUE.
    va = V.value_analysis("T", 80.0, "USD",
                          data=mk_data(rows=[(2023, 400.0, 400.0), (2024, 430.0, 430.0)]), settings=None)
    assert va["reliableValue"] is False and va["fairValue"] is None

# backend/tests/test_valuation_area3.py
"""Area 3 wired into value_analysis: earning power first, growth only when justified, the
no-growth value visible as the anchor, and abstention when earning power can't be established."""
from __future__ import annotations

from app.services import valuation as v


def _co(rows, sector="Technology", currency="USD", fin="USD", p2b=2.0, roe=0.15,
        margins=0.15, equity=2000.0, trailing=5.0):
    """rows = list of (year, netIncome, freeCashFlow); shares fixed at 100."""
    hist = [{"year": y, "netIncome": ni} for (y, ni, _) in rows]
    cf = {"sharesOutstanding": 100.0, "years": [{"year": y, "freeCashFlow": f} for (y, _, f) in rows]}
    bal = {"years": [{"year": y, "stockholdersEquity": equity, "sharesOutstanding": 100.0} for (y, _, _) in rows]}
    return {"financialCurrency": fin,
            "snapshot": {"currency": currency, "sector": sector, "trailingEps": trailing,
                         "forwardEps": trailing, "priceToBook": p2b, "returnOnEquity": roe,
                         "profitMargins": margins},
            "history": hist, "cashflow": cf, "balance": bal}


def test_flat_business_defaults_to_zero_growth_and_anchor_equals_fair():
    d = _co([(2021, 400, 400), (2022, 400, 400), (2023, 400, 400), (2024, 400, 400)])
    out = v.value_analysis("FLAT", 60.0, "USD", data=d, settings=None)
    assert out["reliableValue"] is True
    assert out["growthBasis"] == "none" and out["growthAssumption"] == 0.0
    assert out["noGrowthValue"] == out["fairValue"]      # no growth credited → anchor == fair value
    assert out["reliabilityTier"] == 1


def test_justified_growth_lifts_value_above_the_no_growth_anchor():
    d = _co([(2021, 400, 400), (2022, 460, 460), (2023, 530, 530), (2024, 610, 610)])
    out = v.value_analysis("GROW", 60.0, "USD", data=d, settings=None)
    assert out["growthBasis"] == "supported" and out["growthAssumption"] > 0
    assert out["fairValue"] > out["noGrowthValue"]       # growth adds only above the anchor
    assert out["earningPower"]["growthReason"]


def test_exceptional_growth_is_capped_assumption_sensitive_and_low_confidence():
    d = _co([(2021, 400, 400), (2022, 1200, 1200), (2023, 3000, 3000), (2024, 7000, 7000)])
    out = v.value_analysis("HYPER", 90.0, "USD", data=d, settings=None)
    assert out["growthBasis"] == "high-capped"
    assert out["assumptionSensitive"] is True
    assert out["reliabilityTier"] == 2                   # → no BUY (enforced in Area 4)
    assert out["confidence"] == "low"                    # confidence is a decision constraint


def test_cross_listing_abstains():
    d = _co([(2021, 400, 400), (2022, 410, 410), (2023, 420, 420), (2024, 430, 430)], fin="EUR")
    out = v.value_analysis("ADR", 50.0, "USD", data=d, settings=None)
    assert out["reliableValue"] is False and out["fairValue"] is None
    assert "cross-listing" in (out["reliabilityReason"] or "")


def test_net_income_without_cash_conversion_abstains():
    # Net income positive throughout, but recent free cash flow ≤ 0 → owner cash not converting.
    d = _co([(2021, 400, 300), (2022, 410, 200), (2023, 420, -50), (2024, 430, -60)])
    out = v.value_analysis("NOCASH", 50.0, "USD", data=d, settings=None)
    assert out["reliableValue"] is False
    assert "owner cash" in (out["reliabilityReason"] or "")


def test_deep_cyclical_trough_abstains():
    d = _co([(2021, 800, 800), (2022, 850, 850), (2023, 200, 200), (2024, 30, 30)])
    out = v.value_analysis("TROUGH", 40.0, "USD", data=d, settings=None)
    assert out["reliableValue"] is False
    assert "trough" in (out["reliabilityReason"] or "")


def test_graham_number_excluded_for_asset_light_high_roe():
    # High ROE (asset-light): the book-based Graham number must not anchor the value.
    d = _co([(2021, 400, 400), (2022, 400, 400), (2023, 400, 400), (2024, 400, 400)], roe=1.1)
    out = v.value_analysis("LIGHT", 60.0, "USD", data=d, settings=None)
    assert out["reliableValue"] is True                  # still valued, just without the book anchor

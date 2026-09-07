# backend/tests/test_earning_power.py
"""Area 3 — sustainable earning power + justified growth (deterministic, business-property driven)."""
from __future__ import annotations

from app.services import earning_power as ep


# --- measure selection ----------------------------------------------------------------
def test_working_capital_noise_picks_net_income():
    # FCF swings wildly (incl. negative), net income stays positive & steadier → use NET INCOME.
    eps = [0.73, 1.24, 0.38, 0.88]
    fcf = [2.57, 6.59, 0.46, -6.32]
    measure, level = ep.select_measure(eps, fcf)
    assert measure == "normalized net income"
    assert level is not None and level > 0


def test_amortization_heavy_picks_owner_earnings():
    # Cash per share persistently above accounting earnings, and stable → OWNER EARNINGS / FCF.
    eps = [5.1, 5.6, 7.3, 5.1]
    fcf = [59.0, 82.0, 100.0, 126.0]
    measure, level = ep.select_measure(eps, fcf)
    assert measure == "owner earnings / free cash flow"
    assert abs(level - 91.0) < 1.0        # median of the positive FCF series


def test_convergent_measures_use_net_income():
    eps = [4.0, 4.2, 4.4, 4.3]
    fcf = [3.9, 4.1, 4.3, 4.2]
    measure, _ = ep.select_measure(eps, fcf)
    assert measure == "net income (converges with cash)"


# --- growth: default 0, credited only when justified ----------------------------------
def test_growth_defaults_to_zero_when_flat():
    g = ep.derive_growth([4.0, 4.1, 4.0, 4.05], roe=0.2, margins_stable=True)
    assert g["growth"] == 0.0 and g["basis"] == "none"


def test_post_peak_decline_is_not_structural_growth():
    # Rebound then fade (peak in the middle, latest well below peak) → NOT credited (Lufthansa-like).
    g = ep.derive_growth([791.0, 1673.0, 1380.0, 1339.0], roe=0.06, margins_stable=False)
    assert g["growth"] == 0.0
    assert "uptrend" in g["reason"].lower()


def test_consistent_growth_still_trending_is_credited_conservatively():
    # Monotone up, latest at the peak → credit HALF of the smoothed CAGR, capped.
    g = ep.derive_growth([100.0, 115.0, 132.0, 152.0], roe=0.18, margins_stable=True)
    assert g["basis"] == "supported"
    assert 0 < g["growth"] < 0.15          # a conservative fraction, under the guardrail


def test_exceptional_growth_capped_and_low_confidence():
    g = ep.derive_growth([5.0, 15.0, 40.0, 90.0], roe=1.0, margins_stable=True)
    assert g["basis"] == "high-capped"
    assert g["growth"] == ep.GROWTH_GUARDRAIL
    assert g["confidence"] == "low"        # extrapolating an exceptional rate is not conservative


# --- valuation anchors + Graham number is optional, not a floor -----------------------
def test_graham_number_dropped_for_asset_light_business():
    # High ROE (asset-light) → book isn't the value driver → Graham number is not used.
    fv_asset_light = ep.value_at_growth(10.0, 0.0, bvps=2.0, roe=1.1)
    fv_no_book = ep.value_at_growth(10.0, 0.0, bvps=None, roe=1.1)
    assert fv_asset_light == fv_no_book    # the book anchor was excluded either way


def test_graham_number_used_when_book_relevant():
    with_book = ep.value_at_growth(5.0, 0.0, bvps=40.0, roe=0.12)
    without = ep.value_at_growth(5.0, 0.0, bvps=None, roe=0.12)
    assert with_book != without            # a normal asset base → Graham number contributes


def test_fair_value_zero_growth_is_finite_and_positive():
    fv = ep.value_at_growth(8.0, 0.0, bvps=20.0, roe=0.15)
    assert fv and fv > 0


# --- sensitivity is the reliability signal --------------------------------------------
def test_sensitivity_reports_value_across_growth():
    s = ep.sensitivity(8.0, bvps=20.0, roe=0.15, g=0.05)
    assert s["at0"] < s["atG"] < s["atGplus"]   # value rises with the assumed growth

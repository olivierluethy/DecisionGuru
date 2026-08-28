"""Phase-2a: two-stage DCF taper (F-5) and robust reverse DCF (T-6).

The old `_dcf` clipped every g ≥ r to r−0.001, collapsing exactly the high-quality
compounders to an 8.9% grower, and `_implied_growth` inherited the cliff so it saturated
to ~0.40 for any richly-valued name. The redesign fades growth from g0 → terminal over the
horizon (finite for any g0, no cliff) and the reverse DCF reports "no solution" instead of
a fabricated bound. See VALUE_INVESTING_AUDIT §3 F-5/T-6.
"""
from __future__ import annotations

from app.services import valuation as V

R, TG = 0.09, 0.025
EPS = 5.0


# --- two-stage DCF ---------------------------------------------------------------
def test_growth_above_discount_is_finite_and_positive():
    v = V._dcf(EPS, 0.20, r=R, tg=TG, cap=False)   # g0=20% > r=9%
    assert v is not None and v > 0 and v < 1e9


def test_dcf_strictly_increasing_in_growth():
    lo = V._dcf(EPS, 0.02, r=R, tg=TG, cap=False)
    mid = V._dcf(EPS, 0.08, r=R, tg=TG, cap=False)
    hi = V._dcf(EPS, 0.14, r=R, tg=TG, cap=False)
    assert lo < mid < hi


def test_high_growth_no_longer_clipped_to_the_same_value():
    # Under the old cliff, g=0.14 and g=0.20 both became 0.089 → identical values.
    v14 = V._dcf(EPS, 0.14, r=R, tg=TG, cap=False)
    v20 = V._dcf(EPS, 0.20, r=R, tg=TG, cap=False)
    assert v20 > v14 * 1.05   # materially different, not clipped-equal


def test_dcf_invalid_when_discount_not_above_terminal():
    # r ≤ tg makes the Gordon terminal undefined/negative → cannot value.
    assert V._dcf(EPS, 0.05, r=0.02, tg=0.025, cap=False) is None


# --- reverse DCF -----------------------------------------------------------------
def test_reverse_dcf_returns_none_when_price_implies_absurd_growth():
    v_hi = V._dcf(EPS, 0.40, r=R, cap=False)
    price = v_hi * 1.5   # richer than even 40% initial growth can justify
    assert V._implied_growth(EPS, price, r=R) is None


def test_reverse_dcf_recovers_a_known_growth_in_bracket():
    g_true = 0.15
    price = V._dcf(EPS, g_true, r=R, cap=False)
    g = V._implied_growth(EPS, price, r=R)
    assert g is not None
    assert abs(g - g_true) < 0.005
    assert 0.0 < g < 0.40   # never saturates to the bracket edge

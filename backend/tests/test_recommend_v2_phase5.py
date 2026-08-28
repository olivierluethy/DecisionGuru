"""Phase-5: Recommendation Engine 2.0 (VALUE_INVESTING_AUDIT §5, brief §21–22, §34).

The one shared engine now fuses the separate layers — valuation, business quality,
financial strength, portfolio fit, data confidence — into a multi-dimensional decision and
two new first-class outcomes: PREFER ETF (an excellent asset the book already owns heavily
via funds) and INSUFFICIENT DATA (no reliable valuation). The canonical verdict key stays in
{buy-more, hold, sell} for back-compat; the richer read rides alongside.
"""
from __future__ import annotations

from app.services import verdict as VD


def mk_va(band="undervalued", confidence="high", n_models=3, mos=0.30, quality_frac=1.0,
          uncertainty="low"):
    n_pass = round(quality_frac * 6)
    checks = [{"label": f"c{i}", "pass": i < n_pass, "detail": "", "applicable": True}
              for i in range(6)]
    return {
        "band": {"band": band, "label": band.replace("-", " ").title()},
        "marginOfSafety": mos,
        "quality": {"score": n_pass, "max": 6, "checks": checks},
        "confidence": confidence,
        "models": {f"m{i}": 100.0 + i for i in range(n_models)},
        "supportableReturn": 0.12,
        "valuationUncertainty": uncertainty,
    }


QA_STRONG = {
    "roic": {"value": 0.22, "rating": "strong"},
    "fcfConversion": {"value": 0.9, "rating": "strong"},
    "interestCoverage": {"value": 15.0, "rating": "strong"},
    "moat": {"signal": "measurable-strong", "evidence": ["High ROIC"]},
}
FS_STRONG = {"debtState": "debt-free", "rating": "strong", "netDebtToEbitda": None}
FIT_PREFER_ETF = {"status": "prefer-etf", "preferEtf": True, "effective": 0.16}
FIT_IMPROVES = {"status": "improves", "preferEtf": False, "effective": 0.0}


# --- new outcomes ---------------------------------------------------------------
def test_prefer_etf_overrides_a_buy_when_fit_prefers_etf():
    r = VD.resolve_verdict(mk_va(), held=False, fit=FIT_PREFER_ETF,
                           quality_assessment=QA_STRONG, financial_strength=FS_STRONG)
    assert r["verdict"] == "buy-more"                  # canonical key unchanged
    assert r["action"]["label"] == "Prefer ETF"
    assert r["dimensions"]["portfolioFit"]["preferEtf"] is True


def test_buy_not_overridden_when_fit_does_not_prefer_etf():
    r = VD.resolve_verdict(mk_va(), held=False, fit=FIT_IMPROVES)
    assert r["action"]["label"] == "Buy"


def test_insufficient_data_when_no_valuation_basis():
    r = VD.resolve_verdict(None, held=True)
    assert r["action"]["label"] == "Insufficient data"
    assert r["dataSufficient"] is False


def test_insufficient_data_for_unowned_too():
    r = VD.resolve_verdict({"band": None, "models": {}}, held=False)
    assert r["action"]["label"] == "Insufficient data"


def test_sell_is_not_turned_into_prefer_etf():
    va = mk_va(band="significantly-overvalued", mos=-0.30)
    r = VD.resolve_verdict(va, held=True, fit=FIT_PREFER_ETF)
    assert r["verdict"] == "sell"
    assert r["action"]["label"] == "Sell"


# --- dimensions -----------------------------------------------------------------
def test_dimensions_block_present_and_populated():
    r = VD.resolve_verdict(mk_va(), held=True, fit=FIT_IMPROVES,
                           quality_assessment=QA_STRONG, financial_strength=FS_STRONG)
    dims = r["dimensions"]
    for key in ("quality", "financialStrength", "valuation", "expectedReturn",
                "portfolioFit", "dataConfidence", "risk"):
        assert key in dims and dims[key].get("rating") is not None


def test_quality_dimension_reflects_strong_assessment():
    r = VD.resolve_verdict(mk_va(), held=True, quality_assessment=QA_STRONG)
    assert r["dimensions"]["quality"]["rating"] == "strong"


def test_financial_strength_dimension_reflects_debt_free():
    r = VD.resolve_verdict(mk_va(), held=True, financial_strength=FS_STRONG)
    assert r["dimensions"]["financialStrength"]["rating"] == "strong"


def test_valuation_dimension_carries_margin_of_safety():
    r = VD.resolve_verdict(mk_va(mos=0.30), held=True)
    assert r["dimensions"]["valuation"]["rating"] == "undervalued"
    assert abs(r["dimensions"]["valuation"]["marginOfSafety"] - 0.30) < 1e-9


def test_backcompat_verdict_and_action_still_present_without_new_inputs():
    r = VD.resolve_verdict(mk_va(), held=True)   # no fit/quality/strength
    assert r["verdict"] == "buy-more"
    assert r["action"]["label"] == "Buy more"
    assert "dimensions" in r

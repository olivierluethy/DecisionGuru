"""Phase-2d: confidence floor on the Sell path (VALUE_INVESTING_AUDIT §3 F-11).

A categorical Sell must rest on a fair value we can stand behind: at least medium
confidence AND at least two agreeing valuation models. A low-confidence or single-model
sell-zone reads Reduce/Watch (trim), never a hard Sell — price alone on a shaky estimate
never forces realisation.
"""
from __future__ import annotations

from app.services import verdict as VD


def mk_va(band="significantly-overvalued", confidence="high", n_models=3, mos=-0.30):
    checks = [{"label": f"c{i}", "pass": i < 3, "detail": "", "applicable": True} for i in range(6)]
    return {
        "band": {"band": band, "label": band.replace("-", " ").title()},
        "marginOfSafety": mos,
        "quality": {"score": 3, "max": 6, "checks": checks},
        "confidence": confidence,
        "models": {f"m{i}": 100.0 + i for i in range(n_models)},
    }


def test_sell_fires_with_medium_confidence_and_two_models():
    v = VD.resolve_verdict(mk_va(confidence="medium", n_models=2), held=True)
    assert v["verdict"] == "sell"
    assert v["action"]["label"] == "Sell"


def test_low_confidence_sell_is_softened_to_reduce():
    v = VD.resolve_verdict(mk_va(confidence="low", n_models=3), held=True)
    assert v["verdict"] == "hold"
    assert v["action"]["label"] == "Reduce"     # trim, not a hard Sell
    assert v["trimNote"]


def test_single_model_sell_is_softened_even_at_high_confidence():
    v = VD.resolve_verdict(mk_va(confidence="high", n_models=1), held=True)
    assert v["verdict"] == "hold"
    assert v["action"]["label"] == "Reduce"


def test_softened_sell_for_unowned_reads_watch():
    v = VD.resolve_verdict(mk_va(confidence="low", n_models=3), held=False)
    assert v["verdict"] == "hold"
    assert v["action"]["label"] == "Watch"


def test_overvalued_band_unchanged_still_trims():
    v = VD.resolve_verdict(mk_va(band="overvalued", confidence="high"), held=True)
    assert v["verdict"] == "hold"
    assert v["action"]["label"] == "Reduce"

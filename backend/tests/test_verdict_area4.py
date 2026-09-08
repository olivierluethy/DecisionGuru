"""Area 4 — the conservative buy-gate (Graham/Buffett redesign).

A BUY/attractive verdict is only ever issued when the margin of safety rests on a fair
value we can stand behind: reliable value, reliability tier 1 (not assumption-sensitive)
and at least medium confidence. Undervalued-but-assumption-sensitive names (the discount
only appears once a growth rate is credited) are held, never bought — no BUY may depend on
an aggressive/cap-bound growth assumption.
"""
from __future__ import annotations

from app.services import verdict as VD


def mk_va(band="undervalued", confidence="high", mos=0.30, q_score=4, q_max=6,
          reliable=True, tier=1, assumption_sensitive=False, n_models=2, framework="earnings"):
    checks = [{"label": f"c{i}", "pass": i < q_score, "detail": "", "applicable": True}
              for i in range(q_max)]
    return {
        "band": {"band": band, "label": band.replace("-", " ").title()},
        "marginOfSafety": mos,
        "quality": {"score": q_score, "max": q_max, "checks": checks},
        "confidence": confidence,
        "models": {f"m{i}": 100.0 + i for i in range(n_models)},
        "reliableValue": reliable,
        "reliabilityTier": tier,
        "assumptionSensitive": assumption_sensitive,
        "valuationFramework": framework,
    }


def test_reliable_tier1_undervalued_is_a_buy():
    v = VD.resolve_verdict(mk_va(), held=True)
    assert v["verdict"] == "buy-more"
    assert v["action"]["label"] == "Buy more"
    assert v["conservativeBuyBlocked"] is False


def test_assumption_sensitive_undervalued_is_held_not_bought():
    """The Meta case: undervalued only because a capped growth rate was credited (tier 2,
    assumption-sensitive) → Hold, and say why. No BUY depends on the growth assumption."""
    v = VD.resolve_verdict(mk_va(tier=2, assumption_sensitive=True), held=True)
    assert v["verdict"] == "hold"
    assert v["action"]["label"] != "Buy more"
    assert v["conservativeBuyBlocked"] is True
    assert v["conservativeBuyReason"]


def test_tier2_unowned_reads_watch_not_buy():
    v = VD.resolve_verdict(mk_va(tier=2, assumption_sensitive=True), held=False)
    assert v["verdict"] == "hold"
    assert v["action"]["label"] == "Watch"


def test_low_confidence_undervalued_is_not_a_conservative_buy():
    v = VD.resolve_verdict(mk_va(confidence="low"), held=True)
    assert v["verdict"] == "hold"
    assert v["conservativeBuyBlocked"] is True


def test_unreliable_value_never_buys():
    """reliableValue False can't be a buy even if the caller left a stale undervalued band."""
    v = VD.resolve_verdict(mk_va(reliable=False), held=True)
    assert v["verdict"] == "hold"
    assert v["conservativeBuyBlocked"] is True


def test_below_nav_financial_is_never_an_auto_buy():
    """A financial/REIT trading below NAV (book-nav framework) is a starting point, not a
    conservative buy — leverage and asset-mark quality must be judged first (the Vonovia case)."""
    v = VD.resolve_verdict(mk_va(framework="book_nav"), held=True)
    assert v["verdict"] == "hold"
    assert v["conservativeBuyBlocked"] is True
    assert "NAV" in (v["conservativeBuyReason"] or "")


def test_weak_fundamentals_stay_a_value_trap_not_a_blocked_buy():
    """Weak quality is the pre-existing value-trap Hold, not the new conservative-buy block."""
    v = VD.resolve_verdict(mk_va(q_score=1, q_max=6), held=True)
    assert v["verdict"] == "hold"
    assert v["valueTrap"] is True
    assert v["conservativeBuyBlocked"] is False


def test_backward_compat_without_reliability_fields_still_buys():
    """A va payload predating Area 3/4 (no reliability fields) keeps the old buy behaviour."""
    va = {
        "band": {"band": "undervalued", "label": "Undervalued"},
        "marginOfSafety": 0.25,
        "quality": {"score": 4, "max": 6,
                    "checks": [{"label": f"c{i}", "pass": i < 4, "applicable": True} for i in range(6)]},
        "confidence": "high",
        "models": {"a": 1, "b": 2},
    }
    v = VD.resolve_verdict(va, held=True)
    assert v["verdict"] == "buy-more"
    assert v["conservativeBuyBlocked"] is False

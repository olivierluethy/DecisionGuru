"""Slice A — display-currency block on the valuation payload.

The valuation engine stays native; this block lets the UI render every figure in one
currency (CHF) beside the native one. Margin of safety is currency-invariant and must be
unaffected. An unresolvable FX pair must NOT fabricate a rate.
"""
from __future__ import annotations

import pytest

from app.services import valuation, fx
from app.services.fx import FxResult


def _sample_va() -> dict:
    # A native-USD valuation payload shaped like value_analysis() output.
    return {
        "symbol": "UNH",
        "currency": "USD",
        "price": 300.0,
        "fairValue": 360.0,
        "entryTarget": 252.0,
        "intrinsic": {"low": 320.0, "mid": 360.0, "high": 400.0},
        "models": {"grahamNumber": 280.0, "dcf": 360.0},
        "marginOfSafety": round(360.0 / 300.0 - 1, 4),  # native/native = +0.20
    }


def test_block_converts_headline_figures_at_the_rate(monkeypatch):
    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(0.88, "cache"))
    out = valuation.attach_display_currency(_sample_va(), base="CHF", as_of="2026-08-28")
    dc = out["displayCurrency"]
    assert dc["code"] == "CHF"
    assert dc["fxRate"] == 0.88
    assert dc["fxSource"] == "cache"
    assert dc["price"] == pytest.approx(264.0, abs=0.01)       # 300 × 0.88
    assert dc["fairValue"] == pytest.approx(316.8, abs=0.01)   # 360 × 0.88
    assert dc["grahamNumber"] == pytest.approx(246.4, abs=0.01)  # 280 × 0.88
    assert dc["entryTarget"] == pytest.approx(221.76, abs=0.01)  # 252 × 0.88
    assert dc["intrinsicMid"] == pytest.approx(316.8, abs=0.01)


def test_margin_of_safety_is_currency_invariant(monkeypatch):
    """The whole point (spec §15): MoS in native == MoS after converting both to CHF."""
    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(0.88, "cache"))
    va = _sample_va()
    native_mos = va["marginOfSafety"]
    out = valuation.attach_display_currency(va, base="CHF")
    dc = out["displayCurrency"]
    chf_mos = round(dc["fairValue"] / dc["price"] - 1, 4)
    assert chf_mos == pytest.approx(native_mos, abs=1e-4)
    # The engine's own native MoS is untouched.
    assert out["marginOfSafety"] == native_mos


def test_unresolvable_fx_never_fabricates(monkeypatch):
    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(None, "unresolved"))
    out = valuation.attach_display_currency(_sample_va(), base="CHF")
    dc = out["displayCurrency"]
    assert dc["fxRate"] is None
    assert dc["fxSource"] == "unresolved"
    assert "price" not in dc and "fairValue" not in dc


def test_same_currency_is_identity(monkeypatch):
    # A CHF-native stock: rate 1.0, converted == native.
    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(1.0, "same"))
    va = _sample_va()
    va["currency"] = "CHF"
    out = valuation.attach_display_currency(va, base="CHF")
    dc = out["displayCurrency"]
    assert dc["fxRate"] == 1.0
    assert dc["price"] == pytest.approx(va["price"], abs=0.01)


def test_missing_native_currency_yields_null_block(monkeypatch):
    va = _sample_va()
    va["currency"] = None
    out = valuation.attach_display_currency(va, base="CHF")
    assert out["displayCurrency"]["fxRate"] is None
    assert "price" not in out["displayCurrency"]


def test_valuation_now_attaches_display_currency(monkeypatch):
    """The panel route must carry displayCurrency so the component can render CHF."""
    from app.routers import research as research_router
    from app.services import fx
    from app.services.fx import FxResult

    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(0.9, "cache"))
    # Stub the engine so the test needs no provider/network.
    monkeypatch.setattr(
        research_router, "value_analysis",
        lambda *a, **k: {"symbol": "AAA", "currency": "USD", "price": 100.0,
                         "fairValue": 120.0, "entryTarget": 84.0,
                         "intrinsic": {"low": 110.0, "mid": 120.0, "high": 130.0},
                         "models": {"grahamNumber": 90.0}, "marginOfSafety": 0.2,
                         "hasData": True},
    )
    monkeypatch.setattr(research_router, "resolve_verdict", lambda *a, **k: {"verdict": "hold"})
    # portfolio_fit / repo lookups are best-effort and already wrapped in try/except.
    va = research_router._valuation_now("AAA", 100.0, "USD", settings={})
    assert va["displayCurrency"]["code"] == "CHF"
    assert va["displayCurrency"]["fairValue"] == pytest.approx(108.0, abs=0.01)  # 120 × 0.9

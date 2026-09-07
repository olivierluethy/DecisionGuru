# backend/tests/test_fit_attractive.py
"""Regression for the portfolio-fit attractiveness gate.

`_is_attractive` valued the symbol with NO price, so `value_analysis` returned
marginOfSafety=None and the gate was ALWAYS False — silently killing the 'prefer ETF' /
'improves' fit outcomes and inverting the fit label for genuinely attractive names. It must
resolve a real (cached) price and pass it through."""
from __future__ import annotations

from app.services import fit
from app.services import marketdata
from app.services import valuation as val


def test_is_attractive_passes_a_real_price(monkeypatch):
    monkeypatch.setattr(fit, "get_cached_fundamentals", lambda s: {"snapshot": {"currency": "CHF"}})
    monkeypatch.setattr(marketdata, "latest_cached_close", lambda s: {"close": 42.0, "date": "2026-01-01"})
    captured: dict = {}

    def fake_va(symbol, price, currency=None, data=None, settings=None):
        captured["price"] = price
        return {"marginOfSafety": 0.2, "quality": {"score": 3, "max": 4}}

    monkeypatch.setattr(val, "value_analysis", fake_va)
    out = fit._is_attractive("XYZ", {})
    assert captured["price"] == 42.0     # the bug: this used to be None
    assert out is True                   # positive MoS + quality 3/4 -> attractive


def test_is_attractive_false_without_any_price(monkeypatch):
    # No cached price at all -> margin of safety is undefined; must NOT fabricate "attractive".
    monkeypatch.setattr(fit, "get_cached_fundamentals", lambda s: {"snapshot": {"currency": "CHF"}})
    monkeypatch.setattr(marketdata, "latest_cached_close", lambda s: None)
    called = {"va": False}

    def fake_va(*a, **k):
        called["va"] = True
        return {"marginOfSafety": None, "quality": {"score": 3, "max": 4}}

    monkeypatch.setattr(val, "value_analysis", fake_va)
    assert fit._is_attractive("XYZ", {}) is False


def test_is_attractive_false_when_overvalued(monkeypatch):
    monkeypatch.setattr(fit, "get_cached_fundamentals", lambda s: {"snapshot": {"currency": "CHF"}})
    monkeypatch.setattr(marketdata, "latest_cached_close", lambda s: {"close": 200.0, "date": "2026-01-01"})
    monkeypatch.setattr(val, "value_analysis",
                        lambda *a, **k: {"marginOfSafety": -0.3, "quality": {"score": 3, "max": 4}})
    assert fit._is_attractive("XYZ", {}) is False

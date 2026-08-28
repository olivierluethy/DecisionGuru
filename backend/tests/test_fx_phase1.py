"""Phase-1 regression tests for FX resolution (VALUE_INVESTING_AUDIT §3 F-3).

The old code returned a silent 1.0 for any unresolvable currency pair — indistinguishable
from a real 1:1 rate, mis-valuing a position with no signal. The fix: expose the
resolution source, log a warning instead of failing silently, and give critical callers a
`strict` mode that returns None rather than a fabricated rate.
"""
from __future__ import annotations

import logging

import pytest

from app.services import fx


class _FakeClient:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, *a, **k):
        raise RuntimeError("no network in tests")


@pytest.fixture
def offline(monkeypatch):
    """Force every resolution stage to miss: empty cache + no network."""
    monkeypatch.setattr(fx, "_cache_get", lambda *a, **k: None)
    monkeypatch.setattr(fx, "_cache_get_nearest", lambda *a, **k: None)
    monkeypatch.setattr(fx, "_client", lambda: _FakeClient())


def test_same_currency_is_source_same():
    r = fx.resolve_fx("CHF", "CHF", "2024-01-02")
    assert r.rate == 1.0
    assert r.source == "same"


def test_cached_hit_reports_source(monkeypatch):
    monkeypatch.setattr(fx, "_cache_get", lambda *a, **k: 0.91)
    r = fx.resolve_fx("USD", "CHF", "2024-01-02")
    assert r.rate == 0.91
    assert r.source == "cache"


def test_unresolved_strict_returns_none(offline):
    assert fx.get_fx_rate("USD", "CHF", "2024-01-02", strict=True) is None


def test_unresolved_nonstrict_returns_one_but_warns(offline, caplog):
    with caplog.at_level(logging.WARNING, logger="fx"):
        rate = fx.get_fx_rate("USD", "CHF", "2024-01-02")
    assert rate == 1.0
    assert any("USD" in rec.message and "CHF" in rec.message for rec in caplog.records), \
        "an unresolved pair must be logged, not silent"


def test_unresolved_resolve_fx_reports_unresolved_source(offline):
    r = fx.resolve_fx("USD", "CHF", "2024-01-02")
    assert r.rate is None
    assert r.source == "unresolved"


def test_same_currency_nonstrict_does_not_warn(caplog):
    with caplog.at_level(logging.WARNING, logger="fx"):
        rate = fx.get_fx_rate("CHF", "CHF", "2024-01-02")
    assert rate == 1.0
    assert not caplog.records

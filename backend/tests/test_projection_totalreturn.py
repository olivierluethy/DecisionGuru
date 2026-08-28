"""Total-return forward CAGR (VALUE_INVESTING_AUDIT register #10; brief §9, §12).

`benchmark_cagr` drove every forward projection off a dividend-blind PRICE CAGR while the
backward counterfactual was total-return — an apples-to-oranges seam. It is now
dividend-inclusive, matching the counterfactual convention, so a dividend payer's forward
growth is no longer understated.
"""
from __future__ import annotations

from app.services import projection as P


def _mk(monkeypatch, closes, divs):
    hist = [{"date": d, "close": c} for d, c in closes]
    monkeypatch.setattr(P, "get_history", lambda *a, **k: hist)
    monkeypatch.setattr(P, "get_dividends", lambda *a, **k: [{"date": d, "close": v} for d, v in divs])


def test_total_return_exceeds_price_return_for_a_dividend_payer(monkeypatch):
    _mk(monkeypatch, [("2019-01-01", 100.0), ("2024-01-01", 150.0)],
        [("2020-01-01", 5.0), ("2021-01-01", 5.0), ("2022-01-01", 5.0), ("2023-01-01", 5.0)])
    tr = P.benchmark_cagr("X", lookback_years=5)
    # price-only would be (150/100)^(1/5)-1 ≈ 0.0845; total-return adds 20 of dividends.
    assert tr is not None
    assert tr > 0.10
    assert abs(tr - ((170.0 / 100.0) ** (1 / 5) - 1)) < 0.02


def test_equals_price_return_when_no_dividends(monkeypatch):
    _mk(monkeypatch, [("2019-01-01", 100.0), ("2024-01-01", 150.0)], [])
    tr = P.benchmark_cagr("X", lookback_years=5)
    assert abs(tr - ((150.0 / 100.0) ** (1 / 5) - 1)) < 0.02


def test_none_without_enough_history(monkeypatch):
    _mk(monkeypatch, [("2024-01-01", 150.0)], [])
    assert P.benchmark_cagr("X") is None

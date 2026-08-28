"""Register #15: `reallocatableCHF` must be the capital FREED by selling (≈ proceeds), not
the after-tax gain. Selling a CHF 10'000 position frees ~CHF 10'000 to redeploy, not just
its CHF 2'000 gain (VALUE_INVESTING_AUDIT §21 / register #15).
"""
from __future__ import annotations

from app.services.recommend import freed_capital_chf


def test_freed_capital_is_value_minus_tax():
    assert freed_capital_chf(10_000.0, 0.0) == 10_000.0          # CH: CGT-free
    assert freed_capital_chf(10_000.0, 500.0) == 9_500.0


def test_freed_capital_is_not_the_gain():
    # A position worth 10'000 with a 2'000 gain frees ~10'000, not 2'000.
    assert freed_capital_chf(10_000.0, 0.0) > 2_000.0


def test_freed_capital_none_safe():
    assert freed_capital_chf(None, None) == 0.0

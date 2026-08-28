"""Phase-4: portfolio intelligence as its own decision layer (VALUE_INVESTING_AUDIT §3 F-13/F-14).

Pure, testable core of the NVIDIA-vs-NASDAQ logic: indirect (through-ETF) exposure =
holding% × ETF portfolio weight, effective = direct + indirect, and a fit decision that can
say 'prefer ETF' for an excellent asset the portfolio already owns heavily via funds — kept
distinct from whether the asset itself is attractive. Indirect exposure is honest about the
top-holdings-only bound: absence is 'unavailable', never zero-with-false-confidence.
"""
from __future__ import annotations

from app.services import portfolio_intel as PI


# --- Scenario H: indirect exposure through ETFs ---------------------------------
def test_indirect_exposure_multiplies_holding_by_etf_weight():
    etfs = [{"symbol": "QQQ", "name": "Invesco QQQ", "weight": 0.20,
             "topHoldings": [{"symbol": "NVDA", "weight": 0.08}, {"symbol": "AAPL", "weight": 0.07}]}]
    r = PI.indirect_exposure("NVDA", etfs)
    assert r["available"] is True
    assert abs(r["weight"] - 0.016) < 1e-9        # 20% × 8%
    assert r["contributors"][0]["etfSymbol"] == "QQQ"


def test_indirect_exposure_sums_across_etfs():
    etfs = [{"symbol": "QQQ", "weight": 0.20, "topHoldings": [{"symbol": "NVDA", "weight": 0.08}]},
            {"symbol": "VTI", "weight": 0.10, "topHoldings": [{"symbol": "NVDA", "weight": 0.05}]}]
    r = PI.indirect_exposure("NVDA", etfs)
    assert abs(r["weight"] - (0.016 + 0.005)) < 1e-9


def test_indirect_exposure_unavailable_is_not_zero():
    etfs = [{"symbol": "QQQ", "weight": 0.20, "topHoldings": [{"symbol": "AAPL", "weight": 0.07}]}]
    r = PI.indirect_exposure("NVDA", etfs)
    assert r["available"] is False
    assert r["weight"] is None                     # NOT 0.0 — top-holdings only
    assert r["coverage"] == "top-holdings-only"


def test_effective_exposure_adds_direct_and_indirect():
    assert abs(PI.effective_exposure(0.03, 0.016) - 0.046) < 1e-9
    assert PI.effective_exposure(0.03, None) == 0.03


# --- Scenario I: excellent asset, poor fit → prefer ETF -------------------------
def test_prefers_etf_for_excellent_asset_already_held_via_etf():
    d = PI.fit_decision(asset_attractive=True, direct_weight=0.0, indirect_weight=0.16,
                        effective=0.16, sector_weight=0.30, indirect_available=True)
    assert d["preferEtf"] is True
    assert d["status"] == "prefer-etf"


def test_improves_when_exposure_low_and_asset_attractive():
    d = PI.fit_decision(asset_attractive=True, direct_weight=0.0, indirect_weight=None,
                        effective=0.0, sector_weight=0.0, indirect_available=False)
    assert d["preferEtf"] is False
    assert d["status"] == "improves"


def test_concentrates_when_direct_exposure_already_high():
    d = PI.fit_decision(asset_attractive=True, direct_weight=0.20, indirect_weight=None,
                        effective=0.20, sector_weight=0.30, indirect_available=False)
    assert d["status"] == "concentrates"
    assert d["preferEtf"] is False


def test_unattractive_asset_is_never_a_buy_even_if_it_would_diversify():
    d = PI.fit_decision(asset_attractive=False, direct_weight=0.0, indirect_weight=None,
                        effective=0.0, sector_weight=0.0, indirect_available=False)
    assert d["status"] == "neutral"
    assert d["preferEtf"] is False

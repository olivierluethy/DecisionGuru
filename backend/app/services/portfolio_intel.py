"""Portfolio intelligence — the decision layer that keeps 'is it a good business at a good
price?' separate from 'does buying it improve THIS portfolio?' (VALUE_INVESTING_AUDIT §3
F-13/F-14, brief §18–20).

Pure, None-safe functions so the NVIDIA-vs-NASDAQ logic is deterministic and testable:
indirect (through-ETF) exposure, effective exposure, and a fit decision that can prefer the
ETF for an excellent asset the book already owns heavily via funds. Indirect exposure is
bounded by the provider's top holdings and says so — absence is 'unavailable', never
zero-with-false-confidence.
"""
from __future__ import annotations

# Effective exposure at/above this weight is "already heavily exposed".
HIGH_EXPOSURE = 0.15


def indirect_exposure(symbol: str, owned_etfs: list[dict]) -> dict:
    """Through-ETF exposure to `symbol`: Σ (holding% within the ETF × the ETF's portfolio
    weight), over each owned ETF's TOP HOLDINGS only.

    `owned_etfs`: [{symbol, name?, weight (portfolio weight 0..1),
                    topHoldings: [{symbol, weight (holding fraction 0..1)}]}].
    Returns {available, weight, coverage, contributors}. `available=False` (weight=None)
    means "not in any owned ETF's top holdings" — NOT proven zero exposure."""
    contributors: list[dict] = []
    for etf in owned_etfs or []:
        etf_w = etf.get("weight") or 0.0
        for top in etf.get("topHoldings") or []:
            if top.get("symbol") == symbol:
                contrib = (top.get("weight") or 0.0) * etf_w
                if contrib > 0:
                    contributors.append({
                        "etfSymbol": etf.get("symbol"), "etfName": etf.get("name"),
                        "viaWeight": round(contrib, 6),
                    })
    if not contributors:
        return {"available": False, "weight": None, "coverage": "top-holdings-only",
                "contributors": [], "note": "Not among any owned ETF's top holdings; "
                                            "broader constituents unavailable — may understate."}
    return {"available": True, "weight": round(sum(c["viaWeight"] for c in contributors), 6),
            "coverage": "top-holdings-only", "contributors": contributors,
            "note": "From each owned ETF's top holdings only — may understate."}


def effective_exposure(direct_weight: float | None, indirect_weight: float | None) -> float:
    """Total economic exposure = direct holding weight + estimated through-ETF weight."""
    return round((direct_weight or 0.0) + (indirect_weight or 0.0), 6)


def fit_decision(*, asset_attractive: bool, direct_weight: float | None,
                 indirect_weight: float | None, effective: float | None,
                 sector_weight: float | None, indirect_available: bool) -> dict:
    """Resolve the portfolio-fit action, held distinct from the asset's own merit.

    An excellent asset the portfolio already owns heavily THROUGH ETFs → prefer adding via
    the ETF (avoid stacking concentration); a directly-concentrated name → 'concentrates';
    low existing exposure + attractive → 'improves'; an unattractive asset is never a buy
    just because it would diversify."""
    direct_weight = direct_weight or 0.0
    indirect_weight = indirect_weight or 0.0
    effective = effective if effective is not None else effective_exposure(direct_weight, indirect_weight)

    if effective >= HIGH_EXPOSURE:
        indirect_dominant = indirect_available and indirect_weight >= direct_weight
        if indirect_dominant:
            status = "prefer-etf" if asset_attractive else "concentrates"
            note = (f"Effective exposure is already ~{effective * 100:.0f}%, mostly through "
                    f"ETFs — adding it directly stacks concentration; the ETF is the better "
                    f"expression." )
            return {"status": status, "preferEtf": True, "effective": effective, "note": note}
        return {"status": "concentrates", "preferEtf": False, "effective": effective,
                "note": f"Effective exposure is already ~{effective * 100:.0f}% — buying more "
                        f"raises concentration."}

    if sector_weight is not None and sector_weight >= 0.25:
        return {"status": "neutral", "preferEtf": False, "effective": effective,
                "note": f"Adds to an already-heavy sector ({sector_weight * 100:.0f}%)."}

    if asset_attractive:
        return {"status": "improves", "preferEtf": False, "effective": effective,
                "note": "Low existing exposure and attractive on its merits — a genuine add."}
    return {"status": "neutral", "preferEtf": False, "effective": effective,
            "note": "Not attractive enough on its own merits to add, fit aside."}

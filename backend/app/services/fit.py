"""Portfolio-fit read for a candidate symbol: does buying it actually improve THIS
portfolio? Reuses the existing exposure/allocation engines — no new data source, and it
never fabricates a percentage. Indirect exposure is limited to the provider's top-holdings
slice (all we have); a name outside every owned ETF's top holdings is reported as
'indirect unavailable', not zero-with-false-confidence.
"""
from __future__ import annotations

from . import repo
from .exposure import portfolio_exposure
from .allocation import build_allocation
from .fundamentals import get_cached_fundamentals
from ..reference import geo


def _sector_of(symbol: str) -> str | None:
    cached = get_cached_fundamentals(symbol)
    snap = (cached or {}).get("snapshot") or {}
    return snap.get("sector")


def portfolio_fit(symbol: str, settings: dict) -> dict:
    owned = repo.owned_symbol_set()
    exposure = portfolio_exposure(settings)            # value-weighted, held only
    holdings = exposure.get("holdings", [])            # [{instrumentId,symbol,name,weight,valueCHF}]
    weight_by_symbol = {h["symbol"]: h.get("weight", 0.0) for h in holdings}

    is_owned = symbol in owned
    direct_weight = weight_by_symbol.get(symbol, 0.0) if is_owned else 0.0

    # Indirect: for each owned ETF, does the candidate appear in its top holdings?
    instruments = {i["symbol"]: i for i in repo.list_instruments() if i.get("symbol")}
    contributors: list[dict] = []
    for h in holdings:
        inst = instruments.get(h["symbol"])
        if not inst or inst.get("kind") != "etf":
            continue
        alloc = build_allocation(inst)                 # cached fund summary → topHoldings
        for top in alloc.get("topHoldings", []):
            if top.get("symbol") and top["symbol"] == symbol:
                contrib = (top.get("weight") or 0.0) * (h.get("weight") or 0.0)
                if contrib > 0:
                    contributors.append({
                        "etfSymbol": h["symbol"], "etfName": h.get("name"),
                        "viaWeight": round(contrib, 4),
                    })
    indirect_available = bool(contributors)
    indirect_weight = round(sum(c["viaWeight"] for c in contributors), 4) if indirect_available else None
    effective = round(direct_weight + (indirect_weight or 0.0), 4) if indirect_available else direct_weight

    # Diversification: candidate sector vs the portfolio's sector rollup.
    cand_sector = _sector_of(symbol)
    pf_sectors = {s["label"].lower(): s["weight"] for s in exposure.get("sectors", []) if s.get("label")}
    sector_weight = pf_sectors.get(cand_sector.lower(), 0.0) if cand_sector else None
    if cand_sector is None:
        div_status, div_note = "unknown", "Sector unavailable — cannot assess diversification."
    elif sector_weight == 0.0:
        div_status, div_note = "diversifies", f"New sector for this portfolio ({cand_sector})."
    elif sector_weight < 0.25:
        div_status, div_note = "neutral", f"Adds to an existing {cand_sector} weight ({sector_weight * 100:.0f}%)."
    else:
        div_status, div_note = "concentrates", f"Already heavy in {cand_sector} ({sector_weight * 100:.0f}%)."

    high = effective is not None and effective >= 0.15
    concentration_note = (
        f"Effective exposure is already ~{effective * 100:.0f}% — buying more raises concentration."
        if (high and (is_owned or indirect_available)) else None
    )

    return {
        "symbol": symbol,
        "owned": is_owned,
        "directWeight": round(direct_weight, 4),
        "country": geo.country_from_symbol(symbol),
        "sector": cand_sector,
        "indirect": (
            {"available": True, "weight": indirect_weight, "coverage": "top-holdings-only",
             "note": "From each owned ETF's top holdings only — may understate.",
             "contributors": contributors}
            if indirect_available else
            {"available": False,
             "note": "Not among any owned ETF's top holdings; broader constituents unavailable."}
        ),
        "effectiveExposure": effective,
        "diversification": {"status": div_status, "sectorWeight": sector_weight, "note": div_note},
        "concentrationNote": concentration_note,
    }

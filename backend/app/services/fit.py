"""Portfolio-fit read for a candidate symbol: does buying it actually improve THIS
portfolio? Reuses the exposure/allocation engines and the pure `portfolio_intel` decision
layer — no new data source, and it never fabricates a percentage. Indirect exposure is
limited to the provider's top-holdings slice (all we have); a name outside every owned ETF's
top holdings is reported as 'indirect unavailable', not zero-with-false-confidence.

Asset quality/valuation and portfolio fit are kept DISTINCT (AUDIT §3 F-13): this module
answers only "does it fit?"; whether the asset itself is attractive is a separate input.
"""
from __future__ import annotations

from . import repo
from . import portfolio_intel as pi
from .exposure import portfolio_exposure
from .allocation import build_allocation
from .fundamentals import get_cached_fundamentals
from ..reference import geo


def _sector_of(symbol: str) -> str | None:
    cached = get_cached_fundamentals(symbol)
    snap = (cached or {}).get("snapshot") or {}
    return snap.get("sector")


def _is_attractive(symbol: str, settings: dict) -> bool:
    """Cheap attractiveness read from cached data only (no provider call): a positive margin of
    safety and non-weak quality. Used to gate the 'prefer ETF' fit decision.

    Needs a price — `value_analysis` returns marginOfSafety=None without one, which made this
    silently ALWAYS False (killing 'prefer ETF'/'improves' and inverting the fit label for
    genuinely attractive names). We resolve the most recent cached close (a DB read, still no
    provider call); with no price anywhere the margin of safety is undefined, so we abstain
    (False) rather than fabricate 'attractive'."""
    cached = get_cached_fundamentals(symbol)
    if not cached or not (cached.get("snapshot")):
        return False
    from .valuation import value_analysis  # lazy — avoids import cycle
    from .marketdata import latest_cached_close
    close = latest_cached_close(symbol)
    price = close["close"] if close else None
    if not price or price <= 0:
        return False
    va = value_analysis(symbol, price, (cached.get("snapshot") or {}).get("currency"),
                        data=cached, settings=settings)
    mos = va.get("marginOfSafety")
    q = va.get("quality") or {}
    q_ok = bool(q.get("max")) and (q["score"] / q["max"]) >= 0.5
    return bool(mos is not None and mos > 0 and q_ok)


def portfolio_fit(symbol: str, settings: dict, asset_attractive: bool | None = None) -> dict:
    owned_syms = repo.owned_symbol_set()
    owned_isins = repo.owned_isin_set()
    exposure = portfolio_exposure(settings)            # value-weighted, held only
    holdings = exposure.get("holdings", [])            # [{instrumentId,symbol,name,weight,valueCHF}]
    weight_by_symbol = {h["symbol"]: h.get("weight", 0.0) for h in holdings}
    instruments = {i["symbol"]: i for i in repo.list_instruments() if i.get("symbol")}

    cand_isin = (instruments.get(symbol) or {}).get("isin")
    is_owned = repo.is_owned(symbol, isin=cand_isin, owned_symbols=owned_syms, owned_isins=owned_isins)
    direct_weight = weight_by_symbol.get(symbol, 0.0) if is_owned else 0.0

    # Through-ETF exposure: each owned ETF's portfolio weight × the candidate's holding weight
    # inside it (top holdings only). Delegated to the pure, tested decision layer.
    owned_etfs: list[dict] = []
    for h in holdings:
        inst = instruments.get(h["symbol"])
        if not inst or inst.get("kind") != "etf":
            continue
        alloc = build_allocation(inst)
        tops = [{"symbol": t.get("symbol"), "weight": t.get("weight")}
                for t in alloc.get("topHoldings", []) if t.get("symbol")]
        owned_etfs.append({"symbol": h["symbol"], "name": h.get("name"),
                           "weight": h.get("weight") or 0.0, "topHoldings": tops})

    indirect = pi.indirect_exposure(symbol, owned_etfs)
    indirect_weight = indirect["weight"]
    effective = pi.effective_exposure(direct_weight, indirect_weight)

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

    if asset_attractive is None:
        asset_attractive = _is_attractive(symbol, settings)
    decision = pi.fit_decision(
        asset_attractive=asset_attractive, direct_weight=direct_weight,
        indirect_weight=indirect_weight, effective=effective,
        sector_weight=sector_weight, indirect_available=indirect["available"],
    )

    high = effective is not None and effective >= 0.15
    concentration_note = (
        f"Effective exposure is already ~{effective * 100:.0f}% — buying more raises concentration."
        if (high and (is_owned or indirect["available"])) else None
    )

    return {
        "symbol": symbol,
        "owned": is_owned,
        "directWeight": round(direct_weight, 4),
        "country": geo.country_from_symbol(symbol),
        "sector": cand_sector,
        "indirect": (
            {"available": True, "weight": indirect_weight, "coverage": "top-holdings-only",
             "note": indirect["note"], "contributors": indirect["contributors"]}
            if indirect["available"] else
            {"available": False, "note": indirect["note"]}
        ),
        "effectiveExposure": effective,
        "diversification": {"status": div_status, "sectorWeight": sector_weight, "note": div_note},
        "fitDecision": decision,   # the distinct portfolio-fit action (improves/neutral/concentrates/prefer-etf)
        "concentrationNote": concentration_note,
    }

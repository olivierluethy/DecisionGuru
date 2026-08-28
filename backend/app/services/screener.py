"""Undervalued-stock screener.

Screens (curated seed ∪ holdings ∪ watchlist) using the existing value-investing
engine (Graham/Buffett intrinsic value + quality). Scoring runs off *cached*
fundamentals so the screen itself never blocks on the provider; the cache for the
whole universe is filled separately by the controlled background warmer
(`services/screener_warm.py`), so a missing cache entry is a "not fetched yet",
never a permanent "excluded". Cache = performance optimisation, not eligibility.

Each scored name gets:
  - a value read (margin of safety vs intrinsic mid, Graham/DCF models, quality),
  - a portfolio-fit read (does its sector diversify or concentrate your book),
  - a combined *attractiveness* (0–100) blending valuation, quality, supportable
    return and fit, and a *verdict* that separates genuinely attractive from merely
    cheap — a low-quality bargain is flagged 'cheap-only', not recommended.
"""
from __future__ import annotations

from datetime import date

from . import repo
from ..core.db import get_state
from .watchlist import list_watchlist
from .fundamentals import get_cached_fundamentals
from .valuation import value_analysis
from .verdict import resolve_verdict
from .marketdata import price_on
from .exposure import portfolio_exposure
from ..reference import geo
from ..reference.themes import classify_theme
from ..reference.universe import UNIVERSE_SEED


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _fit(sector: str | None, pf_sectors: dict[str, float]) -> tuple[str, float, float]:
    """Portfolio-diversification read for a candidate's sector.
    Returns (status, current portfolio weight in that sector, fit bonus 0..1)."""
    if not sector:
        return "unknown", 0.0, 0.4
    w = pf_sectors.get(sector.lower(), 0.0)
    if w == 0.0:
        return "new sector", 0.0, 1.0
    if w < 0.10:
        return "diversifies", w, 0.7
    if w < 0.25:
        return "neutral", w, 0.4
    return "concentrates", w, 0.0


def _attractiveness(mos: float | None, quality_frac: float, supportable: float | None,
                    fit_bonus: float) -> int:
    """Blend valuation, quality, supportable return and portfolio fit into 0..100."""
    # Valuation: margin of safety mapped from [-50%, +50%] → [0, 1].
    val_score = (_clamp(mos, -0.5, 0.5) + 0.5) if mos is not None else 0.3
    ret_score = _clamp((supportable or 0.0) / 0.15, 0.0, 1.0)  # 15%+ supportable = full marks
    score = 0.45 * val_score + 0.30 * quality_frac + 0.20 * ret_score + 0.05 * fit_bonus
    return round(_clamp(score, 0.0, 1.0) * 100)


def screen_universe(settings: dict) -> dict:
    holdings = {i["symbol"]: i for i in repo.list_instruments() if i.get("symbol")}
    watch = {w["symbol"]: w for w in list_watchlist() if w.get("symbol")}

    # Preserve a stable order: seed first, then any extra held/watched names.
    universe: list[str] = list(dict.fromkeys([*UNIVERSE_SEED, *holdings.keys(), *watch.keys()]))

    # Value-weighted portfolio sector weights for the diversification read.
    try:
        exposure = portfolio_exposure(settings)
        pf_sectors = {s["label"].lower(): s["weight"] for s in exposure.get("sectors", []) if s.get("label")}
    except Exception:  # noqa: BLE001 — screening must never fail on an exposure hiccup
        pf_sectors = {}

    today = date.today().isoformat()
    rows: list[dict] = []
    unanalysed: list[str] = []
    sectors_present: set[str] = set()

    for sym in universe:
        cached = get_cached_fundamentals(sym)
        snap = (cached or {}).get("snapshot")
        if not cached or not snap:
            unanalysed.append(sym)
            continue

        price = price_on(sym, today)
        va = value_analysis(sym, price, snap.get("currency"), data=cached, settings=settings)
        if not va.get("hasData"):
            unanalysed.append(sym)
            continue

        sector = va.get("sector")
        industry = snap.get("industry")
        theme = classify_theme(sector, industry)
        if sector:
            sectors_present.add(sector)
        mos = va.get("marginOfSafety")
        quality = va.get("quality") or {"score": 0, "max": 1}
        quality_frac = (quality["score"] / quality["max"]) if quality.get("max") else 0.0
        supportable = va.get("supportableReturn")
        fit_status, fit_weight, fit_bonus = _fit(sector, pf_sectors)
        # One canonical verdict from the shared engine (valuation-only for a candidate —
        # not held, so no benchmark performance). Discover shows this, never a fork.
        rec = resolve_verdict(va, held=False)

        rows.append({
            "symbol": sym,
            "name": (holdings.get(sym, {}).get("name")
                     or watch.get(sym, {}).get("name")
                     or snap.get("name")),
            "sector": sector,
            "industry": industry,
            "theme": theme,
            "price": price,
            "currency": va.get("currency"),
            "marginOfSafety": mos,
            "fairValue": va.get("fairValue"),
            "entryTarget": va.get("entryTarget"),
            "band": (va.get("band") or {}).get("band"),
            "bandLabel": (va.get("band") or {}).get("label"),
            "country": geo.country_from_symbol(sym) or geo.country_from_isin(
                (holdings.get(sym, {}) or {}).get("isin")),
            "intrinsicMid": (va.get("intrinsic") or {}).get("mid"),
            "quality": quality,
            "supportableReturn": supportable,
            "dividendYield": va.get("dividendYield"),
            "impliedGrowth": va.get("impliedGrowth"),
            "confidence": va.get("confidence"),
            "attractiveness": _attractiveness(mos, quality_frac, supportable, fit_bonus),
            "verdict": rec["verdict"],          # canonical: 'buy-more' | 'hold' | 'sell'
            "recommendation": rec,              # full engine output (rationale, drivers, …)
            "portfolioFit": {"status": fit_status, "sectorWeight": fit_weight},
            "inPortfolio": sym in holdings,
            "onWatchlist": sym in watch,
        })

    rows.sort(key=lambda r: (r["attractiveness"], (r["marginOfSafety"] or -1)), reverse=True)

    # Merge the "freshly attractive / mover" flags the last scan persisted (diff vs the
    # previous scan). Names not in the movers map simply carry no flags.
    movers = get_state("scan.movers") or {}
    for r in rows:
        m = movers.get(r["symbol"])
        r["isNew"] = bool(m and m.get("isNew"))
        r["priceChangePct"] = (m or {}).get("priceChangePct")
        r["becameAttractiveAt"] = (m or {}).get("becameAttractiveAt")

    themes = sorted({r["theme"] for r in rows if r.get("theme")})
    return {
        "universeSize": len(universe),
        "analysedCount": len(rows),
        "unanalysedCount": len(unanalysed),
        "unanalysed": unanalysed,
        "sectors": sorted(sectors_present),
        "themes": themes,
        "rows": rows,
        "geo": _geo_density(rows),
    }


def _geo_density(rows: list[dict]) -> list[dict]:
    """Opportunity density per country for the Discover world map: how many attractive
    names sit in each market and their average margin of safety, with a centroid so a
    cobe/marker map can size a point by it. Only genuinely attractive names count toward
    density; the drill-in list keeps every scored name in that country."""
    by_country: dict[str, dict] = {}
    for r in rows:
        cc = r.get("country")
        if not cc:
            continue
        coord = geo.COUNTRY_COORDS.get(cc)
        bucket = by_country.setdefault(cc, {
            "country": cc,
            "name": (coord or {}).get("name", cc),
            "lat": (coord or {}).get("lat"),
            "lng": (coord or {}).get("lng"),
            "attractiveCount": 0,
            "totalCount": 0,
            "mosSum": 0.0,
            "topSymbols": [],
        })
        bucket["totalCount"] += 1
        mos = r.get("marginOfSafety")
        if r.get("verdict") == "buy-more":
            bucket["attractiveCount"] += 1
            if mos is not None:
                bucket["mosSum"] += max(mos, 0.0)
        bucket["topSymbols"].append(r["symbol"])

    out: list[dict] = []
    for cc, b in by_country.items():
        avg_mos = round(b["mosSum"] / b["attractiveCount"], 4) if b["attractiveCount"] else 0.0
        out.append({
            "country": cc,
            "name": b["name"],
            "lat": b["lat"],
            "lng": b["lng"],
            "attractiveCount": b["attractiveCount"],
            "totalCount": b["totalCount"],
            "avgMarginOfSafety": avg_mos,
            # Density = attractive names weighted by their average discount to fair value.
            "density": round(b["attractiveCount"] * (1 + avg_mos), 3),
            "topSymbols": b["topSymbols"][:8],
        })
    out.sort(key=lambda c: (c["density"], c["attractiveCount"]), reverse=True)
    return out

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
    return and fit (kept as a ranking score), and
  - the single canonical *verdict* from services/verdict.py (Buy more / Hold / Sell) —
    the same one every other view shows. Being cheap is never enough: a low-quality
    bargain reads Hold (a value trap), not Buy more.
"""
from __future__ import annotations

from datetime import date

from . import repo
from ..core.db import get_state
from .watchlist import list_watchlist
from .fundamentals import get_cached_fundamentals
from .valuation import value_analysis
from .verdict import resolve_verdict
from .marketdata import price_on, resolve_price
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


_QUALITY_WEIGHT = {"strong": 1.0, "adequate": 0.6, "weak": 0.2, "unknown": 0.4}
_CONF_FACTOR = {"high": 1.0, "medium": 0.85, "low": 0.6}


def discover_attractiveness(*, margin_of_safety: float | None, quality_rating: str | None,
                            expected_return: float | None, fit_bonus: float | None,
                            confidence: str | None, data_sufficient: bool,
                            reliability_tier: int | None = 1) -> int:
    """Rank an opportunity 0..100 on merit ONLY — valuation, business quality, expected
    return and portfolio-diversification fit — then SCALE by data confidence so a deep
    discount on unreliable data cannot outrank a moderate discount on robust data (brief
    §22, §30 Phase 6). An INSUFFICIENT-DATA name is sunk. Ownership is deliberately not an
    input: it only rewords the action elsewhere, never the score.

    Area 4 — the score gates on a REAL margin of safety: a fairly- or over-priced name is
    not an opportunity (good quality never substitutes for a discount), and an assumption-
    sensitive (tier-2) discount is sunk like insufficient data — no BUY, and no high rank,
    may rest on a credited growth assumption."""
    val = (_clamp(margin_of_safety, -0.5, 0.5) + 0.5) if margin_of_safety is not None else 0.3
    q = _QUALITY_WEIGHT.get(quality_rating or "unknown", 0.4)
    ret = _clamp((expected_return or 0.0) / 0.15, 0.0, 1.0)   # 15%+ supportable = full marks
    fit = _clamp(fit_bonus or 0.0, 0.0, 1.0)
    blend = 0.40 * val + 0.30 * q + 0.20 * ret + 0.10 * fit
    conf_factor = _CONF_FACTOR.get(confidence or "low", 0.6)
    if not data_sufficient:
        conf_factor = min(conf_factor, 0.30)   # no reliable valuation → sink it
    if margin_of_safety is None or margin_of_safety <= 0:
        conf_factor = min(conf_factor, 0.30)   # no genuine discount → not an opportunity
    if reliability_tier is not None and reliability_tier != 1:
        conf_factor = min(conf_factor, 0.30)   # assumption-sensitive discount → sink it
    return round(_clamp(blend * conf_factor, 0.0, 1.0) * 100)


def screen_universe(settings: dict) -> dict:
    owned = repo.owned_symbol_set()
    owned_isins = repo.owned_isin_set()   # company-identity ownership across listings (F-12)
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

        # Value at the SAME resolved live/last price the position detail uses, so Discover and
        # Decisions can't straddle a fair-value band edge on two different prices (register #14).
        price = resolve_price(sym, snap.get("currency")).get("price") or price_on(sym, today)
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
        supportable = va.get("supportableReturn")
        fit_status, fit_weight, fit_bonus = _fit(sector, pf_sectors)
        # One canonical verdict from the shared engine. `held` drives ownership-aware
        # wording (owned → Buy more; not owned → Buy) — valuation-only either way, since a
        # candidate carries no benchmark performance. Discover shows this, never a fork.
        held = repo.is_owned(sym, isin=(holdings.get(sym, {}) or {}).get("isin"),
                             owned_symbols=owned, owned_isins=owned_isins)
        rec = resolve_verdict(va, held=held)

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
            "confidence": rec.get("confidence"),
            "attractiveness": discover_attractiveness(
                margin_of_safety=mos,
                quality_rating=(rec.get("dimensions") or {}).get("quality", {}).get("rating"),
                expected_return=supportable, fit_bonus=fit_bonus,
                confidence=rec.get("confidence"), data_sufficient=rec.get("dataSufficient", True),
                reliability_tier=va.get("reliabilityTier")),
            "verdict": rec["verdict"],          # canonical: 'buy-more' | 'hold' | 'sell'
            "recommendation": rec,              # full engine output (rationale, drivers, …)
            "portfolioFit": {"status": fit_status, "sectorWeight": fit_weight},
            "inPortfolio": held,
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

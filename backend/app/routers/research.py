from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..core.errors import ApiError
from ..services.research import research_asset, validate_claim
from ..services.fundamentals import fundamentals_bundle
from ..services.valuation import value_analysis
from ..services.universal import universal_compare
from ..services.projection import prospective_projection
from ..services.competitors import competitors as competitors_service

router = APIRouter()


@router.get("/asset/{symbol:path}")
async def asset(symbol: str, window: float = 5) -> dict:
    settings = get_settings()
    return await run_in_threadpool(research_asset, symbol, settings, window, True)


@router.get("/fundamentals/{symbol:path}")
async def fundamentals(symbol: str, domicile: str | None = None, name: str | None = None) -> dict:
    """Valuation + profitability snapshot, multi-year income statement, and (for Swiss
    blue chips) the SMI index weight. First call per symbol is slow (Yahoo scrape); cached after."""
    return await run_in_threadpool(fundamentals_bundle, symbol, name, domicile)


@router.get("/valuation/{symbol:path}")
async def valuation(
    symbol: str,
    price: float | None = None,
    currency: str | None = None,
    asOf: str | None = None,
) -> dict:
    """Intrinsic-value estimates, fair-value bands, an attractive entry target, and a
    Buffett-style quality scorecard — from cached fundamentals with the user's margin of
    safety / discount rate. Estimates only, not advice.

    When `asOf` (YYYY-MM-DD) is given, this is a point-in-time replay: the security is
    valued against its price on that date (last-available fundamentals), returning the
    band verdict then and the hypothetical price return since. Fundamentals are today's
    best-available snapshot (the provider has no historical statements here), so the
    replay is flagged accordingly."""
    settings = get_settings()
    if asOf:
        return await run_in_threadpool(_valuation_as_of, symbol, asOf, currency, settings)
    return await run_in_threadpool(value_analysis, symbol, price, currency, None, settings)


def _valuation_as_of(symbol: str, as_of: str, currency: str | None, settings: dict) -> dict:
    """Point-in-time replay: value the security at its price on `as_of`, then report the
    band verdict then plus the hypothetical price return between then and today."""
    from ..services.marketdata import price_on, get_quote

    hist_price = price_on(symbol, as_of)
    va = value_analysis(symbol, hist_price, currency, None, settings)
    quote = get_quote(symbol) or {}
    now_price = quote.get("price")
    since_return = (
        round(now_price / hist_price - 1, 4)
        if (now_price and hist_price and hist_price > 0)
        else None
    )
    va["asOf"] = as_of
    va["asOfPrice"] = hist_price
    va["currentPrice"] = now_price
    va["hypotheticalReturnSince"] = since_return
    va["asOfNote"] = (
        "Valued against the price on this date using today's best-available fundamentals — "
        "the data provider has no point-in-time financial statements, so the fundamentals are "
        "current, not as-of. Read the verdict as indicative."
    )
    return va


@router.get("/projection/{symbol:path}")
async def projection(
    symbol: str,
    benchmark: str = "VWRL.SW",
    amount: float = 10_000.0,
    years: float = 5.0,
    stockCagr: float | None = None,
    etfCagr: float | None = None,
) -> dict:
    """Forward opportunity cost of investing a hypothetical amount in this symbol today
    vs the same money in an ETF benchmark — the future-oriented lens for prospective buys.
    Expected growth defaults to each asset's own historical CAGR (flagged when assumed)."""
    return await run_in_threadpool(
        prospective_projection, symbol, benchmark, amount, years, stockCagr, etfCagr
    )


@router.get("/competitors/{symbol:path}")
async def competitors(symbol: str) -> dict:
    """Same-sector peers (from cached fundamentals) ranked by market cap, so you can see
    where a company sits by size and valuation within its sector."""
    return await run_in_threadpool(competitors_service, symbol)


@router.post("/claim")
async def claim(request: Request) -> dict:
    body = await request.json() or {}
    symbol = (body.get("symbol") or "").strip()
    if not symbol:
        raise ApiError("A symbol is required", 400)
    settings = get_settings()
    return await run_in_threadpool(validate_claim, symbol, body.get("claim"), settings)


@router.post("/compare")
async def compare(request: Request) -> dict:
    body = await request.json() or {}
    entities = body.get("entities") or []
    window = float(body.get("windowYears") or 5)
    if not entities:
        raise ApiError("At least one entity is required", 400)
    settings = get_settings()
    return await run_in_threadpool(universal_compare, entities, settings, window)

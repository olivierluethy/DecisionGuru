from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..core.errors import ApiError
from ..services.research import research_asset, validate_claim
from ..services.fundamentals import fundamentals_bundle
from ..services.valuation import value_analysis
from ..services.verdict import resolve_verdict
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
    return await run_in_threadpool(_valuation_now, symbol, price, currency, settings)


def _valuation_now(symbol: str, price: float | None, currency: str | None,
                   settings: dict) -> dict:
    """Value at the current price, resolving a real last price server-side when the
    caller has none. Guarantees the fair-value band, margin-of-safety verdict and the
    price-zone chart compute for every asset — including closed-market names whose live
    quote is momentarily 0 — instead of collapsing to a blank band on a null price."""
    from ..services.marketdata import resolve_price

    freshness = None
    price_as_of = None
    if price is None or price <= 0:
        resolved = resolve_price(symbol, currency)
        price = resolved["price"]
        currency = currency or resolved["currency"]
        freshness, price_as_of = resolved["freshness"], resolved["asOf"]
    va = value_analysis(symbol, price, currency, None, settings)
    from ..services.valuation import attach_display_currency
    attach_display_currency(va, base="CHF")
    if freshness is not None:
        va["priceFreshness"] = freshness
        va["priceAsOf"] = price_as_of
    # Same shared verdict every surface renders (valuation-only for a researched name),
    # but ownership-aware (by ISIN, so a cross-listing of a held name still reads "Buy more")
    # and portfolio-fit-aware, so an excellent buy already held heavily via ETFs can read
    # "Prefer ETF" (Engine 2.0). Fit is best-effort — a hiccup never blanks the analysis.
    from ..services import repo
    inst = repo.get_instrument_by_symbol(symbol)
    held = repo.is_owned(symbol, isin=(inst or {}).get("isin"))
    fit = None
    try:
        from ..services.fit import portfolio_fit
        fit = portfolio_fit(symbol, settings)
    except Exception:  # noqa: BLE001
        fit = None
    rec = resolve_verdict(va, held=held, fit=fit)
    va["verdict"] = rec["verdict"]
    va["recommendation"] = rec
    va["portfolioFit"] = fit
    return va


def _valuation_as_of(symbol: str, as_of: str, currency: str | None, settings: dict) -> dict:
    """Point-in-time replay: value the security at its price on `as_of`, then report the
    band verdict then plus the hypothetical price return between then and today."""
    from ..services.marketdata import price_on, get_quote

    hist_price = price_on(symbol, as_of)
    va = value_analysis(symbol, hist_price, currency, None, settings)
    rec = resolve_verdict(va, held=False)
    va["verdict"] = rec["verdict"]
    va["recommendation"] = rec
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
    """Comparable companies — same competitive market (sector + industry), from cached
    fundamentals — ranked by CHF-normalised market cap, so you can see where a company sits by
    size and valuation among its actual peers."""
    return await run_in_threadpool(competitors_service, symbol)


@router.get("/market/{symbol:path}")
async def market(symbol: str, range: str = "1Y", compare: str | None = None) -> dict:
    """Market analysis: sector/broad-benchmark/competitor performance + a market-vs-company
    read + the valuation tie-in, so the user can tell company-specific weakness from a weak
    market. Cached-only reads. `compare` is a comma-separated list of comparison symbols
    (any ETF or company, any market); omitted falls back to the broad-market defaults."""
    from ..services.market_analysis import market_analysis
    settings = get_settings()
    compare_list = [s.strip() for s in compare.split(",") if s.strip()] if compare else None
    return await run_in_threadpool(market_analysis, symbol, range, settings, compare_list)


@router.get("/market-combos/{symbol:path}")
async def market_combos_route(symbol: str, years: int = 5) -> dict:
    """Was holding this ONE company the best you could have done in its market, or would a
    mix with a competitor — at which split — have beaten it? Sweeps single/pair/triple mixes
    on a 10% grid with annual rebalancing over the trailing window, from cached closes only.
    Backward-looking and price-return only; never a forecast."""
    from ..services.market_combos import market_combos
    return await run_in_threadpool(market_combos, symbol, years)


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

from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings, save_settings
from ..core.errors import ApiError
from ..services import account as acct
from ..services import advisory as adv
from ..services import refresh, repo
from ..services.analytics import aggregate_counterfactuals
from ..services.counterfactual import compute_counterfactual
from ..services.finance import build_position
from ..services.fundamentals import get_cached_fundamentals
from ..services.signals import sell_signal_for
from ..services.verdict import verdict_for, performance_from_counterfactual
from ..services.history import instrument_series, portfolio_series
from ..services.timeline import build_timeline
from ..services.projection import benchmark_cagr, compute_break_even, project_hold_vs_etf
from ..services.whatif import compute_whatif_sale
from ._util import bool_param

router = APIRouter()


@router.get("/position/{instrument_id}")
async def position(instrument_id: int, preTax: str = "false") -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Instrument not found", 404)
    settings = get_settings()
    pre_tax = bool_param(preTax)
    built = await run_in_threadpool(
        build_position, inst, repo.get_transactions(inst["id"]), settings["tax"], pre_tax
    )
    position = built["position"]
    # Overlay account-statement dividends for this security (source of truth), if any.
    if inst.get("isin"):
        today = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
        div = acct.dividends_by_isin(repo.all_account_events(), today).get(inst["isin"])
        if div:
            position["netDividendsCHF"] = div["netCHF"]
            position["accountDividends"] = div
        else:
            position["netDividendsCHF"] = position["dividends"]["netAfterTaxCHF"]
    else:
        position["netDividendsCHF"] = position["dividends"]["netAfterTaxCHF"]
    # Valuation-driven sell signal (None unless it's (significantly) overvalued vs fair value).
    cached = get_cached_fundamentals(inst["symbol"])
    position["sellSignal"] = sell_signal_for(position, cached, settings)
    # Unified verdict (same engine every view uses): valuation + fundamentals + performance
    # vs the default benchmark. Underperformance alone never yields a Sell.
    if position.get("openQuantity", 0) > 0:
        cf = await run_in_threadpool(
            compute_counterfactual, inst, repo.get_transactions(inst["id"]),
            settings["defaultBenchmarkSymbol"], settings, pre_tax)
        # Portfolio-fit (best-effort) so the verdict is fit-aware (e.g. PREFER ETF / already
        # heavily exposed via ETFs); a fit hiccup never blocks the position verdict.
        fit = None
        try:
            from ..services.fit import portfolio_fit
            fit = await run_in_threadpool(portfolio_fit, inst["symbol"], settings)
        except Exception:  # noqa: BLE001
            fit = None
        position["portfolioFit"] = fit
        position["verdict"] = verdict_for(
            inst["symbol"], position.get("currentPrice"), inst.get("currency"), cached, settings,
            performance=performance_from_counterfactual(cf), held=True, position=position, fit=fit)
    return position


@router.get("/counterfactual/{instrument_id}")
async def counterfactual(instrument_id: int, preTax: str = "false", benchmark: str | None = None) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Instrument not found", 404)
    settings = get_settings()
    bench = benchmark or settings["defaultBenchmarkSymbol"]
    pre_tax = bool_param(preTax)
    return await run_in_threadpool(
        compute_counterfactual, inst, repo.get_transactions(inst["id"]), bench, settings, pre_tax
    )


@router.get("/breakeven/{instrument_id}")
async def breakeven(instrument_id: int, benchmark: str | None = None) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Instrument not found", 404)
    settings = get_settings()
    bench = benchmark or settings["defaultBenchmarkSymbol"]

    def _work() -> dict:
        built = build_position(inst, repo.get_transactions(inst["id"]), settings["tax"])
        etf_cagr = benchmark_cagr(bench)
        if etf_cagr is None:
            etf_cagr = 0.06
        result = compute_break_even(
            built["position"]["currentValueCHF"] or 0, built["position"]["investedCHF"], etf_cagr
        )
        return {**result, "benchmark": bench}

    return await run_in_threadpool(_work)


@router.get("/projection/{instrument_id}")
async def projection(instrument_id: int, benchmark: str | None = None, years: float = 5,
                     stockCagr: float | None = None, etfCagr: float | None = None) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Instrument not found", 404)
    settings = get_settings()
    bench = benchmark or settings["defaultBenchmarkSymbol"]

    def _work() -> dict:
        built = build_position(inst, repo.get_transactions(inst["id"]), settings["tax"])
        etf_c = etfCagr if etfCagr is not None else (benchmark_cagr(bench) or 0.06)
        stock_c = stockCagr if stockCagr is not None else (built["position"]["metrics"]["cagr"] or etf_c)
        result = project_hold_vs_etf(built["position"]["currentValueCHF"] or 0, stock_c, etf_c, years)
        return {**result, "benchmark": bench}

    return await run_in_threadpool(_work)


@router.get("/whatif/{instrument_id}")
async def whatif_sale(instrument_id: int, benchmark: str | None = None,
                      saleDate: str | None = None, salePrice: float | None = None,
                      reinvestAmount: float | None = None, preTax: str = "false",
                      years: float = 5) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Instrument not found", 404)
    settings = get_settings()
    bench = benchmark or settings["defaultBenchmarkSymbol"]
    pre_tax = bool_param(preTax)

    def _work() -> dict:
        return compute_whatif_sale(
            inst, repo.get_transactions(inst["id"]), bench, settings,
            sale_date=saleDate, sale_price=salePrice,
            reinvest_amount_chf=reinvestAmount, pre_tax=pre_tax, forward_years=years,
        )

    return await run_in_threadpool(_work)


@router.get("/reinvest/{instrument_id}")
async def reinvest(instrument_id: int, amount: float | None = None, range: str = "1Y") -> dict:
    """Should the next franc go into this holding, or into a competitor in the same market?

    A Hold/Buy-more verdict says the stock is worth owning, not that it is the best home for
    new money. Returns where it ranks among its actual peers on value and growth strength,
    what topping up does to concentration, what the amount would have done here versus in
    each peer, and — against your own cost basis — what buying during a past buy-zone window
    would have been worth. Cached reads only; backward-looking figures are labelled as such."""
    from ..services.reinvest import reinvest_check
    if not repo.get_instrument(instrument_id):
        raise ApiError("Instrument not found", 404)
    settings = get_settings()
    return await run_in_threadpool(reinvest_check, instrument_id, amount, settings, range)


@router.get("/dividend-shock/{instrument_id}")
async def dividend_shock(instrument_id: int, cut: float = 1) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Instrument not found", 404)
    settings = get_settings()
    cut = min(max(cut, 0), 1)

    def _work() -> dict:
        built = build_position(inst, repo.get_transactions(inst["id"]), settings["tax"])
        p = built["position"]
        current_annual_gross = (
            p["metrics"]["currentYield"] * p["currentValueCHF"]
            if (p["metrics"]["currentYield"] and p["currentValueCHF"]) else 0
        )
        shocked = current_annual_gross * (1 - cut)
        marginal = settings["tax"]["marginalIncomeRate"]
        return {
            "currentAnnualGrossCHF": current_annual_gross,
            "shockedAnnualGrossCHF": shocked,
            "lostGrossCHF": current_annual_gross - shocked,
            "lostNetAfterTaxCHF": (current_annual_gross - shocked) * (1 - marginal),
            "cut": cut,
        }

    return await run_in_threadpool(_work)


@router.post("/compare")
async def compare(request: Request) -> dict:
    body = await request.json() or {}
    settings = get_settings()
    pre_tax = bool_param(body.get("preTax"))
    ids = body.get("instrumentIds") if isinstance(body.get("instrumentIds"), list) else []
    benchmarks = (
        body["benchmarks"] if isinstance(body.get("benchmarks"), list) and body["benchmarks"]
        else [settings["defaultBenchmarkSymbol"]]
    )

    def _work() -> dict:
        instruments = [repo.get_instrument(i) for i in ids] if ids else repo.list_instruments()
        instruments = [i for i in instruments if i]

        positions = []
        with_tx = []
        for inst in instruments:
            txs = repo.get_transactions(inst["id"])
            if not txs:
                continue
            with_tx.append((inst, txs))
            positions.append(build_position(inst, txs, settings["tax"], pre_tax)["position"])

        comparisons = []
        for bench in benchmarks:
            counterfactuals = []
            for inst, txs in with_tx:
                cf = compute_counterfactual(inst, txs, bench, settings, pre_tax)
                counterfactuals.append(
                    {"instrumentId": inst["id"], "symbol": inst["symbol"],
                     "name": inst["name"], "counterfactual": cf}
                )
            aggregate = aggregate_counterfactuals([c["counterfactual"] for c in counterfactuals])
            bench_name = next((b["name"] for b in settings["benchmarks"] if b["symbol"] == bench), bench)
            comparisons.append({
                "benchmark": bench, "benchmarkName": bench_name,
                "aggregate": aggregate, "perPosition": counterfactuals,
            })

        return {
            "preTax": pre_tax,
            "instrumentIds": [i["id"] for i in instruments],
            "positions": positions,
            "comparisons": comparisons,
        }

    return await run_in_threadpool(_work)


@router.get("/advisory")
async def advisory(includeHandled: str = "false") -> dict:
    settings = get_settings()
    include = bool_param(includeHandled)
    insights = await run_in_threadpool(adv.build_advisory, settings, include)
    return {"insights": insights, "handled": settings.get("advisoryHandled") or []}


@router.post("/advisory/{instrument_id}/handled")
async def advisory_set_handled(instrument_id: int, request: Request) -> dict:
    body = await request.json() or {}
    handled = bool(body.get("handled", True))
    settings = get_settings()
    settings["advisoryHandled"] = adv.set_handled(settings, instrument_id, handled)
    save_settings(settings)
    return {"ok": True, "handled": settings["advisoryHandled"]}


@router.get("/portfolio/series")
async def portfolio_value_series(range: str = "1Y") -> dict:
    return await run_in_threadpool(portfolio_series, range)


@router.get("/timeline")
async def timeline() -> dict:
    """Merged chronological feed of cash events + trades from both source files."""
    return await run_in_threadpool(build_timeline)


@router.get("/series/{instrument_id}")
async def instrument_value_series(instrument_id: int, range: str = "1Y") -> dict:
    if not repo.get_instrument(instrument_id):
        raise ApiError("Instrument not found", 404)
    return await run_in_threadpool(instrument_series, instrument_id, range)


@router.get("/fit/{symbol:path}")
async def fit(symbol: str) -> dict:
    """Portfolio-fit read for a candidate: ownership, direct + indirect ETF exposure, and a
    diversification note. Reuses the exposure/allocation engines; never fabricates a number."""
    from ..services.fit import portfolio_fit

    settings = get_settings()

    def _work() -> dict:
        return portfolio_fit(symbol, settings)

    return await run_in_threadpool(_work)


@router.get("/portfolio")
async def portfolio(preTax: str = "false", benchmark: str | None = None) -> dict:
    settings = get_settings()
    pre_tax = bool_param(preTax)
    bench = benchmark or settings["defaultBenchmarkSymbol"]

    def _work() -> dict:
        today = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
        events = repo.all_account_events()
        div_by_isin = acct.dividends_by_isin(events, today)

        instruments = repo.list_instruments()
        positions = []
        counterfactuals = []
        sell_signals = []
        total_value = 0.0
        for inst in instruments:
            txs = repo.get_transactions(inst["id"])
            if not txs:
                continue
            built = build_position(inst, txs, settings["tax"], pre_tax)
            p = built["position"]
            cached = get_cached_fundamentals(inst["symbol"])
            # Cheap valuation overlay off cached fundamentals — flags (significantly)
            # overvalued holdings without a second rebuild or any provider call.
            sig = sell_signal_for(p, cached, settings)
            if sig:
                p["sellSignal"] = sig
                sell_signals.append(sig)
            # Account statement is the dividend source of truth; fall back to any
            # tx-derived dividends only when no account events exist for this ISIN.
            isin = inst.get("isin")
            acct_div = div_by_isin.get(isin) if isin else None
            p["netDividendsCHF"] = acct_div["netCHF"] if acct_div else p["dividends"]["netAfterTaxCHF"]
            total_value += p["currentValueCHF"] or 0
            positions.append(p)
            cf = compute_counterfactual(inst, txs, bench, settings, pre_tax)
            counterfactuals.append({"instrumentId": inst["id"], "symbol": inst["symbol"],
                                    "counterfactual": cf})
            # One unified verdict per holding — the same engine Decisions/detail use, so the
            # Overview never contradicts them. Benchmark lag alone never yields a Sell.
            if p.get("openQuantity", 0) > 0:
                p["verdict"] = verdict_for(
                    inst["symbol"], p.get("currentPrice"), inst.get("currency"), cached, settings,
                    performance=performance_from_counterfactual(cf), held=True, position=p)

        # Portfolio weight per holding (share of invested market value).
        for p in positions:
            p["weight"] = ((p["currentValueCHF"] or 0) / total_value) if total_value > 0 else 0.0

        aggregate = aggregate_counterfactuals([c["counterfactual"] for c in counterfactuals])

        net_dividends = sum(p["netDividendsCHF"] for p in positions)
        realized = sum(p["realizedCHF"] for p in positions)
        unrealized = sum((p["unrealizedCHF"] or 0) for p in positions)
        cash = acct.cash_chf(events, today)
        totals = {
            "investedCHF": sum(p["investedCHF"] for p in positions),
            "currentValueCHF": total_value,
            "realizedCHF": realized,
            "unrealizedCHF": unrealized,
            "netDividendsCHF": net_dividends,
            "absolutePLChf": sum((p["metrics"]["absolutePLChf"] or 0) for p in positions),
            # Gesamtgewinn: realized + unrealized + net dividends received.
            "totalGainCHF": realized + unrealized + net_dividends,
            "depositsCHF": acct.deposits_total_chf(events, today),
            "feesCHF": acct.fees_total_chf(events, today),
        }
        # "Prices as of" = oldest quote among held positions; background refresh state
        # lets the frontend poll until pending prices land, instead of blocking.
        priced = [p["priceAsOf"] for p in positions
                  if p["openQuantity"] > 0 and p.get("priceAsOf")]
        quotes_updated_at = min(priced) if priced else None
        # Genuine sell signals (significantly overvalued) first, then trims.
        sell_signals.sort(key=lambda s: (s["isSellSignal"],
                                         s["reasoning"].get("premiumToFairPct") or 0), reverse=True)
        return {"benchmark": bench, "preTax": pre_tax, "positions": positions,
                "counterfactuals": counterfactuals, "aggregate": aggregate, "totals": totals,
                "sellSignals": sell_signals,
                "cash": cash,
                "accountDividends": sorted(div_by_isin.values(), key=lambda d: -d["netCHF"]),
                "hasPositions": bool(positions),
                "hasAccount": bool(events),
                "unknownEvents": acct.events_summary(events)["unknownCount"],
                "quotesUpdatedAt": quotes_updated_at,
                "refreshInProgress": refresh.refresh_in_progress()}

    return await run_in_threadpool(_work)

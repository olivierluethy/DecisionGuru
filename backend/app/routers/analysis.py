from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..core.errors import ApiError
from ..services import refresh, repo
from ..services.analytics import aggregate_counterfactuals
from ..services.counterfactual import compute_counterfactual
from ..services.finance import build_position
from ..services.projection import benchmark_cagr, compute_break_even, project_hold_vs_etf
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
    return built["position"]


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


@router.get("/portfolio")
async def portfolio(preTax: str = "false", benchmark: str | None = None) -> dict:
    settings = get_settings()
    pre_tax = bool_param(preTax)
    bench = benchmark or settings["defaultBenchmarkSymbol"]

    def _work() -> dict:
        instruments = repo.list_instruments()
        positions = []
        counterfactuals = []
        for inst in instruments:
            txs = repo.get_transactions(inst["id"])
            if not txs:
                continue
            built = build_position(inst, txs, settings["tax"], pre_tax)
            positions.append(built["position"])
            cf = compute_counterfactual(inst, txs, bench, settings, pre_tax)
            counterfactuals.append({"instrumentId": inst["id"], "symbol": inst["symbol"],
                                    "counterfactual": cf})

        aggregate = aggregate_counterfactuals([c["counterfactual"] for c in counterfactuals])
        totals = {
            "investedCHF": sum(p["investedCHF"] for p in positions),
            "currentValueCHF": sum((p["currentValueCHF"] or 0) for p in positions),
            "realizedCHF": sum(p["realizedCHF"] for p in positions),
            "netDividendsCHF": sum(p["dividends"]["netAfterTaxCHF"] for p in positions),
            "absolutePLChf": sum((p["metrics"]["absolutePLChf"] or 0) for p in positions),
        }
        # "Prices as of" = oldest quote among held positions; background refresh state
        # lets the frontend poll until pending prices land, instead of blocking.
        priced = [p["priceAsOf"] for p in positions
                  if p["openQuantity"] > 0 and p.get("priceAsOf")]
        quotes_updated_at = min(priced) if priced else None
        return {"benchmark": bench, "preTax": pre_tax, "positions": positions,
                "counterfactuals": counterfactuals, "aggregate": aggregate, "totals": totals,
                "quotesUpdatedAt": quotes_updated_at,
                "refreshInProgress": refresh.refresh_in_progress()}

    return await run_in_threadpool(_work)

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..core.errors import ApiError
from ..services import repo
from ..services.analytics import aggregate_counterfactuals
from ..services.counterfactual import compute_counterfactual

router = APIRouter()


@router.get("")
async def list_scenarios() -> list[dict]:
    return repo.list_scenarios()


@router.get("/{scenario_id}")
async def get_scenario(scenario_id: int) -> dict:
    s = repo.get_scenario(scenario_id)
    if not s:
        raise ApiError("Not found", 404)
    return s


@router.post("")
async def create_scenario(request: Request) -> dict:
    body = await request.json() or {}
    if not body.get("name") or not body.get("config"):
        raise ApiError("name and config required", 400)
    return repo.insert_scenario(body["name"], body["config"])


@router.put("/{scenario_id}")
async def update_scenario(scenario_id: int, request: Request) -> dict:
    body = await request.json() or {}
    s = repo.update_scenario(scenario_id, body.get("name"), body.get("config"))
    if not s:
        raise ApiError("Not found", 404)
    return s


@router.delete("/{scenario_id}")
async def delete_scenario(scenario_id: int) -> dict:
    repo.delete_scenario(scenario_id)
    return {"ok": True}


@router.post("/run")
async def run(request: Request) -> dict:
    config = await request.json() or {}
    return await run_in_threadpool(run_scenario, config)


def run_scenario(config: dict) -> dict:
    settings = get_settings()
    benchmark = config.get("benchmarkSymbol") or settings["defaultBenchmarkSymbol"]
    pre_tax = config.get("preTax") or False

    ids = config.get("includedInstrumentIds") or []
    if config.get("sellAllToEtf") or len(ids) == 0:
        ids = [i["id"] for i in repo.list_instruments()]

    from_date = config.get("fromDate") or None
    as_of = config.get("asOf") or None

    per_position = []
    for id_ in ids:
        inst = repo.get_instrument(id_)
        if not inst:
            continue
        txs = repo.get_transactions(id_)
        if from_date:
            txs = [t for t in txs if t["date"] >= from_date]
        if not txs:
            continue
        cf = compute_counterfactual(inst, txs, benchmark, settings, pre_tax, as_of=as_of)
        per_position.append({"instrumentId": id_, "symbol": inst["symbol"], "counterfactual": cf})

    aggregate = aggregate_counterfactuals([p["counterfactual"] for p in per_position])
    return {
        "scenario": {**config, "benchmarkSymbol": benchmark, "preTax": pre_tax},
        "perPosition": per_position,
        "aggregate": {
            "actualValueCHF": aggregate["actualValueCHF"],
            "counterfactualValueCHF": aggregate["counterfactualValueCHF"],
            "deltaCHF": aggregate["deltaCHF"],
            "deltaPct": aggregate["deltaPct"],
            "series": aggregate["series"],
        },
    }

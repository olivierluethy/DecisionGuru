from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..core.errors import ApiError
from ..services import repo
from ..services.decision import recovery_analysis, simulate_reinvest
from ..services.exposure import compare_exposure, portfolio_exposure
from ..services.recommend import build_recommendations

router = APIRouter()


@router.get("/recommendations")
async def recommendations() -> dict:
    settings = get_settings()
    return await run_in_threadpool(build_recommendations, settings)


@router.get("/recovery/{instrument_id}")
async def recovery(instrument_id: int, horizon: float = 5,
                   alternatives: str | None = None) -> dict:
    if not repo.get_instrument(instrument_id):
        raise ApiError("Instrument not found", 404)
    settings = get_settings()
    alts = [s.strip() for s in alternatives.split(",") if s.strip()] if alternatives else None
    return await run_in_threadpool(recovery_analysis, instrument_id, settings, horizon, alts)


@router.post("/simulate")
async def simulate(request: Request) -> dict:
    body = await request.json() or {}
    settings = get_settings()
    sell_ids = body.get("sellInstrumentIds") or body.get("instrumentIds") or []
    targets = body.get("targets") or []
    horizon = float(body.get("horizonYears") or 5)
    if not targets:
        raise ApiError("At least one reinvest target is required", 400)
    return await run_in_threadpool(simulate_reinvest, sell_ids, targets, settings, horizon)


@router.get("/exposure")
async def exposure() -> dict:
    settings = get_settings()
    return await run_in_threadpool(portfolio_exposure, settings)


@router.get("/exposure/compare")
async def exposure_compare(a: int, b: int) -> dict:
    inst_a = repo.get_instrument(a)
    inst_b = repo.get_instrument(b)
    if not inst_a or not inst_b:
        raise ApiError("Instrument not found", 404)
    return await run_in_threadpool(compare_exposure, inst_a, inst_b)

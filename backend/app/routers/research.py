from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..core.errors import ApiError
from ..services.research import research_asset, validate_claim
from ..services.fundamentals import fundamentals_bundle
from ..services.universal import universal_compare

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

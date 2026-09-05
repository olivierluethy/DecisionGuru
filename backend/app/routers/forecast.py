from __future__ import annotations

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..services.forecast import DEFAULT_HORIZON_DAYS, build_forecast

router = APIRouter()


@router.get("")
async def forecast(horizon: int = DEFAULT_HORIZON_DAYS) -> dict:
    """The portfolio forecast timeline: what to act on today, when each holding is likely
    worth acting on, and the per-day opportunity cost of doing nothing."""
    settings = get_settings()
    return await run_in_threadpool(build_forecast, settings, horizon)

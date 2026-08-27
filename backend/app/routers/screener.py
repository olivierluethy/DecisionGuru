from __future__ import annotations

from fastapi import APIRouter
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..services.screener import screen_universe

router = APIRouter()


@router.get("")
async def screen() -> dict:
    """Rank the screening universe (curated seed ∪ holdings ∪ watchlist) by an
    attractiveness score combining Graham/Buffett value, quality, supportable return
    and portfolio fit. Scores only names with cached fundamentals — never bulk-fetches."""
    settings = get_settings()
    return await run_in_threadpool(screen_universe, settings)

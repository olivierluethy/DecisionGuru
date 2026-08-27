from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..services.screener import screen_universe
from ..services import screener_warm

router = APIRouter()

# When the screener is opened and a chunk of the universe is still un-cached, auto-kick a
# background warm so results grow without any manual action. Bounded so a first visit
# doesn't fan out into the entire universe at once; the rest fills over subsequent visits,
# the manual "fetch all" trigger, and the 6-hourly scan.
_AUTO_WARM_BATCH = 40


@router.get("")
async def screen(warm: bool = True) -> dict:
    """Rank the screening universe (curated seed ∪ holdings ∪ watchlist) by an
    attractiveness score combining Graham/Buffett value, quality, supportable return and
    portfolio fit. Scores names with cached fundamentals; a background warmer fetches the
    missing ones so the whole universe becomes screenable over time (cache = optimisation,
    not a filter). Pass warm=false to skip the auto-warm."""
    settings = get_settings()
    result = await run_in_threadpool(screen_universe, settings)
    if warm and not screener_warm.is_running():
        cov = await run_in_threadpool(screener_warm.coverage)
        if cov["missing"] > 0:
            await run_in_threadpool(screener_warm.start_warm, _AUTO_WARM_BATCH, "auto")
    result["warm"] = screener_warm.status()
    return result


@router.post("/refresh")
async def refresh(request: Request) -> dict:
    """Fetch fundamentals for the missing part of the universe in a controlled background
    warm. Body may carry {"limit": N} to cap this run; omit it to warm all remaining."""
    body = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — empty body is fine
        body = {}
    limit = body.get("limit") if isinstance(body, dict) else None
    return await run_in_threadpool(screener_warm.start_warm, limit, "manual")


@router.get("/refresh/status")
async def refresh_status() -> dict:
    return await run_in_threadpool(screener_warm.status)

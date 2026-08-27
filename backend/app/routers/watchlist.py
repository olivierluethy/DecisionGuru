from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.errors import ApiError
from ..services.watchlist import list_watchlist, add_to_watchlist, remove_from_watchlist

router = APIRouter()


@router.get("")
async def get_all() -> list[dict]:
    return await run_in_threadpool(list_watchlist)


@router.post("")
async def add(request: Request) -> dict:
    body = await request.json() or {}
    symbol = (body.get("symbol") or "").strip()
    if not symbol:
        raise ApiError("A symbol is required", 400)
    return await run_in_threadpool(
        add_to_watchlist, symbol, body.get("name"), body.get("kind") or "stock"
    )


@router.delete("/{item_id}")
async def remove(item_id: int) -> dict:
    ok = await run_in_threadpool(remove_from_watchlist, item_id)
    if not ok:
        raise ApiError("Not on the watchlist", 404)
    return {"ok": True}

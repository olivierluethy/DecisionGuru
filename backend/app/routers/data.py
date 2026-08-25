from __future__ import annotations

from fastapi import APIRouter, Request

from ..core import db

router = APIRouter()


@router.post("/reset")
async def reset_data(request: Request) -> dict:
    body = await request.json() if await _has_body(request) else {}
    keep_resolutions = body.get("keepResolutions") is not False
    tables = ["transactions", "instruments", "price_cache", "quote_cache",
              "dividend_cache", "fund_cache"]
    if not keep_resolutions:
        tables.append("symbol_map")

    def _wipe(conn):
        for t in tables:
            conn.execute(f"DELETE FROM {t}")
        conn.execute("DELETE FROM notes WHERE target = 'instrument'")

    db.transaction(_wipe)
    db.execute("VACUUM")
    return {"ok": True, "cleared": tables, "keptResolutions": keep_resolutions}


async def _has_body(request: Request) -> bool:
    body = await request.body()
    return bool(body)

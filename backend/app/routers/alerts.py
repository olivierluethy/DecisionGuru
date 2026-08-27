from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..core.errors import ApiError
from ..services import alerts as svc
from ..services import scan as scan_svc

router = APIRouter()


# ---- alerts ----------------------------------------------------------------

@router.get("")
async def get_alerts(status: str | None = None) -> list[dict]:
    return await run_in_threadpool(svc.list_alerts, status)


@router.post("")
async def create_alert(request: Request) -> dict:
    body = await request.json() or {}
    symbol = (body.get("symbol") or "").strip()
    if not symbol:
        raise ApiError("A symbol is required", 400)
    kind = body.get("kind") or "buy"
    settings = get_settings()
    target = body.get("targetPrice")
    return await run_in_threadpool(
        svc.create_alert, symbol, kind, settings,
        **{"target": target, "name": body.get("name"), "auto": False},
    )


@router.delete("/{alert_id}")
async def delete_alert(alert_id: int) -> dict:
    ok = await run_in_threadpool(svc.delete_alert, alert_id)
    if not ok:
        raise ApiError("Alert not found", 404)
    return {"ok": True}


@router.post("/{alert_id}/dismiss")
async def dismiss_alert(alert_id: int) -> dict:
    ok = await run_in_threadpool(svc.dismiss_alert, alert_id)
    if not ok:
        raise ApiError("Alert not found", 404)
    return {"ok": True}


# ---- notification feed -----------------------------------------------------

@router.get("/notifications")
async def notifications(limit: int = 50) -> dict:
    items = await run_in_threadpool(svc.list_notifications, limit)
    unread = await run_in_threadpool(svc.unread_count)
    return {"notifications": items, "unreadCount": unread}


@router.get("/notifications/unread-count")
async def unread_count() -> dict:
    return {"unreadCount": await run_in_threadpool(svc.unread_count)}


@router.post("/notifications/read")
async def mark_read(request: Request) -> dict:
    body = await request.json() if request.headers.get("content-length") else {}
    await run_in_threadpool(svc.mark_read, (body or {}).get("id"))
    return {"ok": True}


# ---- the scan ---------------------------------------------------------------

@router.post("/scan")
async def trigger_scan() -> dict:
    """Run the opportunity scan now (maintain fair-value alerts, evaluate them, surface
    newly-attractive names). Works off cached data — safe to call on demand."""
    return await run_in_threadpool(scan_svc.run_scan, "manual")


@router.get("/scan/status")
async def scan_status() -> dict:
    last = await run_in_threadpool(scan_svc.last_scan)
    return {"lastScan": last, "intervalHours": scan_svc.SCAN_INTERVAL_SECONDS // 3600}

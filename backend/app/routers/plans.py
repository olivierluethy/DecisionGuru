from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.db import get_settings
from ..core.errors import ApiError
from ..services import plans as plans_svc

router = APIRouter()


@router.get("")
async def list_plans() -> list[dict]:
    return await run_in_threadpool(plans_svc.list_plans)


@router.post("")
async def create_plan(request: Request) -> dict:
    body = await request.json() or {}
    name = (body.get("name") or "").strip()
    config = body.get("config") or {}
    if not name:
        raise ApiError("A plan name is required", 400)
    if not (config.get("targets")):
        raise ApiError("A plan needs at least one reinvest target", 400)
    settings = get_settings()
    return await run_in_threadpool(plans_svc.create_plan, name, config, settings)


@router.get("/{plan_id}")
async def get_plan(plan_id: int) -> dict:
    plan = await run_in_threadpool(plans_svc.get_plan, plan_id)
    if not plan:
        raise ApiError("Plan not found", 404)
    return plan


@router.put("/{plan_id}")
async def update_plan(plan_id: int, request: Request) -> dict:
    body = await request.json() or {}
    settings = get_settings()
    updated = await run_in_threadpool(
        plans_svc.update_plan, plan_id, body.get("name"), body.get("config"),
        body.get("status"), settings,
    )
    if not updated:
        raise ApiError("Plan not found", 404)
    return updated


@router.delete("/{plan_id}")
async def delete_plan(plan_id: int) -> dict:
    ok = await run_in_threadpool(plans_svc.delete_plan, plan_id)
    if not ok:
        raise ApiError("Plan not found", 404)
    return {"ok": True}


@router.get("/{plan_id}/compare")
async def compare_plan(plan_id: int) -> dict:
    settings = get_settings()
    result = await run_in_threadpool(plans_svc.compare_plan, plan_id, settings)
    if not result:
        raise ApiError("Plan not found", 404)
    return result

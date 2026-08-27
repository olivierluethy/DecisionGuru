from __future__ import annotations

from fastapi import APIRouter, Request

from ..core.db import get_settings, save_settings
from ..reference.defaults import DEFAULT_SETTINGS

router = APIRouter()


@router.get("")
async def get_settings_route() -> dict:
    return get_settings()


@router.put("")
async def put_settings(request: Request) -> dict:
    incoming = await request.json() or {}
    current = get_settings()
    merged = {
        **current,
        **incoming,
        "tax": {**current["tax"], **(incoming.get("tax") or {})},
        "valuation": {**current.get("valuation", {}), **(incoming.get("valuation") or {})},
        "benchmarks": incoming.get("benchmarks") or current["benchmarks"],
    }
    save_settings(merged)
    return merged


@router.post("/reset")
async def reset_settings() -> dict:
    save_settings(DEFAULT_SETTINGS)
    return DEFAULT_SETTINGS

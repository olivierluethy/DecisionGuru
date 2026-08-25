from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Request

from ..core.errors import ApiError
from ..services import repo

router = APIRouter()


@router.post("")
async def add_transaction(request: Request) -> dict:
    body = await request.json() or {}
    if not body.get("instrumentId") or not repo.get_instrument(int(body["instrumentId"])):
        raise ApiError("valid instrumentId required", 400)
    if not body.get("action") or not body.get("date"):
        raise ApiError("action and date required", 400)
    tx = repo.insert_transaction({
        "instrumentId": int(body["instrumentId"]),
        "action": body["action"],
        "date": pd.Timestamp(body["date"]).strftime("%Y-%m-%d"),
        "quantity": float(body.get("quantity") or 0),
        "unitPrice": float(body.get("unitPrice") or 0),
        "fees": float(body.get("fees") or 0),
        "currency": body.get("currency"),
        "grossAmount": body.get("grossAmount"),
        "netAmount": body.get("netAmount"),
        "withholding": body.get("withholding"),
        "note": body.get("note"),
        "source": "manual",
    })
    return tx


@router.delete("/{tx_id}")
async def delete_transaction(tx_id: int) -> dict:
    repo.delete_transaction(tx_id)
    return {"ok": True}

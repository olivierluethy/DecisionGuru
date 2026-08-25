from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Request
from fastapi.concurrency import run_in_threadpool

from ..core.errors import ApiError
from ..services import repo
from ..services.datastatus import instrument_data_status
from ..services.marketdata import price_on, search_symbol

router = APIRouter()


@router.get("")
async def list_instruments() -> list[dict]:
    return repo.list_instruments()


@router.get("/search")
async def search(q: str = "") -> list[dict]:
    q = (q or "").strip()
    if not q:
        return []
    return await run_in_threadpool(search_symbol, q)


@router.post("/reresolve-all")
async def reresolve_all(request: Request) -> dict:
    body = await request.json() if await request.body() else {}
    offline = body.get("offline") is True
    pending = repo.unresolved_instruments()
    results = []
    for inst in pending:
        updated = await run_in_threadpool(repo.reresolve_instrument, inst["id"], offline)
        results.append({
            "id": inst["id"], "isin": inst.get("isin"),
            "symbol": updated.get("symbol") if updated else None,
            "unresolved": updated.get("unresolved") if updated else None,
        })
    return {"attempted": len(pending), "offline": offline, "results": results}


@router.post("/{instrument_id}/reresolve")
async def reresolve_one(instrument_id: int, request: Request) -> dict:
    body = await request.json() if await request.body() else {}
    updated = await run_in_threadpool(repo.reresolve_instrument, instrument_id, body.get("offline") is True)
    if not updated:
        raise ApiError("Not found", 404)
    return updated


@router.get("/{instrument_id}/status")
async def status(instrument_id: int) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Not found", 404)
    return instrument_data_status(inst)


@router.get("/{instrument_id}")
async def get_instrument(instrument_id: int) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Not found", 404)
    return inst


@router.get("/{instrument_id}/transactions")
async def get_transactions(instrument_id: int) -> list[dict]:
    return repo.get_transactions(instrument_id)


@router.post("")
async def create_instrument(request: Request) -> dict:
    body = await request.json() or {}
    if not body.get("symbol") and not body.get("isin") and not body.get("name"):
        raise ApiError("symbol, isin or name required", 400)
    inst = await run_in_threadpool(repo.resolve_instrument, body)
    patched = repo.update_instrument(inst["id"], {
        "domicile": body.get("domicile") if body.get("domicile") is not None else inst.get("domicile"),
        "kind": body.get("kind") or inst.get("kind"),
        "incomeYieldOverride": body.get("incomeYieldOverride")
        if body.get("incomeYieldOverride") is not None else inst.get("incomeYieldOverride"),
    })
    return patched or inst


@router.patch("/{instrument_id}")
async def update_instrument(instrument_id: int, request: Request) -> dict:
    body = await request.json() or {}
    updated = repo.update_instrument(instrument_id, body)
    if not updated:
        raise ApiError("Not found", 404)
    return updated


@router.delete("/{instrument_id}")
async def delete_instrument(instrument_id: int) -> dict:
    repo.delete_instrument(instrument_id)
    return {"ok": True}


@router.post("/manual")
async def manual(request: Request) -> dict:
    body = await request.json() or {}
    date = body.get("date")
    if not date:
        raise ApiError("date required", 400)
    inst = await run_in_threadpool(repo.resolve_instrument, {
        "symbol": body.get("symbol"), "isin": body.get("isin"), "name": body.get("name"),
    })
    ccy = body.get("currency") or inst["currency"]
    iso = pd.Timestamp(date).strftime("%Y-%m-%d")
    price_at = await run_in_threadpool(price_on, inst["symbol"], iso)
    if price_at is None:
        raise ApiError(f"No historical price for {inst['symbol']} near {date}", 422)

    qty = float(body["units"]) if body.get("units") is not None else 0
    if not qty and body.get("amount") is not None:
        qty = float(body["amount"]) / price_at
    if not qty or qty <= 0:
        raise ApiError("Provide amount or units", 400)

    action = "sell" if body.get("action") == "sell" else "buy"
    tx = repo.insert_transaction({
        "instrumentId": inst["id"], "action": action, "date": iso,
        "quantity": qty, "unitPrice": price_at, "fees": 0, "currency": ccy, "source": "manual",
    })
    return {"instrument": inst, "transaction": tx, "derivedPrice": price_at}

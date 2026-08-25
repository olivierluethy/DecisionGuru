from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool

from ..core.errors import ApiError
from ..services import repo
from ..services.allocation import build_allocation
from ..services.fx import get_fx_rate
from ..services.marketdata import get_fund_summary, get_history, get_quote, search_symbol

router = APIRouter()


@router.get("/quote/{symbol:path}")
async def quote(symbol: str) -> dict:
    return await run_in_threadpool(get_quote, symbol)


@router.get("/history/{symbol:path}")
async def history(symbol: str, from_: str | None = Query(default=None, alias="from"),
                  to: str | None = None):
    return await run_in_threadpool(get_history, symbol, from_ or _default_from(), to)


@router.get("/fund/{symbol:path}")
async def fund(symbol: str):
    return await run_in_threadpool(get_fund_summary, symbol)


@router.get("/search")
async def search(q: str = "") -> list[dict]:
    return await run_in_threadpool(search_symbol, q)


@router.get("/fx")
async def fx(from_: str = Query(default="USD", alias="from"), to: str = "CHF",
            date: str | None = None) -> dict:
    d = date or pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    rate = await run_in_threadpool(get_fx_rate, from_, to, d)
    return {"from": from_, "to": to, "date": d, "rate": rate}


@router.get("/allocation/{instrument_id}")
async def allocation(instrument_id: int) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ApiError("Instrument not found", 404)
    return await run_in_threadpool(build_allocation, inst)


def _default_from() -> str:
    return (pd.Timestamp.utcnow() - pd.DateOffset(years=10)).strftime("%Y-%m-%d")

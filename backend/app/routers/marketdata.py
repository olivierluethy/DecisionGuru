from __future__ import annotations

import pandas as pd
from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool

from ..core.errors import ApiError
from ..services import repo
from ..services.allocation import build_allocation
from ..services.fx import get_fx_rate
from ..services.marketdata import get_fund_summary, get_history, get_quote, search_symbol
from ..services.markethours import all_statuses, status_for_symbol
from ..services.movements import movements_for_symbol
from ..services.news import get_news
from ..services.periods import period_returns

router = APIRouter()


@router.get("/news/{symbol:path}")
async def news(symbol: str, limit: int = 12) -> dict:
    return await run_in_threadpool(get_news, symbol, limit)


@router.get("/hours")
async def market_hours() -> dict:
    statuses = await run_in_threadpool(all_statuses, None, None)
    return {"exchanges": statuses}


@router.get("/hours/{symbol:path}")
async def market_hours_symbol(symbol: str) -> dict:
    return await run_in_threadpool(status_for_symbol, symbol, None)


@router.get("/movements/{symbol:path}")
async def movements(symbol: str, from_: str | None = Query(default=None, alias="from")) -> dict:
    return await run_in_threadpool(movements_for_symbol, symbol, from_)


@router.get("/periods/{symbol:path}")
async def periods(symbol: str, entry: str | None = Query(default=None)) -> dict:
    """Price return over 1Y/2Y/3Y/5Y trailing windows + full holding period (if `entry`)."""
    return await run_in_threadpool(period_returns, symbol, entry)


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

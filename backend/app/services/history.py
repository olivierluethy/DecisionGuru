"""Range-sliced value series for the portfolio and individual holdings.

Uses ONLY cached prices (`get_history` never blocks on Yahoo — it serves what's
cached and backfills in the background). Each holding's value on a date is
`quantity_held(date) × close × FX(currency→CHF, date)`; the portfolio curve is the
forward-filled sum across holdings on a shared date axis.
"""
from __future__ import annotations

import pandas as pd

from . import repo
from .fx import get_fx_rate
from .marketdata import get_history, listing_currency

# Calendar-day lookback per preset. MAX → since the first transaction.
RANGE_DAYS: dict[str, int | None] = {
    "1D": 1, "30D": 30, "1M": 31, "2M": 62, "5M": 153, "6M": 183,
    "1Y": 365, "2Y": 730, "5Y": 1825, "MAX": None,
}


def normalize_range(range_key: str | None) -> str:
    key = (range_key or "1Y").upper()
    return key if key in RANGE_DAYS else "1Y"


def _range_start(range_key: str, earliest: str | None) -> str:
    days = RANGE_DAYS.get(range_key)
    if days is None:
        return earliest or (pd.Timestamp.utcnow() - pd.Timedelta(days=365)).strftime("%Y-%m-%d")
    start = (pd.Timestamp.utcnow().normalize() - pd.Timedelta(days=days)).strftime("%Y-%m-%d")
    if earliest and earliest > start:
        return earliest
    return start


def _qty_breakpoints(txs: list[dict]) -> list[tuple[str, float]]:
    trades = sorted(
        (t for t in txs if t.get("category") != "corporate_action" and t["action"] in ("buy", "sell")),
        key=lambda t: t["date"],
    )
    bp: list[tuple[str, float]] = []
    q = 0.0
    for t in trades:
        qty = t.get("quantity") or 0
        q += qty if t["action"] == "buy" else -qty
        bp.append((t["date"], q))
    return bp


def _qty_on(bp: list[tuple[str, float]], date: str) -> float:
    cur = 0.0
    for bd, bq in bp:
        if bd <= date:
            cur = bq
        else:
            break
    return cur


def _instrument_value_map(inst: dict, txs: list[dict], start: str, end: str) -> dict[str, float]:
    bp = _qty_breakpoints(txs)
    # Cached closes are stored in the instrument's LISTING currency (e.g. GBP for a
    # UK line), which can differ from the instrument's reference currency. Use the
    # listing currency for FX so a GBp→GBP-normalised series isn't converted as USD.
    ccy = listing_currency(inst["symbol"], inst.get("currency")) or "USD"
    out: dict[str, float] = {}
    for row in get_history(inst["symbol"], start, end):
        d = row["date"]
        qh = _qty_on(bp, d)
        out[d] = (qh * row["close"] * get_fx_rate(ccy, "CHF", d)) if qh > 0 else 0.0
    return out


def _stats(points: list[dict]) -> dict | None:
    if not points:
        return None
    vals = [p["value"] for p in points]
    start_v, end_v = vals[0], vals[-1]
    change_abs = end_v - start_v
    return {
        "high": max(vals),
        "low": min(vals),
        "start": start_v,
        "end": end_v,
        "changeAbs": change_abs,
        "changePct": (change_abs / start_v) if start_v else None,
    }


def _series_from_map(value_map: dict[str, float], start: str, range_key: str) -> dict:
    if not value_map:
        return {"range": range_key, "points": [], "stats": None}
    s = pd.Series(value_map)
    s.index = pd.to_datetime(s.index)
    s = s.sort_index()
    s = s[s.index >= pd.Timestamp(start)]
    points = [{"date": d.strftime("%Y-%m-%d"), "value": float(v)} for d, v in s.items()]
    return {"range": range_key, "points": points, "stats": _stats(points)}


def instrument_series(instrument_id: int, range_key: str) -> dict:
    range_key = normalize_range(range_key)
    inst = repo.get_instrument(instrument_id)
    if not inst:
        return {"range": range_key, "points": [], "stats": None}
    txs = repo.get_transactions(instrument_id)
    if not txs:
        return {"range": range_key, "points": [], "stats": None}
    earliest = min(t["date"] for t in txs)
    start = _range_start(range_key, earliest)
    end = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    return _series_from_map(_instrument_value_map(inst, txs, start, end), start, range_key)


def portfolio_series(range_key: str) -> dict:
    range_key = normalize_range(range_key)
    held: list[tuple[dict, list[dict]]] = []
    earliest: str | None = None
    for inst in repo.list_instruments():
        txs = repo.get_transactions(inst["id"])
        if not txs:
            continue
        held.append((inst, txs))
        d0 = min(t["date"] for t in txs)
        earliest = d0 if earliest is None else min(earliest, d0)
    if not held:
        return {"range": range_key, "points": [], "stats": None}

    start = _range_start(range_key, earliest)
    end = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    cols: list[pd.Series] = []
    for inst, txs in held:
        vm = _instrument_value_map(inst, txs, start, end)
        if vm:
            s = pd.Series(vm)
            s.index = pd.to_datetime(s.index)
            cols.append(s.sort_index())
    if not cols:
        return {"range": range_key, "points": [], "stats": None}

    df = pd.concat(cols, axis=1).sort_index().ffill().fillna(0.0)
    total = df.sum(axis=1)
    total = total[total.index >= pd.Timestamp(start)]
    points = [{"date": d.strftime("%Y-%m-%d"), "value": float(v)} for d, v in total.items()]
    return {"range": range_key, "points": points, "stats": _stats(points)}

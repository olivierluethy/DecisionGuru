"""Persisted investment decision plans + plan-vs-actual comparison.

A plan names a set of holdings to sell, the reinvest targets (symbol + intended
allocation), an intended outcome, and a horizon. On creation we snapshot a *baseline*:
the CHF proceeds, and — for every target and every sold holding — the CHF unit price on
the plan date and the implied units. Later, `compare_plan` reprices those same units at
today's prices, so "what the plan would have done" vs "holding instead" is measured from
the day the plan was made, not re-estimated from scratch.
"""
from __future__ import annotations

import json

import pandas as pd

from ..core.db import execute, q
from . import repo
from .decision import simulate_reinvest
from .finance import build_position
from .fx import get_fx_rate
from .marketdata import get_quote, price_on


def _today() -> str:
    return pd.Timestamp.utcnow().strftime("%Y-%m-%d")


def _price_chf_on(symbol: str, ccy_fallback: str, date: str) -> float:
    p = price_on(symbol, date)
    if p is None:
        return 0.0
    try:
        ccy = get_quote(symbol)["currency"] or ccy_fallback
    except Exception:  # noqa: BLE001
        ccy = ccy_fallback
    return p * get_fx_rate(ccy, "CHF", date)


def _row_to_plan(row) -> dict:
    return {
        "id": row["id"], "name": row["name"],
        "config": json.loads(row["config"]),
        "baseline": json.loads(row["baseline"]) if row["baseline"] else None,
        "status": row["status"],
        "createdAt": row["createdAt"], "updatedAt": row["updatedAt"],
    }


def list_plans() -> list[dict]:
    rows = q("SELECT * FROM decision_plans ORDER BY createdAt DESC").all()
    return [_row_to_plan(r) for r in rows]


def get_plan(plan_id: int) -> dict | None:
    row = q("SELECT * FROM decision_plans WHERE id = ?").get((plan_id,))
    return _row_to_plan(row) if row else None


def _build_baseline(config: dict, settings: dict) -> dict:
    date = _today()
    sell_ids = config.get("sellInstrumentIds") or []
    targets = config.get("targets") or []
    horizon = config.get("horizonYears") or 5

    sim = simulate_reinvest(sell_ids, targets, settings, horizon)

    target_snaps = []
    for leg in sim["targets"]:
        entry = _price_chf_on(leg["symbol"], "USD", date)
        units = leg["amountCHF"] / entry if entry > 0 else 0.0
        target_snaps.append({**leg, "entryPriceCHF": entry, "units": units})

    sold_snaps = []
    for iid in sell_ids:
        inst = repo.get_instrument(iid)
        if not inst:
            continue
        pos = build_position(inst, repo.get_transactions(iid), settings["tax"])["position"]
        price = _price_chf_on(inst["symbol"], inst["currency"], date)
        sold_snaps.append({
            "instrumentId": iid, "symbol": inst["symbol"], "name": inst["name"],
            "valueCHF": pos.get("currentValueCHF") or 0.0,
            "priceCHF": price, "units": pos["openQuantity"],
            "cagr": pos["metrics"]["cagr"],
        })

    return {
        "createdDate": date,
        "proceedsCHF": sim["proceedsCHF"], "investedCHF": sim["investedCHF"],
        "horizonYears": horizon,
        "targets": target_snaps, "soldHoldings": sold_snaps,
        "reinvestExpectedValueCHF": sim["reinvestExpectedValueCHF"],
        "holdExpectedValueCHF": sim["holdExpectedValueCHF"],
        "deltaVsHoldCHF": sim["deltaVsHoldCHF"],
        "recoveryYears": sim["recoveryYears"],
        "blendedCagr": sim["blendedCagr"],
        "intendedOutcome": config.get("intendedOutcome"),
    }


def create_plan(name: str, config: dict, settings: dict) -> dict:
    baseline = _build_baseline(config, settings)
    cur = execute(
        "INSERT INTO decision_plans (name, config, baseline, status) VALUES (?, ?, ?, 'open')",
        (name, json.dumps(config), json.dumps(baseline)),
    )
    return get_plan(cur.lastrowid)


def update_plan(plan_id: int, name: str | None, config: dict | None,
                status: str | None, settings: dict) -> dict | None:
    plan = get_plan(plan_id)
    if not plan:
        return None
    new_name = name if name is not None else plan["name"]
    new_config = config if config is not None else plan["config"]
    new_status = status if status is not None else plan["status"]
    # Rebuild the baseline only when the sell/target set actually changed.
    baseline = plan["baseline"]
    if config is not None and config != plan["config"]:
        baseline = _build_baseline(new_config, settings)
    execute(
        "UPDATE decision_plans SET name=?, config=?, baseline=?, status=?, updatedAt=datetime('now') WHERE id=?",
        (new_name, json.dumps(new_config), json.dumps(baseline), new_status, plan_id),
    )
    return get_plan(plan_id)


def delete_plan(plan_id: int) -> bool:
    cur = execute("DELETE FROM decision_plans WHERE id = ?", (plan_id,))
    return cur.rowcount > 0


def compare_plan(plan_id: int, settings: dict) -> dict | None:
    """Reprice the baseline's units at today's prices: plan (reinvested) vs holding."""
    plan = get_plan(plan_id)
    if not plan or not plan["baseline"]:
        return None
    b = plan["baseline"]
    date = _today()

    reinvest_now = 0.0
    target_rows = []
    for t in b["targets"]:
        now_price = _price_chf_on(t["symbol"], "USD", date)
        value_now = (t.get("units") or 0) * now_price
        reinvest_now += value_now
        entry = t.get("entryPriceCHF") or 0
        target_rows.append({
            "symbol": t["symbol"], "name": t.get("name"),
            "amountCHF": t["amountCHF"], "valueNowCHF": value_now,
            "returnPct": ((now_price - entry) / entry) if entry > 0 else None,
        })

    hold_now = 0.0
    sold_rows = []
    for s in b["soldHoldings"]:
        now_price = _price_chf_on(s["symbol"], "USD", date)
        value_now = (s.get("units") or 0) * now_price
        hold_now += value_now
        entry = s.get("priceCHF") or 0
        sold_rows.append({
            "symbol": s["symbol"], "name": s.get("name"),
            "valueAtPlanCHF": s["valueCHF"], "valueNowCHF": value_now,
            "returnPct": ((now_price - entry) / entry) if entry > 0 else None,
        })

    return {
        "planId": plan_id, "name": plan["name"], "status": plan["status"],
        "createdDate": b["createdDate"], "asOf": date,
        "proceedsCHF": b["proceedsCHF"],
        "plan": {"targets": target_rows, "valueNowCHF": reinvest_now,
                 "returnPct": ((reinvest_now - b["proceedsCHF"]) / b["proceedsCHF"]) if b["proceedsCHF"] else None},
        "hold": {"holdings": sold_rows, "valueNowCHF": hold_now,
                 "returnPct": ((hold_now - b["proceedsCHF"]) / b["proceedsCHF"]) if b["proceedsCHF"] else None},
        "deltaCHF": reinvest_now - hold_now,
        "intendedOutcome": b.get("intendedOutcome"),
        "intendedReinvestValueCHF": b["reinvestExpectedValueCHF"],
        "horizonYears": b["horizonYears"],
    }

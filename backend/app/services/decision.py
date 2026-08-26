"""Decision analysis & simulation.

For an underperforming holding: how long each alternative would take to recover the
current shortfall (at that alternative's historical CAGR), which alternative recovers
fastest, and single- vs multi-asset reinvest strategies. Plus a "sell today → reinvest
proceeds" simulator that projects each strategy forward against simply holding.

Recovery time mirrors the app's existing "N yr @ x% p.a." pattern: years for the
proceeds, compounding at the alternative's CAGR, to reach the break-even target (the
capital originally invested). All backward-looking CAGRs come from cached history.
"""
from __future__ import annotations

import math

from . import repo
from .finance import build_position
from .projection import benchmark_cagr

MONTHS_CAP = 600  # 50y horizon for numeric recovery solves


def _proceeds_chf(position: dict, settings: dict) -> float:
    """Net CHF from selling today. Swiss private investors: capital gains untaxed, so
    proceeds ≈ current market value; only professional traders pay on the gain."""
    value = position.get("currentValueCHF") or 0.0
    tax = settings["tax"]
    if tax.get("capitalGainsTaxable") and value > 0:
        gain = max(value - (position.get("investedCHF") or 0.0), 0.0)
        return value - gain * tax.get("marginalIncomeRate", 0.0)
    return value


def _recovery_years(proceeds: float, target: float, annual_cagr: float | None) -> float | None:
    if proceeds <= 0 or target <= 0:
        return None
    if proceeds >= target:
        return 0.0
    if not annual_cagr or annual_cagr <= 0:
        return None
    yrs = math.log(target / proceeds) / math.log(1 + annual_cagr)
    return round(yrs, 2) if math.isfinite(yrs) else None


def _blended_recovery_years(legs: list[dict], target: float) -> float | None:
    """Numeric recovery for a basket: month t where Σ amount_i·(1+g_i)^(t/12) ≥ target."""
    if target <= 0 or not legs:
        return None
    start = sum(l["amountCHF"] for l in legs)
    if start >= target:
        return 0.0
    for m in range(1, MONTHS_CAP + 1):
        t = m / 12
        val = sum(l["amountCHF"] * (1 + (l["cagr"] or 0)) ** t for l in legs)
        if val >= target:
            return round(t, 2)
    return None


def _alt_universe(settings: dict, extra: list[str] | None) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for b in settings.get("benchmarks") or []:
        if b["symbol"] in seen:
            continue
        seen.add(b["symbol"])
        out.append({"symbol": b["symbol"], "name": b["name"]})
    for sym in extra or []:
        if sym and sym not in seen:
            seen.add(sym)
            out.append({"symbol": sym, "name": sym})
    return out


def _forward(amount: float, annual_cagr: float | None, years: float) -> float:
    return amount * (1 + (annual_cagr or 0)) ** years


def recovery_analysis(instrument_id: int, settings: dict, horizon_years: float = 5,
                      alternatives: list[str] | None = None) -> dict:
    inst = repo.get_instrument(instrument_id)
    if not inst:
        raise ValueError("Instrument not found")
    txs = repo.get_transactions(instrument_id)
    pos = build_position(inst, txs, settings["tax"])["position"]

    invested = pos.get("investedCHF") or 0.0
    value = pos.get("currentValueCHF") or 0.0
    proceeds = _proceeds_chf(pos, settings)
    target = invested  # break-even = recover the capital originally deployed
    hold_cagr = pos["metrics"]["cagr"]

    rows: list[dict] = []
    for alt in _alt_universe(settings, alternatives):
        if alt["symbol"] == inst["symbol"]:
            continue
        g = benchmark_cagr(alt["symbol"])
        rows.append({
            "symbol": alt["symbol"], "name": alt["name"],
            "cagr": g,
            "recoveryYears": _recovery_years(proceeds, target, g),
            "expectedValueCHF": _forward(proceeds, g, horizon_years),
        })

    # Rank: fastest recovery first (None recovery sinks to the bottom).
    def _key(r):
        ry = r["recoveryYears"]
        return (ry is None, ry if ry is not None else 1e9, -(r["cagr"] or -1))
    rows.sort(key=_key)
    fastest = next((r for r in rows if r["recoveryYears"] is not None), None)

    # Multi-asset combinations: top-2 and top-3 by CAGR, proceeds split evenly.
    by_cagr = sorted([r for r in rows if r["cagr"]], key=lambda r: -(r["cagr"] or 0))
    combos: list[dict] = []
    for k in (2, 3):
        picks = by_cagr[:k]
        if len(picks) < k:
            continue
        legs = [{"symbol": p["symbol"], "name": p["name"], "cagr": p["cagr"],
                 "allocationPct": 1 / k, "amountCHF": proceeds / k} for p in picks]
        combos.append({
            "targets": legs,
            "recoveryYears": _blended_recovery_years(legs, target),
            "expectedValueCHF": sum(_forward(l["amountCHF"], l["cagr"], horizon_years) for l in legs),
            "blendedCagr": sum((l["cagr"] or 0) for l in legs) / k,
        })

    hold_expected = _forward(value, hold_cagr, horizon_years)

    return {
        "instrumentId": instrument_id, "symbol": inst["symbol"], "name": inst["name"],
        "investedCHF": invested, "currentValueCHF": value, "proceedsCHF": proceeds,
        "targetCHF": target, "horizonYears": horizon_years,
        "holdCagr": hold_cagr, "holdReturnPct": pos["metrics"]["percentPL"],
        "holdExpectedValueCHF": hold_expected,
        "alternatives": rows,
        "fastest": fastest,
        "singleBest": rows[0] if rows else None,
        "combinations": combos,
    }


def simulate_reinvest(sell_ids: list[int], targets: list[dict], settings: dict,
                      horizon_years: float = 5) -> dict:
    """Simulate selling a set of holdings today and reinvesting the proceeds into one or
    more targets (`[{symbol, name?, allocationPct}]`), vs simply holding."""
    tax = settings["tax"]
    sold: list[dict] = []
    proceeds = 0.0
    invested = 0.0
    hold_value_now = 0.0
    hold_expected = 0.0
    for iid in sell_ids:
        inst = repo.get_instrument(iid)
        if not inst:
            continue
        pos = build_position(inst, repo.get_transactions(iid), tax)["position"]
        p = _proceeds_chf(pos, settings)
        proceeds += p
        invested += pos.get("investedCHF") or 0.0
        v = pos.get("currentValueCHF") or 0.0
        hold_value_now += v
        hold_expected += _forward(v, pos["metrics"]["cagr"], horizon_years)
        sold.append({"instrumentId": iid, "symbol": inst["symbol"], "name": inst["name"],
                     "proceedsCHF": p, "cagr": pos["metrics"]["cagr"]})

    # normalise allocations
    alloc_total = sum(max(t.get("allocationPct") or 0, 0) for t in targets) or 1.0
    legs: list[dict] = []
    for t in targets:
        pct = max(t.get("allocationPct") or 0, 0) / alloc_total
        g = benchmark_cagr(t["symbol"])
        amount = proceeds * pct
        legs.append({"symbol": t["symbol"], "name": t.get("name") or t["symbol"],
                     "allocationPct": pct, "amountCHF": amount, "cagr": g,
                     "expectedValueCHF": _forward(amount, g, horizon_years)})

    reinvest_expected = sum(l["expectedValueCHF"] for l in legs)
    recovery_years = _blended_recovery_years(legs, invested)

    return {
        "sold": sold, "targets": legs,
        "proceedsCHF": proceeds, "investedCHF": invested,
        "horizonYears": horizon_years,
        "reinvestExpectedValueCHF": reinvest_expected,
        "holdValueNowCHF": hold_value_now,
        "holdExpectedValueCHF": hold_expected,
        "deltaVsHoldCHF": reinvest_expected - hold_expected,
        "recoveryYears": recovery_years,
        "blendedCagr": sum((l["cagr"] or 0) * l["allocationPct"] for l in legs),
    }

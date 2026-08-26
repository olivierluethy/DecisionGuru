"""Decision engine — explainable Buy / Hold / Sell recommendations.

Rules-based, never a black box: every recommendation is ranked by capital at stake and
carries an explicit reason, a quantified CHF impact, the exact reinvest target
(name + ticker + allocation), and — for sells — the ETF's recovery time for the current
shortfall. Reuses the canonical calc layer (`build_position`, `compute_counterfactual`)
so figures reconcile with every other page.

Signals:
  • SELL   — capital lagging the best alternative by a material margin & CHF amount.
  • TRIM   — a single holding dominates the book (concentration risk).
  • HOLD   — tracking or ahead of the best alternative; no action needed.
  • BUY    — idle cash that could be deployed into the benchmark.
"""
from __future__ import annotations

import math

import pandas as pd

from . import account as acct
from . import repo
from .counterfactual import compute_counterfactual
from .finance import build_position
from .finance_math import years_between

MIN_YEARS = 0.5
# A holding is a SELL candidate when the best alternative beat it by at least this
# fraction of the counterfactual value AND by at least this many CHF.
SELL_LAG_PCT = 0.08
SELL_MIN_IMPACT_CHF = 300.0
# Softer band → TRIM / watch rather than outright sell.
WATCH_LAG_PCT = 0.04
# A single holding above this share of the book is a concentration flag.
CONCENTRATION_WEIGHT = 0.25
# Idle cash above this is worth deploying.
CASH_DEPLOY_MIN_CHF = 1000.0


def _pct(v: float | None) -> str:
    return f"{v * 100:.1f}%" if v is not None else "n/a"


def _chf(v: float) -> str:
    return f"CHF {v:,.0f}".replace(",", "'")


def _recovery_months(shortfall_ratio: float, etf_cagr: float | None) -> float | None:
    if not etf_cagr or etf_cagr <= 0 or shortfall_ratio <= 1:
        return None
    monthly = (1 + etf_cagr) ** (1 / 12) - 1
    if monthly <= 0:
        return None
    m = math.log(shortfall_ratio) / math.log(1 + monthly)
    return m if math.isfinite(m) else None


def build_recommendations(settings: dict) -> dict:
    today = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    default_bench = settings["defaultBenchmarkSymbol"]
    bench_name = next((b["name"] for b in settings.get("benchmarks") or []
                       if b["symbol"] == default_bench), default_bench)

    recs: list[dict] = []
    total_value = 0.0
    priced_positions: list[dict] = []

    for inst in repo.list_instruments():
        txs = repo.get_transactions(inst["id"])
        if not txs:
            continue
        pos = build_position(inst, txs, settings["tax"])["position"]
        if pos["openQuantity"] <= 0 or not pos.get("currentValueCHF"):
            continue
        total_value += pos["currentValueCHF"] or 0
        priced_positions.append((inst, txs, pos))

    for inst, txs, pos in priced_positions:
        invested = pos["investedCHF"] or 0.0
        value = pos["currentValueCHF"] or 0.0
        weight = (value / total_value) if total_value > 0 else 0.0
        since = min(t["date"] for t in txs)
        horizon_ok = years_between(since, today) >= MIN_YEARS

        # Decision baseline = the canonical default benchmark (the whole app is framed
        # "vs VWRL"). One counterfactual per holding — same cost as /portfolio. The
        # decision-analysis view explores alternative reinvest targets in depth.
        best = None
        if horizon_ok:
            cf = compute_counterfactual(inst, txs, default_bench, settings, False)
            if cf["counterfactualValueCHF"] > 0:
                best = cf
        # opportunity cost: + means the ETF would be ahead (you are behind).
        opp_cost = (best["counterfactualValueCHF"] - best["actualValueCHF"]) if best else 0.0
        lag_pct = -(best["deltaPct"] or 0.0) if best else 0.0  # + when behind
        hold_ret = ((value + pos["realizedCHF"] - invested) / invested) if invested > 0 else None
        cagr = pos["metrics"]["cagr"]
        xirr = pos["metrics"]["xirr"]

        action = "hold"
        conviction = "low"
        reinvest = None
        recovery_months = None

        if best and lag_pct >= SELL_LAG_PCT and opp_cost >= SELL_MIN_IMPACT_CHF:
            action = "sell"
            conviction = "high" if (lag_pct >= 2 * SELL_LAG_PCT and opp_cost >= 3 * SELL_MIN_IMPACT_CHF) else "medium"
            etf_cagr = None
            yrs = years_between(since, today)
            if yrs > 0 and best["counterfactualValueCHF"] > 0:
                etf_cagr = (best["counterfactualValueCHF"] / max(invested, 1e-9)) ** (1 / yrs) - 1
            ratio = (best["counterfactualValueCHF"] / value) if value > 0 else 1
            rm = _recovery_months(ratio, etf_cagr)
            recovery_months = round(rm, 1) if rm is not None else None
            reinvest = [{
                "symbol": best["benchmarkSymbol"], "name": best["benchmarkName"],
                "allocationPct": 1.0, "amountCHF": value,
            }]
            reason = (
                f"{inst['name']} has trailed {best['benchmarkName']} ({best['benchmarkSymbol']}) "
                f"by {_chf(opp_cost)} ({_pct(lag_pct)}) since {since}. "
                f"The same capital in {best['benchmarkSymbol']} would be worth {_chf(best['counterfactualValueCHF'])} today "
                f"versus {_chf(value)} held — an inefficient allocation of {_chf(value)}."
            )
            impact = opp_cost
        elif weight >= CONCENTRATION_WEIGHT:
            action = "trim"
            conviction = "medium"
            reinvest = [{
                "symbol": default_bench, "name": bench_name,
                "allocationPct": 1.0, "amountCHF": max(value - CONCENTRATION_WEIGHT * total_value, 0),
            }]
            reason = (
                f"{inst['name']} is {_pct(weight)} of the portfolio ({_chf(value)}) — above the "
                f"{_pct(CONCENTRATION_WEIGHT)} single-holding guide. Trimming to target and moving the "
                f"excess into {bench_name} ({default_bench}) would cut concentration risk."
            )
            impact = max(value - CONCENTRATION_WEIGHT * total_value, 0)
        elif best and lag_pct >= WATCH_LAG_PCT:
            action = "hold"
            conviction = "low"
            reason = (
                f"{inst['name']} is modestly behind {best['benchmarkSymbol']} "
                f"({_chf(opp_cost)}, {_pct(lag_pct)}) since {since} — within the watch band, not yet a sell."
            )
            impact = opp_cost
        else:
            action = "hold"
            conviction = "medium" if (best and opp_cost < 0) else "low"
            ahead = -opp_cost
            if best and ahead > 0:
                reason = (
                    f"{inst['name']} is ahead of the best alternative "
                    f"({best['benchmarkSymbol']}) by {_chf(ahead)} since {since} — keep holding."
                )
            else:
                reason = (
                    f"{inst['name']} is tracking its alternatives; return {_pct(hold_ret)} "
                    f"since {since}. No reallocation warranted."
                )
            impact = -opp_cost if best else 0.0

        recs.append({
            "instrumentId": inst["id"], "symbol": inst["symbol"], "name": inst["name"],
            "isin": inst.get("isin"), "kind": inst.get("kind"),
            "action": action, "conviction": conviction,
            "investedCHF": invested, "currentValueCHF": value, "weight": weight,
            "holdingReturnPct": hold_ret, "holdingCagr": cagr, "holdingXirr": xirr,
            "benchmarkSymbol": best["benchmarkSymbol"] if best else default_bench,
            "benchmarkName": best["benchmarkName"] if best else bench_name,
            "benchmarkReturnPct": (
                ((best["counterfactualValueCHF"] - invested) / invested)
                if best and invested > 0 else None),
            "opportunityCostCHF": opp_cost,
            "recoveryMonths": recovery_months,
            "impactCHF": impact,
            "sinceDate": since,
            "reason": reason,
        })

    # Rank: sells/trims first (by CHF impact), then holds.
    order = {"sell": 0, "trim": 1, "hold": 2, "buy": 3}
    recs.sort(key=lambda r: (order.get(r["action"], 9), -abs(r["impactCHF"])))

    # Idle-cash BUY signal.
    events = repo.all_account_events()
    cash = acct.cash_chf(events, today)["totalCHF"] if events else 0.0
    cash_signal = None
    if cash >= CASH_DEPLOY_MIN_CHF:
        cash_signal = {
            "action": "buy", "cashCHF": cash,
            "symbol": default_bench, "name": bench_name, "allocationPct": 1.0,
            "amountCHF": cash,
            "reason": (
                f"{_chf(cash)} of idle cash is not invested. Deploying it into {bench_name} "
                f"({default_bench}) puts it to work at the benchmark's historical return."
            ),
        }

    counts = {"sell": 0, "trim": 0, "hold": 0, "buy": 0}
    for r in recs:
        counts[r["action"]] = counts.get(r["action"], 0) + 1
    total_opp = sum(r["opportunityCostCHF"] for r in recs if r["action"] in ("sell", "trim"))

    return {
        "recommendations": recs,
        "cashSignal": cash_signal,
        "summary": {
            "counts": counts,
            "reallocatableCHF": sum(r["impactCHF"] for r in recs if r["action"] in ("sell", "trim")),
            "totalOpportunityCostCHF": total_opp,
            "portfolioValueCHF": total_value,
            "idleCashCHF": cash,
        },
    }

"""Decisions view — the portfolio-wide list of Buy more / Hold / Sell verdicts.

Each holding's verdict comes from the single shared recommendation engine
(`services/verdict.py`), which blends valuation (fair-value band, margin of safety,
upside), the Buffett quality scorecard and the benchmark opportunity cost into one
deterministic verdict. This module only *assembles* those verdicts for the portfolio and
attaches the Decisions-specific extras: a CHF impact for ranking, the reinvest target and
the ETF's recovery time for Sell verdicts, a concentration trim note, and the idle-cash
buy signal. Reuses the canonical calc layer (`build_position`, `compute_counterfactual`)
so figures reconcile with every other page.

Crucially, benchmark underperformance alone never yields a Sell here — a fundamentally
sound, undervalued holding that merely lags the benchmark resolves to Hold or Buy more.
"""
from __future__ import annotations

import math

import pandas as pd

from . import account as acct
from . import repo
from .counterfactual import compute_counterfactual
from .finance import build_position
from .finance_math import years_between
from .fundamentals import get_cached_fundamentals
from .valuation import value_analysis
from .verdict import resolve_verdict

# Canonical verdict → the legacy per-position action label the Decisions view groups by.
_VERDICT_ACTION = {"buy-more": "buy", "hold": "hold", "sell": "sell"}

MIN_YEARS = 0.5
# A single holding above this share of the book is a concentration flag (a trim note on a
# Hold — never a sell on its own). Benchmark underperformance no longer drives the verdict;
# valuation and fundamentals do (see services/verdict.py).
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
    # Fetch the account ledger once; reused for per-holding dividends and the cash signal.
    events = repo.all_account_events()

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

        # Real account-statement dividends for this holding (net = gross − withholding).
        acc_divs = acct.dividend_events_chf(events, inst.get("isin"), today)
        net_div_chf = sum(ad["chf"] for ad in acc_divs)

        # Decision baseline = the canonical default benchmark (the whole app is framed
        # "vs VWRL"). One counterfactual per holding — same cost as /portfolio. The
        # decision-analysis view explores alternative reinvest targets in depth.
        best = None
        if horizon_ok:
            cf = compute_counterfactual(inst, txs, default_bench, settings, False,
                                        account_dividends=acc_divs)
            if cf["counterfactualValueCHF"] > 0:
                best = cf
        # opportunity cost: + means the ETF would be ahead (you are behind).
        opp_cost = (best["counterfactualValueCHF"] - best["actualValueCHF"]) if best else 0.0
        lag_pct = -(best["deltaPct"] or 0.0) if best else 0.0  # + when behind
        # Your return counts every gain: market move + realised P/L + net dividends received.
        hold_ret = ((value + pos["realizedCHF"] + net_div_chf - invested) / invested) if invested > 0 else None
        cagr = pos["metrics"]["cagr"]
        xirr = pos["metrics"]["xirr"]

        # --- Single shared engine: valuation + fundamentals + benchmark performance ---
        # Valuation off cached fundamentals only (no extra provider call); None-safe.
        cached = get_cached_fundamentals(inst["symbol"])
        snap = (cached or {}).get("snapshot") or {}
        va = None
        if cached and snap:
            va = value_analysis(inst["symbol"], pos.get("currentPrice"),
                                snap.get("currency") or inst.get("currency"),
                                data=cached, settings=settings)
        performance = None
        if best:
            performance = {
                "deltaPct": best["deltaPct"],
                "benchmarkSymbol": best["benchmarkSymbol"],
                "benchmarkName": best["benchmarkName"],
                "opportunityCostCHF": opp_cost,
            }
        v = resolve_verdict(va, performance=performance, held=True, position=pos, settings=settings)
        action = _VERDICT_ACTION[v["verdict"]]
        conviction = v["confidence"]

        # Concentration risk is a portfolio-level trim note on a Hold — it never becomes a
        # sell, and never overrides a valuation-driven Sell/Buy more.
        if action != "sell" and weight >= CONCENTRATION_WEIGHT:
            note = (
                f"{_pct(weight)} of the portfolio ({_chf(value)}) — above the "
                f"{_pct(CONCENTRATION_WEIGHT)} single-holding guide; consider trimming into "
                f"{bench_name} ({default_bench})."
            )
            v["trimNote"] = f"{v['trimNote']} {note}" if v.get("trimNote") else note

        reinvest = None
        recovery_months = None
        # A Sell verdict (sell zone) — offer the reinvest target + the ETF's recovery time.
        if action == "sell" and best:
            etf_cagr = None
            yrs = years_between(since, today)
            if yrs > 0 and best["counterfactualValueCHF"] > 0:
                etf_cagr = (best["counterfactualValueCHF"] / max(invested, 1e-9)) ** (1 / yrs) - 1
            ratio = (best["counterfactualValueCHF"] / value) if value > 0 else 1
            rm = _recovery_months(ratio, etf_cagr)
            recovery_months = round(rm, 1) if rm is not None else None
            reinvest = [{
                "symbol": default_bench, "name": bench_name,
                "allocationPct": 1.0, "amountCHF": value,
            }]

        # Ranking impact: sells by the after-tax gain realised, buys by discount captured,
        # holds by |opportunity cost| — so the biggest actionable items surface first.
        if action == "sell":
            impact = (v.get("afterTax") or {}).get("afterTaxGainIfSoldCHF") or value
        elif action == "buy":
            impact = abs((v["drivers"].get("marginOfSafetyPct") or 0.0) * value)
        else:
            impact = abs(opp_cost)

        recs.append({
            "instrumentId": inst["id"], "symbol": inst["symbol"], "name": inst["name"],
            "isin": inst.get("isin"), "kind": inst.get("kind"),
            "action": action, "conviction": conviction,
            "verdict": v,
            "investedCHF": invested, "currentValueCHF": value, "weight": weight,
            "holdingReturnPct": hold_ret, "holdingCagr": cagr, "holdingXirr": xirr,
            "benchmarkSymbol": best["benchmarkSymbol"] if best else default_bench,
            "benchmarkName": best["benchmarkName"] if best else bench_name,
            "benchmarkReturnPct": (
                ((best["counterfactualValueCHF"] - invested) / invested)
                if best and invested > 0 else None),
            "opportunityCostCHF": opp_cost,
            "reinvest": reinvest,
            "recoveryMonths": recovery_months,
            "impactCHF": impact,
            "sinceDate": since,
            "reason": v["rationale"],
        })

    # Rank: sells first, then buy-more opportunities, then holds — each by CHF impact.
    order = {"sell": 0, "buy": 1, "hold": 2}
    recs.sort(key=lambda r: (order.get(r["action"], 9), -abs(r["impactCHF"])))

    # Idle-cash BUY signal (reuses the ledger fetched above).
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

    counts = {"sell": 0, "buy": 0, "hold": 0}
    for r in recs:
        counts[r["action"]] = counts.get(r["action"], 0) + 1
    # Reallocatable = the after-tax value freed by acting on Sell verdicts.
    total_opp = sum(r["opportunityCostCHF"] for r in recs if r["action"] == "sell")

    return {
        "recommendations": recs,
        "cashSignal": cash_signal,
        "summary": {
            "counts": counts,
            "reallocatableCHF": sum(r["impactCHF"] for r in recs if r["action"] == "sell"),
            "totalOpportunityCostCHF": total_opp,
            "portfolioValueCHF": total_value,
            "idleCashCHF": cash,
        },
    }

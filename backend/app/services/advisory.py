"""Advisory / "harmonize" — turns holdings into rebalancing insights.

For each current holding with a long-enough horizon, compares it against every
benchmark ETF over the *same* period (cached data only) and, when the holding
materially lagged the best alternative, emits a plain-language insight with the
reallocation delta. Analytical/educational only — not financial advice.
"""
from __future__ import annotations

import pandas as pd

from . import repo
from .counterfactual import compute_counterfactual
from .finance import build_position
from .finance_math import years_between
from .fundamentals import get_cached_fundamentals
from .verdict import verdict_for, performance_from_counterfactual

# A holding is flagged when the best alternative ETF beat it by at least this much
# over the shared horizon (fraction of invested capital) — filters out noise.
LAG_PCT_THRESHOLD = 0.05
MIN_YEARS = 1.0


def _rationale(name: str, invested: float, since: str, hold_pct: float | None,
               etf: str, etf_pct: float | None, gain: float) -> str:
    def pct(v: float | None) -> str:
        return f"{v * 100:.1f}%" if v is not None else "n/a"

    return (
        f"You invested CHF {invested:,.0f} in {name} since {since}. "
        f"Since then it returned {pct(hold_pct)}. Over the same period {etf} returned {pct(etf_pct)}. "
        f"Reallocating would have produced CHF {gain:,.0f} more."
    ).replace(",", "'")


def build_advisory(settings: dict, include_handled: bool = False) -> list[dict]:
    today = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    benchmarks = settings.get("benchmarks") or []
    default_bench = settings["defaultBenchmarkSymbol"]
    handled = set(settings.get("advisoryHandled") or [])

    insights: list[dict] = []
    for inst in repo.list_instruments():
        txs = repo.get_transactions(inst["id"])
        if not txs:
            continue
        pos = build_position(inst, txs, settings["tax"])["position"]
        if pos["openQuantity"] <= 0:
            continue
        since = min(t["date"] for t in txs)
        if years_between(since, today) < MIN_YEARS:
            continue

        # Best alternative = the ETF the holding lagged the most (most negative delta).
        best = None
        for b in benchmarks:
            if b["symbol"] == inst["symbol"]:
                continue
            cf = compute_counterfactual(inst, txs, b["symbol"], settings, False)
            if cf["counterfactualValueCHF"] <= 0:
                continue
            if best is None or cf["deltaCHF"] < best["deltaCHF"]:
                best = cf
        if best is None:
            continue

        invested = pos["investedCHF"] or 0.0
        realloc_gain = best["counterfactualValueCHF"] - best["actualValueCHF"]  # = -deltaCHF
        lag_pct = (best["deltaPct"] or 0)  # negative when the ETF won
        flagged = realloc_gain > 0 and lag_pct <= -LAG_PCT_THRESHOLD
        is_handled = inst["id"] in handled
        if not flagged:
            continue
        if is_handled and not include_handled:
            continue

        hold_pct = ((best["actualValueCHF"] - invested) / invested) if invested > 0 else None
        etf_pct = ((best["counterfactualValueCHF"] - invested) / invested) if invested > 0 else None

        # The unified verdict — same engine and same (default) benchmark as Decisions and
        # the Overview, so a holding never shows "reallocate" here while reading Buy more
        # elsewhere. An undervalued, sound name that merely lags resolves to Hold/Buy more
        # with a conflict note; the reallocation figure stays as factual context, not a sell.
        cf_default = (best if best["benchmarkSymbol"] == default_bench
                      else compute_counterfactual(inst, txs, default_bench, settings, False))
        verdict = verdict_for(
            inst["symbol"], pos.get("currentPrice"), inst.get("currency"),
            get_cached_fundamentals(inst["symbol"]), settings,
            performance=performance_from_counterfactual(cf_default), held=True, position=pos)

        insights.append({
            "instrumentId": inst["id"],
            "symbol": inst["symbol"],
            "name": inst["name"],
            "isin": inst.get("isin"),
            "investedCHF": invested,
            "sinceDate": since,
            "holdingValueCHF": best["actualValueCHF"],
            "holdingReturnPct": hold_pct,
            "referenceEtf": best["benchmarkSymbol"],
            "referenceEtfName": best["benchmarkName"],
            "referenceValueCHF": best["counterfactualValueCHF"],
            "referenceReturnPct": etf_pct,
            "reallocationGainCHF": realloc_gain,
            "lagPct": lag_pct,
            "series": best["series"],
            "handled": is_handled,
            "verdict": verdict,
            "rationale": _rationale(inst["name"], invested, since, hold_pct,
                                    best["benchmarkSymbol"], etf_pct, realloc_gain),
        })

    # Biggest reallocation opportunity first.
    insights.sort(key=lambda i: -i["reallocationGainCHF"])
    return insights


def set_handled(settings: dict, instrument_id: int, handled: bool) -> list[int]:
    current = set(settings.get("advisoryHandled") or [])
    if handled:
        current.add(instrument_id)
    else:
        current.discard(instrument_id)
    return sorted(current)

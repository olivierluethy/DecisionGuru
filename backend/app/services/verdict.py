"""The single shared recommendation engine — one canonical Buy more / Hold / Sell verdict.

Every surface that recommends an action (Overview, Decisions, Advisory, Discover,
Watchlist, per-position detail) consumes THIS module and renders its output verbatim —
no view computes its own buy/sell/hold logic, so the same asset always shows the same
verdict everywhere.

It does not re-derive fair value, margin of safety, the quality scorecard or the
benchmark opportunity cost — those engines already exist (`valuation.value_analysis`,
`counterfactual.compute_counterfactual`). It *blends* their outputs into one verdict.

The defect this exists to eliminate: **benchmark underperformance alone must never
produce a Sell.** Underperformance of a fundamentally sound, undervalued asset is a
potential add, not a sell trigger. Valuation and fundamentals gate the verdict; benchmark
performance only tips the rationale, it never forces a sell.

Deterministic resolution rules (precedence):
  1. Sell zone (price ≥ fair × 1.40) → Sell (no remaining upside; realise it, tax-free).
  2. Overvalued (above fair, below sell zone) → Hold + "consider trimming" note.
  3. Undervalued + strong margin of safety + strong fundamentals → Buy more.
  4. Undervalued + strong MoS but weak/deteriorating fundamentals → Hold + value-trap caution.
  5. Fairly valued → Hold.
  6. Benchmark underperformance by itself is never sufficient for Sell.
"""
from __future__ import annotations

# Verdict of a value-investing check whose fundamentals we trust: quality is "strong"
# at or above half the scorecard AND earnings not actively deteriorating (aligned with the
# screener's quality_ok = 0.5).
STRONG_QUALITY_FRAC = 0.5
# vs-benchmark performance band: within ±4% of the benchmark reads as "inline" (matches the
# recommend.py watch band). Beyond it the holding out/under-performs.
PERF_BAND = 0.04

LABELS = {"buy-more": "Buy more", "hold": "Hold", "sell": "Sell"}
_CONF_ORDER = {"high": 2, "medium": 1, "low": 0}


def _pct(v: float | None, digits: int = 0) -> str:
    return f"{v * 100:.{digits}f}%" if v is not None else "n/a"


def _demote(conf: str, to: str = "medium") -> str:
    """Lower confidence to `to` when it is currently higher (signals disagree)."""
    return to if _CONF_ORDER.get(to, 1) < _CONF_ORDER.get(conf, 1) else conf


def _find_check(checks: list[dict], label: str) -> dict | None:
    return next((c for c in checks if c.get("label") == label), None)


def earnings_trend(va: dict | None) -> str | None:
    """Classify the earnings direction from the quality scorecard: improving (both the
    near-term growth and the long-run trend pass), deteriorating (both fail), else flat."""
    if not va:
        return None
    checks = (va.get("quality") or {}).get("checks") or []
    near = _find_check(checks, "Earnings growing")
    longrun = _find_check(checks, "Positive long-run earnings trend")
    passes = [bool(c["pass"]) for c in (near, longrun) if c is not None]
    if not passes:
        return None
    if all(passes):
        return "improving"
    if not any(passes):
        return "deteriorating"
    return "flat"


def classify_performance(delta_pct: float | None) -> str | None:
    """Map a counterfactual deltaPct (actual − ETF, ÷ ETF) onto a plain read.
    Negative delta = the ETF won = you underperform."""
    if delta_pct is None:
        return None
    if delta_pct <= -PERF_BAND:
        return "underperform"
    if delta_pct >= PERF_BAND:
        return "outperform"
    return "inline"


def _after_tax_frame(position: dict | None, settings: dict | None) -> dict | None:
    """After-tax gain if the open lots were sold now, in the app's Swiss framing. Reused so
    a Sell verdict states the same tax fact as the sell-signal panel. None when not held."""
    if not position or not settings:
        return None
    tax = settings.get("tax") or {}
    gain_chf = position.get("unrealizedCHF") or 0.0
    value_chf = position.get("currentValueCHF") or 0.0
    cgt = max(gain_chf, 0.0) * tax.get("marginalIncomeRate", 0.0) if tax.get("capitalGainsTaxable") else 0.0
    stamp = value_chf * (tax.get("stampDutyRate") or 0.0)
    note = (
        "This gain is tax-free — Switzerland does not tax capital gains on private movable assets."
        if not tax.get("capitalGainsTaxable")
        else f"As a professional trader the gain is taxed at your marginal rate (≈CHF {cgt:,.0f})."
    )
    return {
        "unrealizedGainCHF": round(gain_chf, 2),
        "capitalGainsTaxCHF": round(cgt, 2),
        "afterTaxGainIfSoldCHF": round(gain_chf - cgt - stamp, 2),
        "taxNote": note,
    }


def resolve_verdict(va: dict | None, *, performance: dict | None = None, held: bool = False,
                    position: dict | None = None, settings: dict | None = None) -> dict:
    """Blend valuation + fundamentals + benchmark performance into one verdict.

    `va`          — a `valuation.value_analysis` payload (or None when it can't be valued).
    `performance` — {deltaPct, benchmarkSymbol, benchmarkName, opportunityCostCHF} or None.
    `held`        — whether this is an owned position (benchmark perf only applies then).
    Returns {verdict, label, confidence, drivers, rationale, conflictNote, trimNote,
             underperformanceCause, valueTrap, afterTax?}.
    """
    band_obj = (va or {}).get("band") if va else None
    band = band_obj.get("band") if band_obj else None
    band_label = band_obj.get("label") if band_obj else None
    mos = (va or {}).get("marginOfSafety") if va else None      # discount to fair value
    upside = mos                                                 # upside to fair value ≡ MoS
    quality = (va or {}).get("quality") if va else None
    q_score = quality.get("score") if quality else None
    q_max = quality.get("max") if quality else None
    q_frac = (q_score / q_max) if (q_score is not None and q_max) else None
    trend = earnings_trend(va)

    # Fundamentals are "strong" when quality clears the bar and earnings aren't declining.
    strong_fund = (q_frac is not None and q_frac >= STRONG_QUALITY_FRAC and trend != "deteriorating")
    weak_fund = (q_frac is not None) and not strong_fund

    delta_pct = (performance or {}).get("deltaPct") if (held and performance) else None
    perf = classify_performance(delta_pct)
    lag_pct = (-delta_pct) if delta_pct is not None else None    # +ve = behind benchmark
    bench_sym = (performance or {}).get("benchmarkSymbol")
    bench_name = (performance or {}).get("benchmarkName") or bench_sym

    verdict = "hold"
    trim_note: str | None = None
    value_trap = False
    cause: str | None = None

    # --- Valuation & fundamentals gate the verdict (rules 1–5) ---
    if band == "significantly-overvalued":
        # Rule 1: in the sell zone there is no remaining upside → Sell.
        verdict = "sell"
    elif band == "overvalued":
        # Rule 2: above fair value but not the sell zone → Hold with a trim note. Price
        # alone never forces a sell when the business is still sound.
        verdict = "hold"
        trim_note = (
            "Trading above fair value — fundamentals still sound; consider trimming."
            if strong_fund else
            "Trading above fair value and fundamentals are softening — consider trimming."
        )
    elif band == "undervalued":
        if strong_fund:
            verdict = "buy-more"        # Rule 3
        else:
            verdict = "hold"            # Rule 4 — value-trap caution, never auto-buy
            value_trap = True
    elif band == "fair":
        verdict = "hold"               # Rule 5
    else:
        verdict = "hold"               # no fair-value estimate → cannot escalate

    # --- Cause of any underperformance (rule 5 of the decisions), for the rationale ---
    if held and perf == "underperform":
        # Weak/deteriorating fundamentals → the lag is a genuine concern. Otherwise the
        # lag is a temporary discount on an otherwise sound name (resolves to Hold/Buy more).
        cause = "fundamentals" if (weak_fund or trend == "deteriorating") else "temporary-discount"

    conflict = _build_conflict(verdict, perf, band, mos, upside, q_score, q_max,
                               lag_pct, bench_name, cause, has_va=bool(va and va.get("band")))
    rationale = _build_rationale(verdict, band_label, mos, q_score, q_max, perf, lag_pct,
                                 bench_name, value_trap, cause)

    # Confidence: start from the valuation engine's own read; demote when signals conflict
    # or when there's no valuation to stand on.
    conf = (va or {}).get("confidence") if va else None
    if not conf:
        conf = "low"
    if conflict:
        conf = _demote(conf, "medium")
    if not (va and va.get("band")):
        conf = "low"

    after_tax = _after_tax_frame(position, settings) if verdict == "sell" else None

    return {
        "verdict": verdict,
        "label": LABELS[verdict],
        "confidence": conf,
        "drivers": {
            "band": band,
            "bandLabel": band_label,
            "marginOfSafetyPct": mos,
            "upsidePct": upside,
            "qualityScore": q_score,
            "qualityMax": q_max,
            "earningsTrend": trend,
            "performance": perf,
            "lagPct": lag_pct,
            "benchmarkSymbol": bench_sym,
            "benchmarkName": bench_name,
            "opportunityCostCHF": (performance or {}).get("opportunityCostCHF") if held else None,
        },
        "rationale": rationale,
        "conflictNote": conflict,
        "trimNote": trim_note,
        "underperformanceCause": cause,
        "valueTrap": value_trap,
        "afterTax": after_tax,
    }


def verdict_for(symbol: str, price: float | None, currency: str | None, cached: dict | None,
                settings: dict | None, *, performance: dict | None = None, held: bool = False,
                position: dict | None = None) -> dict:
    """Convenience: value a symbol off *cached* fundamentals (no provider call) and resolve
    its verdict in one shot. Used by the portfolio/position endpoints, which have the cached
    fundamentals and (optionally) a benchmark counterfactual already to hand."""
    from .valuation import value_analysis  # lazy — avoids import order coupling

    snap = (cached or {}).get("snapshot") if cached else None
    va = None
    if cached and snap:
        va = value_analysis(symbol, price, currency or snap.get("currency"),
                            data=cached, settings=settings)
    return resolve_verdict(va, performance=performance, held=held, position=position,
                           settings=settings)


def performance_from_counterfactual(cf: dict | None) -> dict | None:
    """Shape a counterfactual result into the engine's `performance` input."""
    if not cf or not cf.get("counterfactualValueCHF"):
        return None
    return {
        "deltaPct": cf.get("deltaPct"),
        "benchmarkSymbol": cf.get("benchmarkSymbol"),
        "benchmarkName": cf.get("benchmarkName"),
        "opportunityCostCHF": (cf.get("counterfactualValueCHF") or 0) - (cf.get("actualValueCHF") or 0),
    }


def _build_conflict(verdict, perf, band, mos, upside, q_score, q_max, lag_pct,
                    bench_name, cause, *, has_va) -> str | None:
    """The one-line explanation shown only when the verdict overrides a signal."""
    q = f"{q_score}/{q_max}" if q_score is not None and q_max else "n/a"
    # Underperforming the benchmark yet rated Buy more — valuation wins (the core case).
    if verdict == "buy-more" and perf == "underperform":
        return (
            f"Lags {bench_name} by {_pct(lag_pct)}, but trades at a {_pct(mos)} margin of "
            f"safety with a sound quality score ({q}) — a temporary discount, not a reason "
            f"to sell → Buy more."
        )
    # Beating the benchmark yet rated Sell — it's simply in the sell zone now.
    if verdict == "sell" and perf == "outperform":
        return (
            f"Ahead of {bench_name} by {_pct(-lag_pct if lag_pct is not None else None)}, "
            f"but now trades above its sell zone — realise the gain (tax-free) → Sell."
        )
    # Held, lagging, but no fair-value estimate to justify a sell on the lag alone.
    if verdict == "hold" and perf == "underperform" and not has_va:
        return (
            f"Lags {bench_name} by {_pct(lag_pct)}, but there is no fair-value estimate to "
            f"confirm it is overvalued — holding rather than selling on the lag alone."
        )
    # Value trap: undervalued and lagging, yet fundamentals are weak → still not a sell.
    if verdict == "hold" and band == "undervalued" and perf == "underperform":
        return (
            f"Lags {bench_name} by {_pct(lag_pct)} and looks cheap, but the lag is "
            f"fundamentals-driven (quality {q}) — a possible value trap, held not bought."
        )
    return None


def _build_rationale(verdict, band_label, mos, q_score, q_max, perf, lag_pct,
                     bench_name, value_trap, cause) -> str:
    """Factual one-liner: the driving factors, then the resolved verdict. Product voice."""
    parts: list[str] = []
    if band_label:
        parts.append(band_label if band_label != "Fairly valued" else "Fairly valued")
    if mos is not None and mos > 0:
        parts.append(f"{_pct(mos)} margin of safety")
    elif mos is not None and mos < 0:
        parts.append(f"{_pct(-mos)} above fair value")
    if q_score is not None and q_max:
        parts.append(f"quality {q_score}/{q_max}")
    if perf == "underperform" and lag_pct is not None:
        tail = " (fundamentals-driven)" if cause == "fundamentals" else " (temporary discount)"
        parts.append(f"lags {bench_name} by {_pct(lag_pct)}{tail}")
    elif perf == "outperform" and lag_pct is not None:
        parts.append(f"beats {bench_name} by {_pct(-lag_pct)}")
    elif perf == "inline" and bench_name:
        parts.append(f"tracks {bench_name}")
    if value_trap:
        parts.append("weak fundamentals")
    body = " · ".join(p for p in parts if p) or "No valuation data"
    return f"{body} → {LABELS[verdict]}."

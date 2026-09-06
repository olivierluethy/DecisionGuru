"""Point-in-time reconstruction of Fair Value + zones from the annual statement lanes.

Each fiscal year becomes a valuation snapshot computed with ONLY the statement rows known
at that year (no look-ahead). It reuses the live valuation engine's model/zone helpers so
there is a single source of the financial formulas."""
from __future__ import annotations

from datetime import date, timedelta

from . import valuation as v
from ..providers.base import normalize_minor_currency

FILING_LAG_DAYS = 90


def _norm(value: float | None, ccy: str | None) -> float | None:
    if value is None:
        return None
    return normalize_minor_currency(value, ccy)[0]


def _by_year(rows: list[dict]) -> dict[int, dict]:
    return {r["year"]: r for r in rows if r.get("year") is not None}


def _year_inputs(year: int, history: list[dict], cashflow: dict, balance: dict,
                 fin_ccy: str | None, cfg: dict) -> dict | None:
    """Reconstructed as-of inputs + models + fair value for `year`, or None when not
    reconstructable (no valid model). Uses only statement rows with year <= `year`."""
    hist_upto = [h for h in history if h.get("year") is not None and h["year"] <= year]
    bal = _by_year(balance.get("years") or []).get(year)
    shares = (bal or {}).get("sharesOutstanding")
    if not shares or shares <= 0:
        return None  # per-share reconstruction impossible without that year's share count

    inc = _by_year(history).get(year) or {}
    ni = inc.get("netIncome")
    equity = (bal or {}).get("stockholdersEquity")
    eps = _norm(ni / shares, fin_ccy) if ni is not None else None
    bvps = _norm(equity / shares, fin_ccy) if equity is not None else None

    # normalized FCF/share = median of per-share FCF for years <= `year`, each divided by
    # THAT year's shares (point-in-time), mirroring the engine's median-of-series logic.
    bshares = {y: (r.get("sharesOutstanding")) for y, r in _by_year(balance.get("years") or []).items()}
    fcf_ps_series: list[float] = []
    for cf in (cashflow.get("years") or []):
        y = cf.get("year")
        if y is None or y > year:
            continue
        sh = bshares.get(y)
        fcf = cf.get("freeCashFlow")
        if sh and sh > 0 and fcf is not None:
            ps = _norm(fcf / sh, fin_ccy)
            if ps is not None:
                fcf_ps_series.append(ps)
    normalized_fcf_ps = round(v._median(fcf_ps_series), 2) if fcf_ps_series else None

    # Growth: reuse _pick_growth with an EMPTY snapshot so only the multi-year income CAGR
    # path fires (its exact semantics), then clamp exactly as the live engine does.
    g_used_raw, _ = v._pick_growth({}, hist_upto)
    g = v._clamp(g_used_raw, -0.05, v.GROWTH_CAP)

    # Unlike value_analysis's base_eps (which falls back to forward EPS), a historical
    # year has no forward estimate to fall back to — intentionally no fwd_eps fallback here.
    base_eps = eps if (eps and eps > 0) else None
    models = v.compute_models(eps, bvps, base_eps, g, normalized_fcf_ps, cfg)
    if not models:
        return None  # eligibility: at least one valid model required

    vals = sorted(x for x in models.values() if x and x > 0)
    fair_value = round(v._median(vals), 2) if vals else None
    if not fair_value or fair_value <= 0:
        return None

    return {
        "year": year,
        "periodEnd": (bal or {}).get("periodEnd") or inc.get("periodEnd"),
        "eps": round(eps, 2) if eps is not None else None,          # RECONSTRUCTED (≠ trailingEps)
        "bvps": round(bvps, 2) if bvps is not None else None,
        "fcfPerShare": normalized_fcf_ps,
        "growth": round(g, 4),
        "models": models,
        "fairValue": fair_value,
    }


def _effective_date(period_end: str | None, filing_date: str | None, year: int) -> tuple[str, str]:
    """Real filing date wins; else periodEnd + FILING_LAG_DAYS; else fiscal year-end + lag.
    yfinance has no filing date today, so in practice source is always "assumed"."""
    if filing_date:
        return filing_date, "filing"
    if period_end:
        try:
            d = date.fromisoformat(period_end) + timedelta(days=FILING_LAG_DAYS)
            return d.isoformat(), "assumed"
        except ValueError:
            pass
    # Last resort: fiscal year-end + lag.
    return (date(year, 12, 31) + timedelta(days=FILING_LAG_DAYS)).isoformat(), "assumed"


def _years_present(data: dict) -> list[int]:
    ys: set[int] = set()
    for r in (data.get("history") or []):
        if r.get("year") is not None:
            ys.add(r["year"])
    return sorted(ys)


def build_snapshots(data: dict, cfg: dict) -> list[dict]:
    """Assemble the reconstructed annual snapshot series: one snapshot per fiscal year
    with statement rows only up to that year (no look-ahead), sorted ascending by
    (asOf, fiscalYear)."""
    history = data.get("history") or []
    cashflow = data.get("cashflow") or {}
    balance = data.get("balance") or {}
    fin_ccy = data.get("financialCurrency")
    snaps: list[dict] = []
    for year in _years_present(data):
        inp = _year_inputs(year, history, cashflow, balance, fin_ccy, cfg)
        if inp is None:
            continue
        edges = v.zone_edges(inp["fairValue"], cfg)
        filing_date = (_by_year(balance.get("years") or []).get(year) or {}).get("filingDate")  # None today
        as_of, src = _effective_date(inp["periodEnd"], filing_date, year)
        snaps.append({
            "asOf": as_of,
            "effectiveDateSource": src,
            "fiscalPeriodEnd": inp["periodEnd"],
            "filingDate": filing_date,
            "fiscalYear": year,
            "fairValue": inp["fairValue"],
            "entryTarget": edges["entryTarget"],
            "overvaluedAt": edges["overvaluedAt"],
            "sellZoneAt": edges["sellZoneAt"],
            "inputs": {"eps": inp["eps"], "bvps": inp["bvps"],
                       "fcfPerShare": inp["fcfPerShare"], "growth": inp["growth"]},
            "models": inp["models"],
            "drivers": None,
        })
    snaps.sort(key=lambda s: (s["asOf"], s["fiscalYear"]))
    return snaps


_MODEL_KEYS = ("grahamNumber", "grahamGrowth", "dcf", "fcf")


def _delta(before: float | None, after: float | None) -> dict:
    """Observable before/after + a computed deltaPct/direction. NEVER attributes a share
    of the move to any input — this is a display helper, not a causal decomposition."""
    pct = None
    if before not in (None, 0) and after is not None:
        pct = round(after / before - 1, 4)
    if pct is None:
        direction = "flat"
    elif abs(pct) < 1e-9:
        direction = "flat"
    else:
        direction = "up" if pct > 0 else "down"
    return {"before": before, "after": after, "deltaPct": pct, "dir": direction}


def _model_delta(prev_models: dict, cur_models: dict, key: str) -> dict:
    """valid = the model produced a usable number THIS snapshot (after is not None);
    contributed = it was in the positive set used for the fair-value median. These are
    intentionally distinct fields — a model can be valid (computed) without contributing
    (e.g. a non-positive result excluded from the median)."""
    b, a = prev_models.get(key), cur_models.get(key)
    d = _delta(b, a)
    d["valid"] = a is not None
    d["contributed"] = a is not None and a > 0
    return d


def attach_drivers(snaps: list[dict]) -> None:
    """Mutates `snaps` in place: each snapshot from index 1 onward gets a `drivers` dict
    describing the before/after Fundamentals -> Models -> Fair Value -> Zones chain versus
    the prior snapshot. The first snapshot has no prior, so its `drivers` stays None."""
    for i in range(1, len(snaps)):
        prev, cur = snaps[i - 1], snaps[i]
        pin, cin = prev["inputs"], cur["inputs"]
        cur["drivers"] = {
            "inputs": {
                "eps": _delta(pin["eps"], cin["eps"]),
                "fcfPerShare": _delta(pin["fcfPerShare"], cin["fcfPerShare"]),
                "bvps": _delta(pin["bvps"], cin["bvps"]),
                "growth": _delta(pin["growth"], cin["growth"]),
            },
            "models": {k: _model_delta(prev["models"], cur["models"], k) for k in _MODEL_KEYS},
            "fairValue": _delta(prev["fairValue"], cur["fairValue"]),
            "zones": {
                "entryTarget": {"before": prev["entryTarget"], "after": cur["entryTarget"]},
                "overvaluedAt": {"before": prev["overvaluedAt"], "after": cur["overvaluedAt"]},
                "sellZoneAt": {"before": prev["sellZoneAt"], "after": cur["sellZoneAt"]},
            },
        }

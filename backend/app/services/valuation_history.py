"""Point-in-time reconstruction of Fair Value + zones from the annual statement lanes.

Each fiscal year becomes a valuation snapshot computed with ONLY the statement rows known
at that year (no look-ahead). It reuses the live valuation engine's model/zone helpers so
there is a single source of the financial formulas."""
from __future__ import annotations

from . import valuation as v
from ..providers.base import normalize_minor_currency


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

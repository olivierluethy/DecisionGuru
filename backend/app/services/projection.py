"""Break-even + forward projection — port of projection.ts."""
from __future__ import annotations

import math

import pandas as pd

from .finance_math import cagr
from .marketdata import get_dividends, get_history


def benchmark_cagr(symbol: str, lookback_years: int = 10) -> float | None:
    """TOTAL-return trailing CAGR (price appreciation + dividends over the window), so the
    forward-growth basis matches the counterfactual's total-return convention rather than the
    old dividend-blind price return (VALUE_INVESTING_AUDIT register #10, brief §9/§12). Note
    it is still a historical extrapolation — for a *business* projection, fundamentals-based
    growth is preferable (register #11, deferred)."""
    from_date = (pd.Timestamp.utcnow() - pd.DateOffset(years=lookback_years)).strftime("%Y-%m-%d")
    hist = get_history(symbol, from_date)
    if len(hist) < 2:
        return None
    start = hist[0]
    end = hist[-1]
    years = (pd.Timestamp(end["date"]) - pd.Timestamp(start["date"])).days / 365
    try:
        div_sum = sum((d.get("close") or 0.0) for d in get_dividends(symbol, from_date))
    except Exception:  # noqa: BLE001 — a dividend hiccup degrades to price-return, never fails
        div_sum = 0.0
    return cagr(start["close"], end["close"] + div_sum, years)


def compute_break_even(current_value_chf: float, invested_chf: float, etf_cagr: float) -> dict:
    realized_loss_chf = invested_chf - current_value_chf
    target = invested_chf
    months_to_recover: float | None = None
    if current_value_chf > 0 and target > current_value_chf and etf_cagr > 0:
        monthly_rate = (1 + etf_cagr) ** (1 / 12) - 1
        months_to_recover = math.log(target / current_value_chf) / math.log(1 + monthly_rate)
    elif target <= current_value_chf:
        months_to_recover = 0
    return {
        "realizedLossCHF": realized_loss_chf,
        "etfCagr": etf_cagr,
        "monthsToRecover": months_to_recover if (months_to_recover is not None and math.isfinite(months_to_recover)) else None,
        "targetValueCHF": target,
    }


def prospective_projection(
    symbol: str,
    benchmark: str,
    amount_chf: float = 10_000.0,
    years: float = 5.0,
    stock_cagr: float | None = None,
    etf_cagr: float | None = None,
) -> dict:
    """Forward opportunity cost for a *prospective* (not-yet-owned) investment.

    Given a hypothetical CHF amount invested today, project holding ``symbol`` vs the
    same money in ``benchmark``. Expected growth defaults to each asset's own historical
    CAGR (from cached history); when that is unavailable we fall back to a documented
    assumption and flag it, so the estimate never silently invents a trend. Purely
    symbol-driven — reuses the same math the held-position projection uses.
    """
    DEFAULT_STOCK_CAGR = 0.07
    DEFAULT_ETF_CAGR = 0.05

    stock_basis = "assumption"
    etf_basis = "assumption"

    if stock_cagr is None:
        hist_cagr = benchmark_cagr(symbol)
        if hist_cagr is not None:
            stock_cagr, stock_basis = hist_cagr, "history"
        else:
            stock_cagr = DEFAULT_STOCK_CAGR
    else:
        stock_basis = "override"

    if etf_cagr is None:
        hist_cagr = benchmark_cagr(benchmark)
        if hist_cagr is not None:
            etf_cagr, etf_basis = hist_cagr, "history"
        else:
            etf_cagr = DEFAULT_ETF_CAGR
    else:
        etf_basis = "override"

    result = project_hold_vs_etf(amount_chf, stock_cagr, etf_cagr, years)
    end = result["points"][-1] if result["points"] else {"hold": amount_chf, "etf": amount_chf}
    result.update({
        "symbol": symbol,
        "benchmark": benchmark,
        "amountCHF": amount_chf,
        "stockCagrBasis": stock_basis,
        "etfCagrBasis": etf_basis,
        # Opportunity cost at the horizon: how much more the stock is projected to make
        # over the ETF (negative = the ETF wins, i.e. holding the stock costs you).
        "endHoldCHF": end["hold"],
        "endEtfCHF": end["etf"],
        "advantageCHF": end["hold"] - end["etf"],
    })

    # Bear / base / bull range instead of a single deterministic point (register #11):
    # vary the stock growth ±3pp so the forecast communicates uncertainty.
    def _end_hold(cagr_value: float) -> float:
        pts = project_hold_vs_etf(amount_chf, cagr_value, etf_cagr, years)["points"]
        return pts[-1]["hold"] if pts else amount_chf

    bear_c, bull_c = stock_cagr - 0.03, stock_cagr + 0.03
    result["holdRange"] = {
        "bear": round(_end_hold(bear_c), 2), "base": round(end["hold"], 2),
        "bull": round(_end_hold(bull_c), 2),
        "bearCagr": round(bear_c, 4), "baseCagr": round(stock_cagr, 4), "bullCagr": round(bull_c, 4),
    }
    return result


def project_hold_vs_etf(current_value_chf: float, stock_cagr: float, etf_cagr: float, years: float) -> dict:
    months = round(years * 12)
    stock_monthly = (1 + stock_cagr) ** (1 / 12) - 1
    etf_monthly = (1 + etf_cagr) ** (1 / 12) - 1
    points: list[dict] = []
    crossover_month: int | None = None
    start = pd.Timestamp.utcnow().normalize()
    for m in range(months + 1):
        hold = current_value_chf * (1 + stock_monthly) ** m
        etf = current_value_chf * (1 + etf_monthly) ** m
        if crossover_month is None and m > 0 and etf >= hold:
            crossover_month = m
        points.append({"date": (start + pd.DateOffset(months=m)).strftime("%Y-%m-%d"),
                       "hold": hold, "etf": etf})
    return {"points": points, "assumedStockCagr": stock_cagr, "assumedEtfCagr": etf_cagr,
            "years": years, "crossoverMonth": crossover_month}

"""Break-even + forward projection — port of projection.ts."""
from __future__ import annotations

import math

import pandas as pd

from .finance_math import cagr
from .marketdata import get_history


def benchmark_cagr(symbol: str, lookback_years: int = 10) -> float | None:
    from_date = (pd.Timestamp.utcnow() - pd.DateOffset(years=lookback_years)).strftime("%Y-%m-%d")
    hist = get_history(symbol, from_date)
    if len(hist) < 2:
        return None
    start = hist[0]
    end = hist[-1]
    years = (pd.Timestamp(end["date"]) - pd.Timestamp(start["date"])).days / 365
    return cagr(start["close"], end["close"], years)


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

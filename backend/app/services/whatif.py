"""Hypothetical "sell & reinvest" what-if engine.

Answers: *what if I had sold this stock on a given date (at a given price) and put
the proceeds — or any chosen amount — into an ETF?* Compares that reinvested path
against simply having kept the shares, from the sale date to today, and sketches a
forward outlook.

Reuses the counterfactual/projection primitives so valuation, FX and dividend tax
stay consistent with the rest of the app. Simplification: wealth tax is excluded on
both sides (it roughly cancels), so this reads as a clean asset-vs-asset comparison.
"""
from __future__ import annotations

import math

import pandas as pd

from .counterfactual import _build_series, _make_lookup, _resolve_benchmark, _round2
from .fx import ensure_fx_range, get_fx_rate
from .marketdata import get_dividends, get_quote, price_on
from .projection import benchmark_cagr
from .tax import dividend_tax


def _qty_held_at(txs: list[dict], date: str) -> float:
    qty = 0.0
    for t in txs:
        if t.get("category") == "corporate_action" or t["date"] > date:
            continue
        if t["action"] == "buy":
            qty += t.get("quantity") or 0
        elif t["action"] == "sell":
            qty -= t.get("quantity") or 0
    return qty


def _stock_price_on(symbol: str, date: str, today: str) -> float | None:
    """Per-share price in the instrument's own currency."""
    if date >= today:
        try:
            q = get_quote(symbol)
            if q and q.get("price") and not q.get("pending"):
                return q["price"]
        except Exception:  # noqa: BLE001
            pass
    return price_on(symbol, date)


def compute_whatif_sale(
    instrument: dict,
    txs: list[dict],
    benchmark_symbol: str,
    settings: dict,
    *,
    sale_date: str | None = None,
    sale_price: float | None = None,
    reinvest_amount_chf: float | None = None,
    pre_tax: bool = False,
    forward_years: float = 5,
) -> dict:
    tax = settings["tax"]
    bench = _resolve_benchmark(benchmark_symbol, settings)
    inst_ccy = instrument["currency"]
    today = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    sale = sale_date or today
    if sale > today:
        sale = today

    qty = _qty_held_at(txs, sale)

    base = {
        "benchmark": bench["symbol"],
        "benchmarkName": bench["name"],
        "saleDate": sale,
        "currency": inst_ccy,
        "quantityHeld": qty,
    }

    if qty <= 0:
        # Nothing was held on that date — no meaningful reinvestment to model.
        return {**base, "salePrice": sale_price or 0.0, "proceedsCHF": 0.0,
                "reinvestAmountCHF": 0.0, "etfUnits": 0.0, "etfValueTodayCHF": 0.0,
                "holdValueTodayCHF": 0.0, "deltaCHF": 0.0, "deltaPct": 0.0,
                "series": [], "forward": None}

    ensure_fx_range([c for c in {"CHF", inst_ccy, bench["currency"]} if c], sale, today)
    stock_look = _make_lookup(instrument["symbol"], sale, inst_ccy)
    etf_look = _make_lookup(bench["symbol"], sale, bench["currency"])

    # --- Sale proceeds (Swiss private capital gains are tax-free; fees ignored) ---
    price_per_share = sale_price if sale_price is not None else _stock_price_on(
        instrument["symbol"], sale, today
    )
    price_per_share = price_per_share or 0.0
    proceeds_chf = qty * price_per_share * get_fx_rate(inst_ccy, "CHF", sale)
    reinvest_chf = reinvest_amount_chf if reinvest_amount_chf is not None else proceeds_chf

    # --- Reinvested ETF path ---
    etf_price_chf_sale = etf_look.price_chf_on(sale)
    units = reinvest_chf / etf_price_chf_sale if etf_price_chf_sale > 0 else 0.0

    etf_divs = get_dividends(bench["symbol"], sale)

    def etf_dist_to(date: str) -> float:
        total = 0.0
        for d in etf_divs:
            if d["date"] < sale or d["date"] > date:
                continue
            fx = get_fx_rate(bench["currency"], "CHF", d["date"])
            gross_chf = units * d["close"] * fx
            total += gross_chf if pre_tax else dividend_tax(gross_chf, bench["domicile"], tax).netAfterTaxCHF
        return total

    def etf_at(date: str) -> float:
        return units * etf_look.price_chf_on(date) + etf_dist_to(date)

    # --- Kept-holding path (the shares you would have sold) ---
    inst_divs = [t for t in txs if t["action"] == "dividend" and t.get("category") != "corporate_action"]

    def hold_dist_to(date: str) -> float:
        total = 0.0
        for d in inst_divs:
            if d["date"] < sale or d["date"] > date:
                continue
            gross = d["grossAmount"] if d.get("grossAmount") is not None else (d.get("quantity") or 0) * (d.get("unitPrice") or 0)
            fx = get_fx_rate(d.get("currency") or inst_ccy, "CHF", d["date"])
            gross_chf = gross * fx
            total += gross_chf if pre_tax else dividend_tax(gross_chf, instrument.get("domicile"), tax).netAfterTaxCHF
        return total

    def hold_at(date: str) -> float:
        return qty * stock_look.price_chf_on(date) + hold_dist_to(date)

    etf_value_today = etf_at(today)
    hold_value_today = hold_at(today)
    delta_chf = etf_value_today - hold_value_today
    delta_pct = delta_chf / hold_value_today if hold_value_today else 0.0

    series = _build_series(sale, today, hold_at, etf_at)

    # --- Forward outlook: compound each path from its own value today ---
    forward = _forward(hold_value_today, etf_value_today, instrument["symbol"],
                       bench, settings, forward_years)

    return {
        **base,
        "salePrice": _round2(price_per_share),
        "proceedsCHF": _round2(proceeds_chf),
        "reinvestAmountCHF": _round2(reinvest_chf),
        "etfUnits": units,
        "etfValueTodayCHF": _round2(etf_value_today),
        "holdValueTodayCHF": _round2(hold_value_today),
        "deltaCHF": _round2(delta_chf),
        "deltaPct": delta_pct,
        "series": series,
        "forward": forward,
    }


def _forward(hold_start: float, etf_start: float, stock_symbol: str, bench: dict,
             settings: dict, years: float) -> dict:
    stock_cagr = benchmark_cagr(stock_symbol) or 0.06
    etf_cagr = benchmark_cagr(bench["symbol"])
    if etf_cagr is None:
        etf_cagr = bench.get("incomeYield") or 0.06
    months = round(years * 12)
    stock_monthly = (1 + stock_cagr) ** (1 / 12) - 1
    etf_monthly = (1 + etf_cagr) ** (1 / 12) - 1
    start = pd.Timestamp.utcnow().normalize()
    points: list[dict] = []
    crossover_month: int | None = None
    for m in range(months + 1):
        hold = hold_start * (1 + stock_monthly) ** m
        etf = etf_start * (1 + etf_monthly) ** m
        if crossover_month is None and etf >= hold and (etf_start < hold_start):
            if m > 0:
                crossover_month = m
        points.append({"date": (start + pd.DateOffset(months=m)).strftime("%Y-%m-%d"),
                       "hold": _round2(hold), "etf": _round2(etf)})
    return {"points": points, "assumedStockCagr": stock_cagr, "assumedEtfCagr": etf_cagr,
            "years": years,
            "crossoverMonth": crossover_month if (crossover_month is not None and math.isfinite(crossover_month)) else None}

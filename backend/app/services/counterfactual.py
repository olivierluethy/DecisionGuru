"""Counterfactual engine — port of counterfactual.ts.

Mirrors every cash outflow into the stock as a purchase of the benchmark ETF on the same
date, rolls it forward, and returns the CHF opportunity-cost delta, after Swiss tax."""
from __future__ import annotations

import math

import pandas as pd

from ..reference.geo import country_from_symbol
from .finance_math import cagr, xirr, years_between
from .fx import ensure_fx_range, get_fx_rate
from .marketdata import ensure_history, get_dividends, get_quote, price_on
from .tax import dividend_tax, fund_income_tax_drag, wealth_tax


def _resolve_benchmark(symbol: str, settings: dict) -> dict:
    for b in settings["benchmarks"]:
        if b["symbol"] == symbol:
            return b
    return {
        "symbol": symbol, "name": symbol, "currency": "USD",
        "domicile": country_from_symbol(symbol) or "US",
        "incomeYield": settings["tax"]["defaultEtfIncomeYield"], "accumulating": False,
    }


class _Lookup:
    def __init__(self, ccy: str, symbol: str):
        self.ccy = ccy
        self._symbol = symbol

    def price_chf_on(self, date: str) -> float:
        p = price_on(self._symbol, date)
        if p is None:
            return 0.0
        return p * get_fx_rate(self.ccy, "CHF", date)


def _make_lookup(symbol: str, from_date: str, fallback_ccy: str) -> _Lookup:
    ensure_history(symbol, from_date)
    try:
        q = get_quote(symbol)
        ccy = q["currency"] or fallback_ccy
    except Exception:  # noqa: BLE001
        ccy = fallback_ccy
    return _Lookup(ccy, symbol)


def _round2(n: float) -> float:
    return round(n * 100) / 100


def _empty_result(bench: dict) -> dict:
    return {
        "benchmarkSymbol": bench["symbol"], "benchmarkName": bench["name"],
        "actualValueCHF": 0, "counterfactualValueCHF": 0, "deltaCHF": 0, "deltaPct": 0,
        "actualPreTaxCHF": 0, "counterfactualPreTaxCHF": 0,
        "actualXirr": None, "benchmarkXirr": None, "series": [], "recoveryMonths": None,
    }


def compute_counterfactual(instrument: dict, txs: list[dict], benchmark_symbol: str,
                          settings: dict, pre_tax: bool = False, as_of: str | None = None) -> dict:
    tax = settings["tax"]
    bench = _resolve_benchmark(benchmark_symbol, settings)
    today = as_of or pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    sorted_txs = sorted(
        [t for t in txs if t.get("category") != "corporate_action" and t["date"] <= today],
        key=lambda t: t["date"],
    )
    buys = [t for t in sorted_txs if t["action"] == "buy"]
    sells = [t for t in sorted_txs if t["action"] == "sell"]

    if not buys:
        return _empty_result(bench)

    first_date = sorted_txs[0]["date"]
    bought_qty = sum(t["quantity"] for t in buys)
    sold_qty = sum(t["quantity"] for t in sells)
    fully_closed = sold_qty >= bought_qty - 1e-9 and len(sells) > 0
    end_date = sells[-1]["date"] if fully_closed else today
    if pd.Timestamp(end_date) > pd.Timestamp(today):
        end_date = today

    currencies = {"CHF", instrument["currency"], bench["currency"]}
    for t in txs:
        currencies.add(t.get("currency"))
    ensure_fx_range([c for c in currencies if c], first_date, end_date)

    stock_look = _make_lookup(instrument["symbol"], first_date, instrument["currency"])
    etf_look = _make_lookup(bench["symbol"], first_date, bench["currency"])

    # --- Build ETF counterfactual units by mirroring each buy's CHF outflow ---
    etf_events: list[dict] = []
    etf_flows_after_tax: list[dict] = []
    for b in buys:
        cost_orig = b["quantity"] * b["unitPrice"] + (b.get("fees") or 0)
        fx_buy = get_fx_rate(b.get("currency") or instrument["currency"], "CHF", b["date"])
        cash_chf = cost_orig * fx_buy
        etf_price_chf = etf_look.price_chf_on(b["date"])
        units = cash_chf / etf_price_chf if etf_price_chf > 0 else 0
        etf_events.append({"date": b["date"], "units": units, "cashCHF": cash_chf})
        etf_flows_after_tax.append({"date": b["date"], "amount": -cash_chf})
    total_invested_chf = sum(e["cashCHF"] for e in etf_events)

    def units_held_at(date: str) -> float:
        return sum(e["units"] for e in etf_events if e["date"] <= date)

    total_etf_units = units_held_at(end_date)

    etf_divs = get_dividends(bench["symbol"], first_date)
    etf_net_dist_chf = 0.0
    etf_gross_dist_chf = 0.0
    for d in etf_divs:
        if d["date"] < first_date or d["date"] > end_date:
            continue
        units = units_held_at(d["date"])
        if units <= 0:
            continue
        fx = get_fx_rate(bench["currency"], "CHF", d["date"])
        gross_chf = units * d["close"] * fx
        etf_gross_dist_chf += gross_chf
        bd = dividend_tax(gross_chf, bench["domicile"], tax)
        etf_net_dist_chf += gross_chf if pre_tax else bd.netAfterTaxCHF
        etf_flows_after_tax.append({"date": d["date"],
                                    "amount": gross_chf if pre_tax else bd.netAfterTaxCHF})

    etf_price_value_end = total_etf_units * etf_look.price_chf_on(end_date)
    years = years_between(first_date, end_date)
    etf_mean_value = (total_invested_chf + etf_price_value_end) / 2
    etf_income_drag = (
        0 if (pre_tax or not bench["accumulating"])
        else fund_income_tax_drag(etf_mean_value, bench["incomeYield"], years, bench["domicile"], tax)
    )
    etf_wealth_tax = 0 if pre_tax else wealth_tax(etf_mean_value, years, tax)

    counterfactual_value_chf = etf_price_value_end + etf_net_dist_chf - etf_income_drag - etf_wealth_tax

    etf_terminal_flows = [
        *etf_flows_after_tax,
        {"date": end_date, "amount": etf_price_value_end - etf_income_drag - etf_wealth_tax},
    ]
    benchmark_xirr = xirr(etf_terminal_flows)

    # --- Actual holding value at endDate (after tax) ---
    actual = _actual_value_series(instrument, sorted_txs, stock_look, tax, pre_tax, end_date)
    actual_value_chf = actual["endValueCHF"]

    delta_chf = actual_value_chf - counterfactual_value_chf
    delta_pct = delta_chf / abs(counterfactual_value_chf) if counterfactual_value_chf != 0 else 0

    def bench_at(date: str) -> float:
        units = units_held_at(date)
        price = etf_look.price_chf_on(date)
        dist_so_far = _etf_dist_to_date(etf_divs, etf_events, bench, tax, pre_tax, first_date, date)
        return units * price + dist_so_far

    series = _build_series(first_date, end_date, actual["valueAt"], bench_at)

    recovery_months = None
    etf_cagr = cagr(total_invested_chf, counterfactual_value_chf, years)
    if etf_cagr is None:
        etf_cagr = bench["incomeYield"]
    if delta_chf > 0 and counterfactual_value_chf > 0 and etf_cagr and etf_cagr > 0:
        monthly_rate = (1 + etf_cagr) ** (1 / 12) - 1
        if monthly_rate > 0:
            recovery_months = math.log(actual_value_chf / counterfactual_value_chf) / math.log(1 + monthly_rate)

    return {
        "benchmarkSymbol": bench["symbol"],
        "benchmarkName": bench["name"],
        "actualValueCHF": actual_value_chf,
        "counterfactualValueCHF": counterfactual_value_chf,
        "deltaCHF": delta_chf,
        "deltaPct": delta_pct,
        "actualPreTaxCHF": actual["endValuePreTaxCHF"],
        "counterfactualPreTaxCHF": etf_price_value_end + etf_gross_dist_chf,
        "actualXirr": actual["xirr"],
        "benchmarkXirr": benchmark_xirr,
        "series": series,
        "recoveryMonths": recovery_months if (recovery_months is not None and math.isfinite(recovery_months)) else None,
    }


def _etf_dist_to_date(etf_divs, etf_events, bench, tax, pre_tax, from_date, to) -> float:
    total = 0.0
    for d in etf_divs:
        if d["date"] < from_date or d["date"] > to:
            continue
        units = sum(e["units"] for e in etf_events if e["date"] <= d["date"])
        if units <= 0:
            continue
        fx = get_fx_rate(bench["currency"], "CHF", d["date"])
        gross_chf = units * d["close"] * fx
        total += gross_chf if pre_tax else dividend_tax(gross_chf, bench["domicile"], tax).netAfterTaxCHF
    return total


def _actual_value_series(instrument, sorted_txs, stock_look, tax, pre_tax, end_date) -> dict:
    buys_sells = [t for t in sorted_txs if t["action"] != "dividend"]
    divs = [t for t in sorted_txs if t["action"] == "dividend"]
    flows: list[dict] = []

    def units_at(date: str) -> float:
        return sum(
            (t["quantity"] if t["action"] == "buy" else -t["quantity"])
            for t in buys_sells if t["date"] <= date
        )

    def proceeds_to_date(date: str) -> float:
        total = 0.0
        for t in buys_sells:
            if t["action"] != "sell" or t["date"] > date:
                continue
            orig = t["quantity"] * t["unitPrice"] - (t.get("fees") or 0)
            fx = get_fx_rate(t.get("currency") or instrument["currency"], "CHF", t["date"])
            total += orig * fx
        return total

    def div_to_date(date: str) -> float:
        total = 0.0
        for d in divs:
            if d["date"] > date:
                continue
            gross = d["grossAmount"] if d.get("grossAmount") is not None else d["quantity"] * d["unitPrice"]
            fx = get_fx_rate(d.get("currency") or instrument["currency"], "CHF", d["date"])
            gross_chf = gross * fx
            total += gross_chf if pre_tax else dividend_tax(gross_chf, instrument.get("domicile"), tax).netAfterTaxCHF
        return total

    for t in buys_sells:
        orig = t["quantity"] * t["unitPrice"] + ((t.get("fees") or 0) if t["action"] == "buy" else -(t.get("fees") or 0))
        fx = get_fx_rate(t.get("currency") or instrument["currency"], "CHF", t["date"])
        flows.append({"date": t["date"], "amount": (-1 if t["action"] == "buy" else 1) * orig * fx})
    for d in divs:
        gross = d["grossAmount"] if d.get("grossAmount") is not None else d["quantity"] * d["unitPrice"]
        fx = get_fx_rate(d.get("currency") or instrument["currency"], "CHF", d["date"])
        gross_chf = gross * fx
        flows.append({"date": d["date"],
                      "amount": gross_chf if pre_tax else dividend_tax(gross_chf, instrument.get("domicile"), tax).netAfterTaxCHF})

    def value_at(date: str) -> float:
        units = units_at(date)
        price_chf = stock_look.price_chf_on(date) if units > 0 else 0
        return units * price_chf + div_to_date(date) + proceeds_to_date(date)

    end_units = units_at(end_date)
    end_price_chf = stock_look.price_chf_on(end_date) if end_units > 0 else 0
    end_value_chf = value_at(end_date)
    end_value_pre_tax_chf = end_units * end_price_chf + div_to_date(end_date) + proceeds_to_date(end_date)

    terminal = [*flows, {"date": end_date, "amount": end_units * end_price_chf}] if end_units > 0 else flows

    return {
        "endValueCHF": end_value_chf,
        "endValuePreTaxCHF": end_value_pre_tax_chf,
        "xirr": xirr(terminal),
        "valueAt": value_at,
    }


def _build_series(from_date, to, actual_at, bench_at) -> list[dict]:
    points: list[dict] = []
    cursor = pd.Timestamp(from_date).to_period("M").to_timestamp()  # startOf month
    end = pd.Timestamp(to)
    step = 3 if (end.to_period("M") - pd.Timestamp(from_date).to_period("M")).n > 120 else 1
    while cursor < end or cursor.to_period("M") == end.to_period("M"):
        d = cursor.strftime("%Y-%m-%d")
        points.append({"date": d, "actualCHF": _round2(actual_at(d)), "benchmarkCHF": _round2(bench_at(d))})
        cursor = cursor + pd.DateOffset(months=step)
    last = pd.Timestamp(to).strftime("%Y-%m-%d")
    points.append({"date": last, "actualCHF": _round2(actual_at(last)), "benchmarkCHF": _round2(bench_at(last))})
    return points

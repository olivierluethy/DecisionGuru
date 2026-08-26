"""Universal asset comparison — one consistent metric set for any entity: a held
instrument, an arbitrary (non-portfolio) symbol, or the whole portfolio. Computes the
same risk/return metrics for all of them over a common lookback window and ranks the
strongest alternatives first, so stock↔stock, stock↔ETF, ETF↔ETF and asset↔portfolio all
speak the same language.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

import pandas as pd

from . import repo
from .finance import build_position
from .finance_math import xirr
from .history import portfolio_series
from .marketdata import get_dividends, get_history, get_quote


def _window_start(years: float) -> str:
    return (date.today() - timedelta(days=int(years * 365.25))).strftime("%Y-%m-%d")


def _series_metrics(rows: list[dict], value_key: str) -> dict:
    """Risk/return metrics from a `[{date, <value_key>}]` series (CHF or listing ccy)."""
    if not rows or len(rows) < 2:
        return {"cagr": None, "totalReturnPct": None, "annualizedVol": None,
                "maxDrawdownPct": None, "last1yPct": None, "sharpe": None,
                "from": None, "to": None, "points": len(rows)}
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").drop_duplicates("date")
    vals = df[value_key].to_numpy(dtype=float)
    dates = df["date"]
    start, end = vals[0], vals[-1]
    years = max((dates.iloc[-1] - dates.iloc[0]).days / 365.25, 1e-9)
    total = (end - start) / start if start > 0 else None
    cagr = ((end / start) ** (1 / years) - 1) if (start > 0 and end > 0) else None

    # monthly returns → annualised volatility & a simple Sharpe (rf=0)
    monthly = df.set_index("date")[value_key].resample("ME").last().dropna()
    rets = monthly.pct_change().dropna()
    vol = float(rets.std() * math.sqrt(12)) if len(rets) > 1 else None
    sharpe = (cagr / vol) if (cagr is not None and vol and vol > 0) else None

    # max drawdown
    peak = -math.inf
    max_dd = 0.0
    for v in vals:
        peak = max(peak, v)
        if peak > 0:
            max_dd = min(max_dd, (v - peak) / peak)

    # trailing 1y
    one_y_ago = dates.iloc[-1] - pd.Timedelta(days=365)
    prior = df[df["date"] <= one_y_ago]
    last1y = None
    if not prior.empty:
        base = prior[value_key].iloc[-1]
        last1y = (end - base) / base if base > 0 else None

    return {
        "cagr": cagr, "totalReturnPct": total, "annualizedVol": vol,
        "maxDrawdownPct": max_dd, "last1yPct": last1y, "sharpe": sharpe,
        "from": dates.iloc[0].strftime("%Y-%m-%d"), "to": dates.iloc[-1].strftime("%Y-%m-%d"),
        "points": int(len(df)),
    }


def _trailing_yield(symbol: str, last_close: float, window_start: str) -> float | None:
    if not last_close or last_close <= 0:
        return None
    divs = get_dividends(symbol, window_start)
    if not divs:
        return None
    one_y = (date.today() - timedelta(days=365)).strftime("%Y-%m-%d")
    ttm = sum(d["close"] for d in divs if d["date"] >= one_y)
    return (ttm / last_close) if ttm > 0 else None


def metrics_for_symbol(symbol: str, name: str | None, kind: str | None,
                       window_years: float) -> dict:
    start = _window_start(window_years)
    hist = get_history(symbol, start, date.today().strftime("%Y-%m-%d"))
    m = _series_metrics(hist, "close")
    try:
        quote = get_quote(symbol)
        price, ccy, qname = quote.get("price"), quote.get("currency"), quote.get("name")
    except Exception:  # noqa: BLE001
        price = ccy = qname = None
    last_close = hist[-1]["close"] if hist else price
    return {
        "type": "symbol", "symbol": symbol, "name": name or qname or symbol,
        "kind": kind, "currency": ccy, "currentPrice": price,
        "trailingYield": _trailing_yield(symbol, last_close or 0, start),
        **m,
        "investedCHF": None, "currentValueCHF": None, "xirr": None,
    }


def metrics_for_instrument(inst: dict, settings: dict, window_years: float) -> dict:
    m = metrics_for_symbol(inst["symbol"], inst["name"], inst.get("kind"), window_years)
    pos = build_position(inst, repo.get_transactions(inst["id"]), settings["tax"])["position"]
    m.update({
        "type": "instrument", "instrumentId": inst["id"],
        "investedCHF": pos.get("investedCHF"),
        "currentValueCHF": pos.get("currentValueCHF"),
        "xirr": pos["metrics"]["xirr"],
        "trailingYield": pos["metrics"]["currentYield"] or m.get("trailingYield"),
    })
    return m


def _portfolio_money_weighted(settings: dict) -> tuple[float | None, float, float]:
    """Money-weighted return (XIRR) across the whole book, from every position's after-tax
    flows + a terminal flow at today's total market value. Also returns invested & value."""
    flows: list[dict] = []
    invested = 0.0
    total_value = 0.0
    today = pd.Timestamp.utcnow().strftime("%Y-%m-%d")
    for inst in repo.list_instruments():
        txs = repo.get_transactions(inst["id"])
        if not txs:
            continue
        built = build_position(inst, txs, settings["tax"])
        flows.extend(built.get("flowsAfterTax") or [])
        invested += built["position"].get("investedCHF") or 0.0
        total_value += built["position"].get("currentValueCHF") or 0.0
    terminal = [*flows, {"date": today, "amount": total_value}] if total_value > 0 else flows
    return xirr(terminal), invested, total_value


def metrics_for_portfolio(settings: dict, window_years: float) -> dict:
    key = "MAX" if window_years >= 10 else "5Y"
    series = portfolio_series(key)
    rows = [{"date": p["date"], "value": p["value"]} for p in series.get("points", [])]
    m = _series_metrics(rows, "value")
    port_xirr, invested, end_val = _portfolio_money_weighted(settings)
    # The raw value series is inflated by contributions (new deposits/buys), so its CAGR /
    # total-return are not a true return — report money-weighted XIRR as the headline and
    # keep only the risk metrics (vol, drawdown) from the value path.
    m["cagr"] = port_xirr
    m["totalReturnPct"] = ((end_val - invested) / invested) if invested > 0 else None
    m["sharpe"] = (port_xirr / m["annualizedVol"]) if (port_xirr is not None and m.get("annualizedVol")) else None
    return {
        "type": "portfolio", "symbol": "PORTFOLIO", "name": "Your portfolio",
        "kind": "portfolio", "currency": "CHF", "currentPrice": None,
        "trailingYield": None, **m,
        "investedCHF": invested, "currentValueCHF": end_val, "xirr": port_xirr,
        "returnBasis": "money-weighted",
    }


def universal_compare(entities: list[dict], settings: dict, window_years: float = 5) -> dict:
    """entities: [{type:'instrument', id} | {type:'symbol', symbol, name?, kind?} |
    {type:'portfolio'}]. Returns one metric set per entity, ranked by risk-adjusted
    return (Sharpe, then CAGR)."""
    out: list[dict] = []
    for e in entities:
        etype = e.get("type")
        try:
            if etype == "portfolio":
                out.append(metrics_for_portfolio(settings, window_years))
            elif etype == "instrument":
                inst = repo.get_instrument(e["id"])
                if inst:
                    out.append(metrics_for_instrument(inst, settings, window_years))
            elif etype == "symbol" and e.get("symbol"):
                out.append(metrics_for_symbol(e["symbol"], e.get("name"), e.get("kind"), window_years))
        except Exception:  # noqa: BLE001 — one bad entity never sinks the comparison
            continue

    def _rank(m):
        sharpe = m.get("sharpe")
        cagr = m.get("cagr")
        return (-(sharpe if sharpe is not None else -1e9),
                -(cagr if cagr is not None else -1e9))
    out.sort(key=_rank)
    for i, m in enumerate(out):
        m["rank"] = i + 1
    return {"windowYears": window_years, "entities": out}

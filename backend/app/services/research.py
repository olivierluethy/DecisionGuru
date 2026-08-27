"""Investment research for any asset — portfolio-independent.

Assembles a full research snapshot for an arbitrary symbol (risk/return metrics, live
quote, geo/sector allocation, movement markers, dividends, news) and validates an
investment claim against historical data (supported vs unsupported, with the actual
figure). Claims can be structured or plain English ("returns more than 10% a year").
"""
from __future__ import annotations

import re

from .allocation import build_allocation
from .marketdata import get_fund_summary, search_symbol
from .movements import movements_for_symbol
from .news import get_news
from .universal import metrics_for_symbol

_METRIC_LABELS = {
    "cagr": "annualised return (CAGR)",
    "totalReturnPct": "total return",
    "maxDrawdownPct": "maximum drawdown",
    "annualizedVol": "annualised volatility",
    "trailingYield": "dividend yield",
    "last1yPct": "trailing 1-year return",
}


def _synthetic_instrument(symbol: str, name: str | None, kind: str | None) -> dict:
    return {"id": -1, "symbol": symbol, "name": name or symbol, "kind": kind or "stock",
            "isin": None, "currency": "USD", "domicile": None, "country": None,
            "sector": None, "allocationOverride": None}


def _resolve_kind(symbol: str) -> tuple[str, str | None]:
    """Best-effort (kind, name) for a symbol from fund summary / search."""
    summary = get_fund_summary(symbol)
    if summary:
        qt = (summary.get("quoteType") or "").upper()
        if qt == "ETF":
            return "etf", summary.get("longName") or summary.get("shortName")
        return "stock", summary.get("longName") or summary.get("shortName")
    hits = search_symbol(symbol)
    for h in hits:
        if h.get("symbol", "").upper() == symbol.upper():
            return ("etf" if (h.get("kind") == "etf" or h.get("type") == "ETF") else "stock"), h.get("name")
    return "stock", None


def research_asset(symbol: str, settings: dict, window_years: float = 5,
                   with_news: bool = True) -> dict:
    kind, name = _resolve_kind(symbol)
    metrics = metrics_for_symbol(symbol, name, kind, window_years)
    inst = _synthetic_instrument(symbol, metrics.get("name"), kind)
    allocation = build_allocation(inst)
    movements = movements_for_symbol(symbol)
    news = get_news(symbol, limit=8) if with_news else {"items": []}
    return {
        "symbol": symbol, "name": metrics.get("name"), "kind": kind,
        "currency": metrics.get("currency"), "currentPrice": metrics.get("currentPrice"),
        "priceAsOf": metrics.get("priceAsOf"), "priceFreshness": metrics.get("priceFreshness"),
        "metrics": metrics,
        "allocation": allocation,
        "movements": movements,
        "news": news.get("items", []),
    }


# ---- Claim validation ------------------------------------------------------

def parse_claim(text: str) -> dict | None:
    """Very light natural-language claim parser → structured claim."""
    t = (text or "").lower()
    pct = re.search(r"(-?\d+(?:\.\d+)?)\s*%", t)
    if not pct:
        return None
    value = float(pct.group(1)) / 100.0

    if re.search(r"yield|dividend", t):
        metric = "trailingYield"
    elif re.search(r"draw\s*down|crash|fall|drop|decline", t):
        metric = "maxDrawdownPct"
    elif re.search(r"volatil", t):
        metric = "annualizedVol"
    elif re.search(r"per\s*year|per\s*annum|annual|a\s*year|cagr|compound", t):
        metric = "cagr"
    elif re.search(r"last\s*year|past\s*year|1\s*year|trailing", t):
        metric = "last1yPct"
    else:
        metric = "cagr"

    # "never/avoid ... more than X" is a negated upper bound (stays within X).
    negated = bool(re.search(r"never|avoid|doesn'?t|does not|won'?t|stay|within", t))
    if re.search(r"less than|under|below|no more than|at most|<", t) or negated:
        op = "<="
    elif re.search(r"more than|over|above|at least|greater|beat|exceed|>", t):
        op = ">="
    else:
        op = ">="

    yrs = re.search(r"(\d+)\s*year", t)
    return {"metric": metric, "op": op, "value": value,
            "years": int(yrs.group(1)) if yrs else None}


def validate_claim(symbol: str, claim, settings: dict) -> dict:
    """Evaluate a structured or free-text claim against historical data."""
    if isinstance(claim, str):
        structured = parse_claim(claim)
        claim_text = claim
    else:
        structured = claim
        claim_text = claim.get("text") if isinstance(claim, dict) else None
    if not structured:
        return {"symbol": symbol, "parsed": None, "supported": None,
                "explanation": "Could not parse a testable claim — include a percentage "
                               "and a metric (e.g. 'returns more than 8% a year')."}

    metric = structured["metric"]
    op = structured.get("op", ">=")
    threshold = structured["value"]
    years = structured.get("years") or 5

    m = metrics_for_symbol(symbol, None, None, years)
    actual = m.get(metric)
    if actual is None:
        return {"symbol": symbol, "parsed": structured, "actual": None, "supported": None,
                "explanation": f"No historical data to test {_METRIC_LABELS.get(metric, metric)} for {symbol}."}

    # Drawdown/volatility comparisons use magnitude ("drops more than 30%").
    actual = float(actual)
    a = abs(actual) if metric in ("maxDrawdownPct", "annualizedVol") else actual
    thr = abs(threshold) if metric in ("maxDrawdownPct", "annualizedVol") else threshold
    supported = bool(a >= thr) if op == ">=" else bool(a <= thr)

    def _p(v):
        return f"{v * 100:.1f}%"

    label = _METRIC_LABELS.get(metric, metric)
    rel = "at least" if op == ">=" else "at most"
    explanation = (
        f"Claim: {label} of {symbol} is {rel} {_p(threshold)} over ~{years}y. "
        f"Actual {label} was {_p(actual)} ({m.get('from')}→{m.get('to')}). "
        f"The data {'supports' if supported else 'does not support'} the claim."
    )
    return {
        "symbol": symbol, "claimText": claim_text, "parsed": structured,
        "metric": metric, "op": op, "threshold": threshold,
        "actual": actual, "windowYears": years,
        "supported": supported, "explanation": explanation,
        "from": m.get("from"), "to": m.get("to"),
    }

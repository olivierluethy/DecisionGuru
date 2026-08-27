"""Company fundamentals + index-weight lookup, cached in front of the provider.

`get_fundamentals` fetches a valuation/profitability snapshot and a multi-year income
statement (the heavy get_info scrape), cached in `fundamentals_cache`. `index_weight`
derives a Swiss stock's SMI weight from a published SMI-ETF holdings list (reusing the
fund-summary cache). Both degrade gracefully — never raise, serve stale on failure.
"""
from __future__ import annotations

import json
import time

from ..core import db
from ..core.config import settings
from ..core.logging import get_logger
from . import marketdata
from ..providers.yfinance_provider import provider

log = get_logger("fundamentals")

# ETFs whose top holdings approximate the Swiss Market Index; first that yields data wins.
_SMI_ETFS = ["CSSMI.SW", "SMICHA.SW", "XSMI.SW"]


def _now_ms() -> int:
    return int(time.time() * 1000)


def get_cached_fundamentals(symbol: str) -> dict | None:
    """Cache-only read — never triggers the live scrape. The screener uses this so a
    large candidate universe can't fan out into hundreds of (rate-limited) provider
    calls; stale rows are fine for a value screen and returned as-is."""
    cached = db.q("SELECT payload FROM fundamentals_cache WHERE symbol = ?").get((symbol,))
    return json.loads(cached["payload"]) if cached else None


def get_fundamentals(symbol: str) -> dict | None:
    cached = db.q("SELECT payload, fetchedAt FROM fundamentals_cache WHERE symbol = ?").get((symbol,))
    if cached and (_now_ms() - cached["fetchedAt"] < settings.cache_ttl_fundamentals * 1000):
        return json.loads(cached["payload"])
    try:
        data = provider.fundamentals(symbol)
        if data is not None:
            db.execute(
                "INSERT OR REPLACE INTO fundamentals_cache (symbol, payload, fetchedAt) VALUES (?, ?, ?)",
                (symbol, json.dumps(data), _now_ms()),
            )
        return data
    except Exception as exc:  # noqa: BLE001
        log.warning("fundamentals failed for %s: %s", symbol, exc)
        if cached:
            return json.loads(cached["payload"])
        return None


def _base(sym: str | None) -> str:
    return (sym or "").split(".")[0].upper().strip()


def index_weight(symbol: str, name: str | None, domicile: str | None) -> dict | None:
    """SMI weight for a Swiss blue chip, read from an SMI-ETF's top holdings.

    Returns ``{index, etf, weightPct, holdingName}`` or None when not a Swiss stock,
    the ETF data is unavailable, or the name isn't among the ETF's (top ~10) holdings."""
    is_swiss = (domicile or "").upper() == "CH" or symbol.upper().endswith(".SW")
    if not is_swiss:
        return None
    want_sym = _base(symbol)
    want_name = (name or "").upper()
    want_token = want_name.split(" ")[0] if want_name else ""
    for etf in _SMI_ETFS:
        try:
            summary = marketdata.get_fund_summary(etf)
        except Exception:  # noqa: BLE001
            summary = None
        holdings = ((summary or {}).get("topHoldings") or {}).get("holdings") or []
        if not holdings:
            continue
        for h in holdings:
            h_sym = _base(h.get("symbol"))
            h_name = (h.get("holdingName") or "").upper()
            matched = (
                (want_sym and h_sym and (h_sym == want_sym or h_sym.startswith(want_sym) or want_sym.startswith(h_sym)))
                or (want_token and len(want_token) >= 4 and want_token in h_name)
            )
            if matched:
                return {
                    "index": "SMI",
                    "etf": etf,
                    "weightPct": h.get("holdingPercent"),
                    "holdingName": h.get("holdingName"),
                }
        # ETF had holdings but no match → the stock isn't a top SMI constituent here.
        return {"index": "SMI", "etf": etf, "weightPct": None, "holdingName": None}
    return None


def fundamentals_bundle(symbol: str, name: str | None = None, domicile: str | None = None) -> dict:
    """Everything the position/research fundamentals panel needs."""
    data = get_fundamentals(symbol) or {"snapshot": None, "history": [], "financialCurrency": None}
    return {
        "symbol": symbol,
        "snapshot": data.get("snapshot"),
        "history": data.get("history") or [],
        "financialCurrency": data.get("financialCurrency"),
        "indexWeight": index_weight(symbol, name or (data.get("snapshot") or {}).get("name"), domicile),
    }

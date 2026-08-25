"""Per-instrument market-data health badge — port of datastatus.ts."""
from __future__ import annotations

import pandas as pd

from ..core import db
from ..core.timefmt import iso_from_ms


def instrument_data_status(inst: dict, open_quantity: float | None = None) -> dict:
    if inst.get("unresolved") or (inst.get("isin") and inst.get("symbol") == inst.get("isin")):
        return {
            "state": "unresolved",
            "resolutionSource": inst.get("resolutionSource") or "unresolved",
            "message": "No ticker resolved — value & charts unavailable. "
                       "Edit the symbol or retry resolve.",
        }
    # A fully-closed position has a definitive value of 0 — not "missing data".
    if open_quantity is not None and open_quantity <= 0:
        return {"state": "ok", "resolutionSource": inst.get("resolutionSource"),
                "message": "Position closed."}

    symbol = inst["symbol"]
    quote = db.q("SELECT price, fetchedAt FROM quote_cache WHERE symbol = ?").get((symbol,))
    cov = db.q("SELECT COUNT(*) AS c, MAX(date) AS mx FROM price_cache WHERE symbol = ?").get((symbol,))
    has_quote = bool(quote) and quote["price"] > 0
    coverage_days = (cov["c"] if cov else 0) or 0

    if not has_quote and not coverage_days:
        return {
            "state": "no-data",
            "resolutionSource": inst.get("resolutionSource"),
            "priceCoverageDays": 0,
            "message": "No market data yet (provider may be rate-limiting) — try again shortly.",
        }

    quote_as_of = iso_from_ms(quote["fetchedAt"]) if quote else None
    now = pd.Timestamp.utcnow().tz_localize(None)
    quote_age_h = (
        (now - pd.Timestamp(quote["fetchedAt"], unit="ms")).total_seconds() / 3600
        if quote else None
    )
    cov_age_d = (
        (now.normalize() - pd.Timestamp(cov["mx"]).normalize()).days
        if cov and cov["mx"] else None
    )
    stale = (
        (quote is None or (quote_age_h is not None and quote_age_h >= 24))
        and (cov is None or not cov["mx"] or (cov_age_d is not None and cov_age_d > 4))
    )

    return {
        "state": "stale" if stale else "ok",
        "resolutionSource": inst.get("resolutionSource"),
        "quoteAsOf": quote_as_of,
        "priceCoverageDays": coverage_days,
        "message": "Prices may be a few days old (cached)." if stale else None,
    }

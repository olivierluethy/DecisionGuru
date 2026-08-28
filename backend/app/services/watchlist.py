"""Watchlist — symbols the owner wants to monitor without holding them.

Deliberately thin: this owns only the list. Performance metrics and the
"vs ETF over time" comparison reuse the existing universal-compare service from
the client, so there is one code path for ranking any set of assets.
"""
from __future__ import annotations

from ..core.db import execute, q


def list_watchlist() -> list[dict]:
    rows = q("SELECT * FROM watchlist ORDER BY addedAt DESC").all()
    return [dict(r) for r in rows]


def add_to_watchlist(symbol: str, name: str | None = None, kind: str = "stock") -> dict:
    symbol = (symbol or "").strip()
    if not symbol:
        return {}
    # Idempotent: adding an already-watched symbol is a no-op that returns the row.
    execute(
        "INSERT OR IGNORE INTO watchlist (symbol, name, kind) VALUES (?, ?, ?)",
        (symbol, name, kind or "stock"),
    )
    row = q("SELECT * FROM watchlist WHERE symbol = ?").get((symbol,))
    return dict(row) if row else {}


def remove_from_watchlist(item_id: int) -> bool:
    cur = execute("DELETE FROM watchlist WHERE id = ?", (item_id,))
    return cur.rowcount > 0


def watchlist_analysis(settings: dict) -> list[dict]:
    """Each watched name enriched with its computed attractive entry price, the current
    price, the gap to that target, the fair-value band and the valuation reasoning — so
    the Watchlist reads as a set of buy targets, not just a list. Off cached data only."""
    # Imported lazily to keep this module import-cheap for the screener.
    from .valuation import value_analysis
    from .verdict import resolve_verdict
    from .fundamentals import get_cached_fundamentals
    from .marketdata import get_quote

    out: list[dict] = []
    for item in list_watchlist():
        sym = item.get("symbol")
        cached = get_cached_fundamentals(sym) if sym else None
        quote = get_quote(sym) if sym else {}
        price = (quote or {}).get("price")
        entry = fair = band = gap = None
        va = None
        rec = None
        if cached and (cached.get("snapshot")):
            va = value_analysis(sym, price, (quote or {}).get("currency"),
                                data=cached, settings=settings)
            entry = va.get("entryTarget")
            fair = va.get("fairValue")
            band = va.get("band")
            if entry and price and entry > 0:
                # +ve gap = price is above the entry target (has to fall this far to buy).
                gap = round(price / entry - 1, 4)
            # Same shared verdict as everywhere else (valuation-only — a watched name isn't held).
            rec = resolve_verdict(va, held=False)
        out.append({
            **item,
            "price": price,
            "currency": (quote or {}).get("currency"),
            "stale": (quote or {}).get("stale"),
            "fairValue": fair,
            "entryTarget": entry,
            "gapToEntry": gap,
            "band": band,
            "marginOfSafety": (va or {}).get("marginOfSafety"),
            "quality": (va or {}).get("quality"),
            "confidence": (va or {}).get("confidence"),
            "verdict": rec["verdict"] if rec else None,
            "recommendation": rec,
            "analysed": va is not None,
        })
    # Closest to (or already at) the entry target first.
    out.sort(key=lambda r: (r["gapToEntry"] is None, r["gapToEntry"] if r["gapToEntry"] is not None else 1e9))
    return out

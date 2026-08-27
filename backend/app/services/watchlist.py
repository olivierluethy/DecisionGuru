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

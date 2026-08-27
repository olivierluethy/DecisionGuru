"""Competitive positioning — same-sector peers for a company.

There is no peer/relationship data source, and the provider rate-limits bulk pulls,
so peers are derived offline: names from the screening universe (∪ holdings ∪
watchlist) that share the subject's sector and already have cached fundamentals.
Ranked by market cap so you can see where the company sits by size and valuation
among its sector. Currencies aren't FX-normalised — noted in the UI.
"""
from __future__ import annotations

from . import repo
from .watchlist import list_watchlist
from .fundamentals import get_cached_fundamentals
from ..reference.universe import UNIVERSE_SEED


def _peer(sym: str, snap: dict, is_subject: bool) -> dict:
    return {
        "symbol": sym,
        "name": snap.get("name"),
        "sector": snap.get("sector"),
        "industry": snap.get("industry"),
        "marketCap": snap.get("marketCap"),
        "currency": snap.get("currency") or snap.get("financialCurrency"),
        "trailingPE": snap.get("trailingPE"),
        "priceToBook": snap.get("priceToBook"),
        "profitMargins": snap.get("profitMargins"),
        "revenueGrowth": snap.get("revenueGrowth"),
        "isSubject": is_subject,
    }


def competitors(symbol: str) -> dict:
    subject = get_cached_fundamentals(symbol)
    subj_snap = (subject or {}).get("snapshot")
    sector = (subj_snap or {}).get("sector")
    if not subj_snap or not sector:
        return {"symbol": symbol, "sector": sector, "peers": [], "peerCount": 0, "subjectRank": None}

    holdings = [i["symbol"] for i in repo.list_instruments() if i.get("symbol")]
    watch = [w["symbol"] for w in list_watchlist() if w.get("symbol")]
    pool = list(dict.fromkeys([symbol, *UNIVERSE_SEED, *holdings, *watch]))

    peers: list[dict] = []
    for sym in pool:
        data = get_cached_fundamentals(sym)
        snap = (data or {}).get("snapshot")
        if not snap or (snap.get("sector") or "") != sector:
            continue
        peers.append(_peer(sym, snap, sym == symbol))

    # Largest first; unknown market caps sink to the bottom.
    peers.sort(key=lambda p: (p["marketCap"] is not None, p["marketCap"] or 0), reverse=True)
    subject_rank = next((idx + 1 for idx, p in enumerate(peers) if p["isSubject"]), None)

    return {
        "symbol": symbol,
        "sector": sector,
        "industry": subj_snap.get("industry"),
        "peers": peers,
        "peerCount": max(0, len(peers) - 1),  # excluding the subject itself
        "subjectRank": subject_rank,
    }

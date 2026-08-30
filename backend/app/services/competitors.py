"""Competitive positioning — genuinely comparable companies for a subject.

There is no peer/relationship data source, and the provider rate-limits bulk pulls, so peers
are derived offline from the screening universe (∪ holdings ∪ watchlist), restricted to names
that already have cached fundamentals. Comparability is NOT "same broad sector" — that bundles
unrelated businesses (autos with restaurants, apparel and luxury goods). Instead a candidate is
a peer only when it shares the subject's *competitive market*: the same normalized industry
within the same normalized sector (see ``reference/classification.same_market``). The sector is
just a coarse pre-filter; the industry is the market boundary.

Peers are ranked by CHF-normalised market cap (largest first) so ranking is currency-consistent
with what the UI displays; names without a resolvable CHF cap sink to the bottom. FX is the
cached ECB service (frankfurter), memoised per currency here — the peer loop never touches the
rate-limited price/fundamentals provider.
"""
from __future__ import annotations

from datetime import datetime, timezone

from . import repo
from .watchlist import list_watchlist
from .fundamentals import get_cached_fundamentals, get_fundamentals
from .peer_discovery import discover_peers
from .fx import get_fx_rate
from ..reference.universe import UNIVERSE_SEED
from ..reference.classification import same_market


def _peer(sym: str, snap: dict, is_subject: bool, market_cap_chf: float | None) -> dict:
    return {
        "symbol": sym,
        "name": snap.get("name"),
        "sector": snap.get("sector"),
        "industry": snap.get("industry"),
        "marketCap": snap.get("marketCap"),
        "marketCapCHF": market_cap_chf,
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
    # industryKey treibt die autonome Discovery. Ältere Cache-Einträge kennen das Feld noch
    # nicht → Subjekt einmal on-demand nachladen, damit Discovery greifen kann.
    if subj_snap is not None and not subj_snap.get("industryKey"):
        subject = get_fundamentals(symbol) or subject
        subj_snap = (subject or {}).get("snapshot")
    sector = (subj_snap or {}).get("sector")
    industry = (subj_snap or {}).get("industry")
    if not subj_snap or not sector:
        return {"symbol": symbol, "sector": sector, "industry": industry,
                "peers": [], "peerCount": 0, "subjectRank": None}

    # Autonome Peers aus der Industry des Subjekts; Fallback-Quellen dahinter.
    discovered = discover_peers((subj_snap or {}).get("industryKey"))
    discovered_set = set(discovered)

    holdings = [i["symbol"] for i in repo.list_instruments() if i.get("symbol")]
    watch = [w["symbol"] for w in list_watchlist() if w.get("symbol")]
    # Discovery zuerst, dann Holdings/Watchlist, dann die kuratierte Liste als Fallback.
    pool = list(dict.fromkeys([symbol, *discovered, *holdings, *watch, *UNIVERSE_SEED]))

    # FX to CHF for the market-cap ranking — cached ECB rates, memoised per currency so the
    # loop resolves at most one rate per distinct currency (no per-peer live provider call).
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    fx_by_ccy: dict[str, float | None] = {}

    def _to_chf(amount, ccy) -> float | None:
        if amount is None:
            return None
        cur = (ccy or "").upper() or None
        if cur is None:
            return None
        if cur not in fx_by_ccy:
            fx_by_ccy[cur] = get_fx_rate(cur, "CHF", today, strict=True)
        rate = fx_by_ccy[cur]
        return round(amount * rate, 2) if rate is not None else None

    peers: list[dict] = []
    for sym in pool:
        # Discovery-Peers on-demand live holen (+ cachen); alle übrigen bleiben cache-only,
        # damit die kuratierte Universe nicht in hunderte rate-limitierte Calls ausfächert.
        data = get_fundamentals(sym) if sym in discovered_set else get_cached_fundamentals(sym)
        snap = (data or {}).get("snapshot")
        if not snap:
            continue
        # Same competitive market (sector coarse-filter + industry boundary), not just sector.
        if not same_market(sector, industry, snap.get("sector"), snap.get("industry")):
            continue
        cap_chf = _to_chf(snap.get("marketCap"), snap.get("currency") or snap.get("financialCurrency"))
        peers.append(_peer(sym, snap, sym == symbol, cap_chf))

    # Largest first by CHF-normalised cap; unknown CHF caps sink to the bottom.
    peers.sort(key=lambda p: (p["marketCapCHF"] is not None, p["marketCapCHF"] or 0), reverse=True)
    subject_rank = next((idx + 1 for idx, p in enumerate(peers) if p["isSubject"]), None)

    return {
        "symbol": symbol,
        "sector": sector,
        "industry": industry,
        "peers": peers,
        "peerCount": max(0, len(peers) - 1),  # excluding the subject itself
        "subjectRank": subject_rank,
    }

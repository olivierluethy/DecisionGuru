"""Symbol resolution — port of resolution.ts.

Tiers: explicit ticker -> symbol_map cache -> curated seed -> Yahoo search -> unresolved.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass

from ..core import db
from ..reference.geo import country_from_isin
from ..reference.isin_map import curated_resolve
from .marketdata import search_symbol


@dataclass
class ResolvedSymbol:
    symbol: str
    currency: str
    kind: str
    country: str | None
    source: str  # 'curated' | 'yahoo' | 'manual' | 'unresolved'
    unresolved: bool
    name: str | None = None
    exchange: str | None = None


_ISIN_SHAPE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")

SUFFIX_CCY = {
    "SW": "CHF", "VX": "CHF", "L": "GBP", "PA": "EUR", "DE": "EUR", "F": "EUR", "AS": "EUR",
    "MI": "EUR", "MC": "EUR", "BR": "EUR", "TO": "CAD", "V": "CAD", "HK": "HKD", "T": "JPY",
}


def _persist(isin: str | None, r: ResolvedSymbol) -> None:
    if not isin or r.unresolved:
        return
    db.execute(
        "INSERT OR REPLACE INTO symbol_map "
        "(isin, symbol, currency, kind, country, name, exchange, source, resolvedAt) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (isin, r.symbol, r.currency, r.kind, r.country, r.name, r.exchange, r.source,
         int(time.time() * 1000)),
    )


def _looks_like_ticker(symbol: str | None, isin: str | None = None) -> bool:
    if not symbol:
        return False
    s = symbol.strip().upper()
    if not s:
        return False
    if isin and s == isin.upper():
        return False
    if _ISIN_SHAPE.match(s):
        return False
    return True


def _suffix_of(symbol: str) -> str | None:
    parts = symbol.split(".")
    return parts[-1].upper() if len(parts) > 1 else None


def _pick_best(hits: list[dict], country: str | None) -> dict | None:
    if not hits:
        return None
    scored = []
    for h in hits:
        score = 0
        typ = (h.get("type") or "").upper()
        if typ in ("EQUITY", "ETF"):
            score += 5
        if typ == "MUTUALFUND":
            score += 2
        suf = _suffix_of(h["symbol"])
        if country and suf:
            suf_ccy = SUFFIX_CCY.get(suf)
            if (
                (country == "CH" and suf in ("SW", "VX"))
                or (country == "GB" and suf == "L")
                or (country == "FR" and suf == "PA")
                or (country == "DE" and suf in ("DE", "F"))
                or (country == "CA" and suf in ("TO", "V"))
                or suf_ccy
            ):
                score += 2
        if not suf and (country == "US" or not country):
            score += 1
        scored.append((score, h))
    scored.sort(key=lambda x: x[0], reverse=True)
    return scored[0][1]


def resolve_symbol(ident: dict, offline: bool = False) -> ResolvedSymbol:
    isin = (ident.get("isin") or "").upper() or None
    isin_country = country_from_isin(isin)

    # 0) explicit real ticker
    if _looks_like_ticker(ident.get("symbol"), isin):
        return ResolvedSymbol(
            symbol=ident["symbol"].strip(), currency="USD", kind="stock",
            country=isin_country, name=ident.get("name"), source="manual", unresolved=False,
        )

    # 1) permanent cache
    if isin:
        cached = db.q("SELECT * FROM symbol_map WHERE isin = ?").get((isin,))
        if cached:
            return ResolvedSymbol(
                symbol=cached["symbol"],
                currency=cached["currency"] or "USD",
                kind=cached["kind"] or "stock",
                country=cached["country"] or isin_country,
                name=cached["name"] or ident.get("name"),
                exchange=cached["exchange"],
                source=cached["source"] or "yahoo",
                unresolved=False,
            )

    # 2) curated seed
    curated = curated_resolve(isin)
    if curated:
        r = ResolvedSymbol(
            symbol=curated["symbol"], currency=curated["currency"], kind=curated["kind"],
            country=curated.get("country") or isin_country, name=ident.get("name"),
            source="curated", unresolved=False,
        )
        _persist(isin, r)
        return r

    # 3) Yahoo search (skipped when offline)
    if offline:
        slug = re.sub(r"\s+", "-", (isin or ident.get("name") or ident.get("symbol") or "UNKNOWN")).upper()[:24]
        return ResolvedSymbol(symbol=slug, currency="USD", kind="stock", country=isin_country,
                              name=ident.get("name"), source="unresolved", unresolved=True)

    query = isin or ident.get("name") or ident.get("symbol") or ""
    hits = search_symbol(query)
    if not hits and ident.get("name") and ident.get("name") != query:
        hits = search_symbol(ident["name"])
    best = _pick_best(hits, isin_country)
    if best:
        suf = _suffix_of(best["symbol"])
        r = ResolvedSymbol(
            symbol=best["symbol"],
            currency=best.get("currency") or (SUFFIX_CCY.get(suf) if suf else None) or "USD",
            kind=best.get("kind") or "stock",
            country=isin_country,
            name=best.get("name") or ident.get("name"),
            exchange=best.get("exchange"),
            source="yahoo",
            unresolved=False,
        )
        _persist(isin, r)
        return r

    # 4) unresolved slug
    slug = re.sub(r"\s+", "-", (isin or ident.get("name") or ident.get("symbol") or "UNKNOWN")).upper()[:24]
    return ResolvedSymbol(symbol=slug, currency="USD", kind="stock", country=isin_country,
                          name=ident.get("name"), source="unresolved", unresolved=True)

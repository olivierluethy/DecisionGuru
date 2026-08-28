"""Cross-listing resolver + CHF-first exchange recommendation.

Detects the known listings of the same company across exchanges/currencies via the
provider's search (the same path resolution already uses) and scores them against the
investor's configured base currency to name the one line to buy — minimising the number
of FX conversion steps and their cost. Deterministic; degrades gracefully and never
fabricates an exchange, ticker or currency.

The result is what the opportunity detail renders: one recommended listing (exchange,
exact exchange-specific ticker, trading currency, a plain "why this exchange" line) plus
every alternative listing clearly labelled so two lines of the same company can't be
confused.
"""
from __future__ import annotations

import re
import time

from ..core import db
from ..core.db import get_state, set_state
from ..reference.geo import country_from_symbol
from .fundamentals import get_cached_fundamentals
from .fx import latest_fx_to_chf
from .marketdata import listing_currency, search_symbol
from .markethours import EXCHANGES

# Trading currency by Yahoo symbol suffix ("" = a bare US ticker). Only a *fallback* for
# when the provider omits the currency on a hit — the provider's own value always wins,
# because a London line can trade in USD (many UCITS ETFs) rather than GBP.
SUFFIX_CCY: dict[str, str] = {
    "": "USD", "SW": "CHF", "VX": "CHF", "L": "GBP", "DE": "EUR", "F": "EUR", "PA": "EUR",
    "AS": "EUR", "MI": "EUR", "MC": "EUR", "BR": "EUR", "T": "JPY", "HK": "HKD",
    "TO": "CAD", "V": "CAD", "AX": "AUD", "ST": "SEK",
    # German regional boards + other euro-area lines trade in EUR (a provider search hit
    # often omits their currency — never let those fall through to a fabricated USD).
    "BE": "EUR", "BM": "EUR", "DU": "EUR", "HM": "EUR", "HA": "EUR", "MU": "EUR",
    "SG": "EUR", "VI": "EUR", "IR": "EUR", "LS": "EUR", "HE": "EUR", "AT": "EUR",
}

# Relative liquidity / "major line" weight per exchange suffix — US and London the
# deepest, national primaries mid, regional/venture boards the thinnest. This is the
# leading criterion once no base-currency line exists: a deep primary line's tight spread
# beats the tiny FX saving of a thin regional board in a nearer currency.
LIQUIDITY: dict[str, int] = {
    "": 10, "L": 9, "SW": 8, "DE": 7, "PA": 7, "AS": 7, "MI": 6, "MC": 6, "T": 6,
    "HK": 6, "TO": 5, "AX": 5, "ST": 4, "F": 3, "V": 2,
    "BE": 2, "BM": 2, "DU": 2, "HM": 2, "HA": 2, "MU": 2, "SG": 2, "VI": 3,
}

# FX proximity to CHF — a tiny nudge that only separates comparably-liquid lines (its whole
# range is smaller than one liquidity step). EUR is closest to CHF (ECB-referenced, tight
# spread), then the deep USD/GBP majors.
_PROXIMITY = {"CHF": 3, "EUR": 2, "USD": 1, "GBP": 1}

# Name tokens that differ between two lines of the *same* company (share class, ADR
# markers, legal-form suffixes) — ignored when deciding if two hits are the same issuer.
_NOISE_TOKENS = {
    "sa", "ag", "nv", "plc", "inc", "incorporated", "ltd", "limited", "co", "corp",
    "corporation", "the", "group", "holding", "holdings", "company", "spa", "se", "aps",
    "adr", "ads", "sponsored", "unsponsored", "reg", "registered", "br", "bearer",
    "cl", "class", "a", "b", "shs", "shares", "ord", "ordinary", "n",
    "american", "depositary", "depository", "receipt", "receipts", "each",
    "representing", "common", "stock", "nam", "akt",
}

_TTL_MS = 7 * 24 * 3600 * 1000  # a company's listings barely change — cache a week.


def _suffix(symbol: str) -> str:
    """The Yahoo exchange suffix, uppercased; "" for a bare (US) ticker. Returns the raw
    suffix even when unknown, so a foreign line ('.MX') is never mistaken for a US one."""
    parts = (symbol or "").split(".")
    return parts[-1].upper() if len(parts) > 1 else ""


def _root(symbol: str) -> str:
    return (symbol or "").split(".")[0].upper()


def _name_tokens(name: str | None) -> set[str]:
    if not name:
        return set()
    words = re.split(r"[^a-z0-9]+", name.lower())
    # Drop single letters too — they're legal-form / share-class noise ("S.A." → s, a;
    # "Class A" → a) and tokenise inconsistently against their run-together forms ("SA").
    return {w for w in words if len(w) > 1 and w not in _NOISE_TOKENS}


def _same_company(subject: set[str], other: set[str]) -> bool:
    """Two hits are the same issuer when their significant name tokens match (a subsidiary
    such as 'Nestle India' keeps an extra significant token and is correctly excluded)."""
    if not subject or not other:
        return False
    return subject == other


def _currency_for(symbol: str, provided: str | None) -> str | None:
    """Trading currency of a listing: the provider's own value wins; else a known-suffix
    mapping; else a cached quote. Returns None when it genuinely can't be determined —
    we never fabricate a currency (a thin, unlabelable line is dropped instead)."""
    if provided:
        return provided.upper()
    known = SUFFIX_CCY.get(_suffix(symbol))
    if known:
        return known
    lc = listing_currency(symbol)
    return lc.upper() if lc else None


def _exchange_meta(symbol: str, yahoo_exchange: str | None) -> tuple[str, str, str | None]:
    """(code, display name, ISO country) for a listing, from the ticker suffix; falls back
    to the provider's raw exchange code as the name when the suffix is unknown."""
    meta = EXCHANGES.get(_suffix(symbol))
    if meta:
        return meta["code"], meta["name"], meta.get("country")
    code = (yahoo_exchange or "").strip() or "—"
    return code, code, country_from_symbol(symbol)


def _score(currency: str, symbol: str, base: str) -> int:
    """Deterministic CHF-first listing score. Order of preference, highest first:
      1. trading currency == base (CHF) — no FX conversion at all;
      2. otherwise the most liquid major exchange (tight spread beats a small FX saving);
      3. FX proximity to the base only nudges between comparably-liquid lines.
    Higher is better."""
    match = 1000 if currency == base else 0
    return match + LIQUIDITY.get(_suffix(symbol), 1) * 10 + _PROXIMITY.get(currency, 0)


def _identity(symbol: str) -> tuple[str | None, str | None]:
    """Best (company name, ISIN) we can attach to a symbol without a network call, for a
    tighter cross-listing query."""
    cached = get_cached_fundamentals(symbol) or {}
    snap = cached.get("snapshot") or {}
    name = snap.get("name")
    inst = db.q("SELECT name, isin FROM instruments WHERE symbol = ?").get((symbol,))
    if inst:
        name = name or inst["name"]
    row = db.q("SELECT isin FROM symbol_map WHERE symbol = ?").get((symbol,))
    isin = (inst["isin"] if inst else None) or (row["isin"] if row else None)
    return name, isin


def detect_listings(symbol: str, name: str | None = None, isin: str | None = None) -> list[dict]:
    """All known listings of the company behind `symbol`, across exchanges/currencies.
    Always includes the subject symbol itself; deduped by symbol; equities/ETFs only."""
    cached_name, cached_isin = _identity(symbol)
    name = name or cached_name
    isin = isin or cached_isin

    subject_ccy = _currency_for(
        symbol, ((get_cached_fundamentals(symbol) or {}).get("snapshot") or {}).get("currency")
    )
    code, exch_name, country = _exchange_meta(symbol, None)
    listings: dict[str, dict] = {
        symbol.upper(): {
            "symbol": symbol, "exchange": code, "exchangeName": exch_name,
            "currency": subject_ccy, "country": country, "kind": "stock", "isSubject": True,
        }
    }

    subject_tokens = _name_tokens(name)
    subject_root = _root(symbol)

    # Query by name (Yahoo returns the cross-listings for a company name) and by the bare
    # ticker root. Best-effort — a provider hiccup degrades to the subject line alone.
    queries = [q for q in (name, subject_root) if q]
    hits: list[dict] = []
    seen_q: set[str] = set()
    for q in queries:
        if q.lower() in seen_q:
            continue
        seen_q.add(q.lower())
        try:
            hits.extend(search_symbol(q))
        except Exception:  # noqa: BLE001 — never fail the detail on a search hiccup
            continue

    for h in hits:
        sym = (h.get("symbol") or "").strip()
        if not sym or sym.upper() in listings:
            continue
        if (h.get("type") or "").upper() not in ("EQUITY", "ETF"):
            continue
        same = _same_company(subject_tokens, _name_tokens(h.get("name"))) \
            or _root(sym) == subject_root
        if not same:
            continue
        c_ccy = _currency_for(sym, h.get("currency"))
        if c_ccy is None:
            continue  # can't label its currency safely — drop rather than guess
        c_code, c_name, c_country = _exchange_meta(sym, h.get("exchange"))
        listings[sym.upper()] = {
            "symbol": sym,
            "exchange": c_code,
            "exchangeName": c_name,
            "currency": c_ccy,
            "country": c_country,
            "kind": h.get("kind") or "stock",
            "isSubject": False,
        }

    return list(listings.values())


def _why(rec: dict, base: str, alternatives_found: bool) -> str:
    exch = rec["exchangeName"]
    ccy = rec["currency"]
    if not ccy:
        return f"Showing the {exch} listing — its trading currency couldn't be confirmed."
    if ccy == base:
        return (f"Trades in {base} on {exch} — matches your portfolio base, so there's no "
                f"currency conversion or FX spread when you buy.")
    rate = latest_fx_to_chf(ccy)
    lead = "" if alternatives_found else "No CHF listing was found — "
    rate_note = f" (≈ {base} {rate:.2f} per {ccy} today)" if rate else ""
    return (f"{lead}{exch} in {ccy} is the most liquid major line; buying it means one FX "
            f"conversion to {base}{rate_note}.")


def recommend_listings(
    symbol: str, name: str | None = None, isin: str | None = None, base: str = "CHF",
    force: bool = False,
) -> dict:
    """Detect every listing of the company and recommend the one to buy for a `base`-currency
    portfolio. Cached per symbol for a week (listings barely change). Deterministic."""
    base = (base or "CHF").upper()
    cache_key = f"listings.{base}.{symbol.upper()}"
    if not force:
        cached = get_state(cache_key)
        if cached and (time.time() * 1000 - cached.get("_ts", 0)) < _TTL_MS:
            return cached["data"]

    listings = detect_listings(symbol, name, isin)
    for l in listings:
        l["score"] = _score(l["currency"], l["symbol"], base)
        l["fxToBase"] = None if l["currency"] == base else (latest_fx_to_chf(l["currency"]) or None)

    # Recommended = top score; tie-break by shorter symbol then alphabetical — deterministic.
    # Cap at the 8 strongest lines so a handful of thin foreign boards can't bury the
    # meaningful listings; the subject line is always kept even if it ranks low.
    ranked = sorted(listings, key=lambda l: (-l["score"], len(l["symbol"]), l["symbol"]))
    kept = ranked[:8]
    if not any(l["isSubject"] for l in kept):
        subject = next((l for l in ranked if l["isSubject"]), None)
        if subject:
            kept = kept[:7] + [subject]
    ranked = sorted(kept, key=lambda l: (-l["score"], len(l["symbol"]), l["symbol"]))
    recommended = ranked[0]
    alternatives = ranked[1:]
    cross_listing_available = len(listings) > 1

    data = {
        "symbol": symbol,
        "base": base,
        "singleListing": len(listings) == 1,
        "crossListingAvailable": cross_listing_available,
        "recommended": recommended,
        "alternatives": alternatives,
        "listings": ranked,
        "why": _why(recommended, base, cross_listing_available),
        "currencyMatch": recommended["currency"] == base,
    }
    set_state(cache_key, {"_ts": int(time.time() * 1000), "data": data})
    return data

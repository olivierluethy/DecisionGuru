"""Market analysis — how a company performs vs its sector, the broad market and its
competitors, plus a market-vs-company-weakness read. All price reads are CACHED-ONLY
(direct price_cache SELECTs) so a competitor loop never hits the rate-limited provider;
returns are price-return % (currency-neutral) for one consistent cross-security method.
"""
from __future__ import annotations

import statistics

import pandas as pd

from ..core import db
from .competitors import competitors
from .fundamentals import get_cached_fundamentals
from .marketdata import ensure_history, resolve_price
from .valuation import value_analysis
from ..reference.sector_etfs import sector_etf_for, BROAD_BENCHMARKS

# (key, months) — the horizons the UI offers.
WINDOWS: list[tuple[str, int]] = [
    ("1M", 1), ("3M", 3), ("6M", 6), ("1Y", 12), ("3Y", 36), ("5Y", 60),
]


def cached_closes(symbol: str, from_date: str) -> list[dict]:
    """Positive daily closes from the cache only (ascending). Never fetches."""
    rows = db.q(
        "SELECT date, close FROM price_cache WHERE symbol = ? AND date >= ? AND close > 0 "
        "ORDER BY date"
    ).all((symbol, from_date))
    return [{"date": r["date"], "close": float(r["close"])} for r in rows]


def _close_on_or_before(rows: list[dict], target: str) -> dict | None:
    best = None
    for r in rows:
        if r["date"] <= target:
            best = r
        else:
            break
    return best


def _five_years_ago() -> str:
    return (pd.Timestamp.utcnow().normalize() - pd.DateOffset(years=5)).strftime("%Y-%m-%d")


def returns_for(symbol: str) -> dict[str, float | None]:
    """Price-return fraction per WINDOWS key from cached closes; None where history is short."""
    rows = cached_closes(symbol, _five_years_ago())
    out: dict[str, float | None] = {key: None for key, _ in WINDOWS}
    if len(rows) < 2:
        return out
    last = rows[-1]
    today = pd.Timestamp(last["date"])
    for key, months in WINDOWS:
        target = (today - pd.DateOffset(months=months)).strftime("%Y-%m-%d")
        if target < rows[0]["date"]:
            continue  # not enough cached history for this window
        start = _close_on_or_before(rows, target)
        if start and start["close"] > 0:
            out[key] = round(last["close"] / start["close"] - 1, 6)
    return out


def single_return(symbol: str, months: int) -> float | None:
    """Price return over a single trailing window (months), cached-only. None if short."""
    rows = cached_closes(symbol, _five_years_ago())
    if len(rows) < 2:
        return None
    last = rows[-1]
    target = (pd.Timestamp(last["date"]) - pd.DateOffset(months=months)).strftime("%Y-%m-%d")
    if target < rows[0]["date"]:
        return None
    start = _close_on_or_before(rows, target)
    if not start or start["close"] <= 0:
        return None
    return round(last["close"] / start["close"] - 1, 6)


def rebased_series(symbol: str, months: int) -> list[dict]:
    """Closes over the trailing window rebased to 100 at the first point. [] when <2 points."""
    start_date = (pd.Timestamp.utcnow().normalize() - pd.DateOffset(months=months)).strftime("%Y-%m-%d")
    rows = cached_closes(symbol, start_date)
    if len(rows) < 2:
        return []
    base = rows[0]["close"]
    if base <= 0:
        return []
    return [{"date": r["date"], "value": round(r["close"] / base * 100.0, 4)} for r in rows]


def peer_median(returns_by_symbol: dict[str, dict], key: str) -> float | None:
    """Median of the peers' `key`-window returns, ignoring missing (None) values."""
    vals = [r.get(key) for r in returns_by_symbol.values() if r.get(key) is not None]
    return round(statistics.median(vals), 6) if vals else None


# How far apart (in return fraction) the subject and its reference must be before the gap
# is called out rather than treated as in line with the market.
_MATERIAL = 0.05


def classify(subject: float | None, sector: float | None, peer_med: float | None,
             benchmark: float | None) -> str | None:
    """Descriptive market-vs-company read — never a recommendation, never forces a Sell.

    Compares the subject's return against a sector reference (the sector ETF return, else
    the peer median) over the same horizon. Distinguishes broad-market weakness (subject
    and the market both down together) from company-specific weakness (subject down while
    the market is up)."""
    ref = sector if sector is not None else peer_med
    if subject is None or ref is None:
        return None
    gap = subject - ref
    if ref < -0.03 and subject < -0.03 and abs(gap) <= _MATERIAL:
        return "market-wide-weakness"
    if gap < -_MATERIAL:
        return "company-specific-weakness"
    if gap > _MATERIAL:
        if peer_med is not None and (subject - peer_med) > _MATERIAL:
            return "outperforming-peers"
        return "outperforming-sector"
    return "inline"


_KEY_BY_RANGE = {k: m for k, m in WINDOWS}


def _warm_background(symbols: list[str]) -> None:
    """Bounded, best-effort backfill of a FEW benchmark/sector symbols (serves cached now,
    fetches in the background). Never raises; never loops over competitors."""
    from_date = _five_years_ago()
    for sym in symbols:
        try:
            ensure_history(sym, from_date)
        except Exception:  # noqa: BLE001
            pass


def market_analysis(symbol: str, range_key: str = "1Y", settings: dict | None = None,
                    compare: list[str] | None = None) -> dict:
    months = _KEY_BY_RANGE.get(range_key, 12)
    range_key = range_key if range_key in _KEY_BY_RANGE else "1Y"

    # Comparison benchmark lines. When the caller passes an explicit `compare` list we use it
    # verbatim (any tradeable symbol — ETF or company, any market); otherwise fall back to the
    # broad defaults. Deduped, the subject itself is never a comparison line.
    raw_syms = compare if compare else [s for _k, s in BROAD_BENCHMARKS]
    compare_syms: list[str] = []
    for s in raw_syms:
        s = (s or "").strip()
        if s and s.upper() != symbol.upper() and s not in compare_syms:
            compare_syms.append(s)

    comp = competitors(symbol)
    sector = comp.get("sector")
    industry = comp.get("industry")
    snap = (get_cached_fundamentals(symbol) or {}).get("snapshot") or {}
    name = snap.get("name") or symbol
    native_ccy = snap.get("currency") or "USD"

    sector_etf = sector_etf_for(sector)
    # Warm only the subject + selected comparison lines + this sector's ETF — never the peer loop.
    _warm_background(list(dict.fromkeys([symbol, *compare_syms,
                                         *([sector_etf] if sector_etf else [])])))

    # Per-security cached returns (subject + peers), computed once.
    peers = comp.get("peers") or []
    # Warm the (bounded) peer set's price history in the background so their returns fill in
    # on a following poll — peers are now a small, intentional discovered set, not the old
    # unbounded universe, so warming them no longer risks a fan-out.
    _warm_background([p["symbol"] for p in peers if p.get("symbol")])
    returns_by_symbol: dict[str, dict] = {p["symbol"]: returns_for(p["symbol"]) for p in peers}
    if symbol not in returns_by_symbol:
        returns_by_symbol[symbol] = returns_for(symbol)
    subj_returns = returns_by_symbol.get(symbol, returns_for(symbol))
    subject_pct = subj_returns.get(range_key)

    competitors_out: list[dict] = []
    for p in peers:
        r = returns_by_symbol.get(p["symbol"], {})
        peer_pct = r.get(range_key)
        competitors_out.append({
            "symbol": p["symbol"], "name": p.get("name"), "isSubject": p.get("isSubject", False),
            # CHF-normalised cap computed once in competitors() (also drives the peer ranking);
            # native cap + currency travel too so the UI can still show a value when no FX rate.
            "marketCapCHF": p.get("marketCapCHF"),
            "marketCap": p.get("marketCap"), "currency": p.get("currency"),
            "trailingPE": p.get("trailingPE"), "priceToBook": p.get("priceToBook"),
            "profitMargins": p.get("profitMargins"), "revenueGrowth": p.get("revenueGrowth"),
            "returns": r,
            "relativeToSubjectPct": (round(peer_pct - subject_pct, 6)
                                     if (peer_pct is not None and subject_pct is not None) else None),
        })

    peer_only = {s: r for s, r in returns_by_symbol.items() if s != symbol}
    peer_med = peer_median(peer_only, range_key)

    # Sector line: real ETF when its history is cached, else the peer median, else unavailable.
    sector_etf_pct = single_return(sector_etf, months) if sector_etf else None
    if sector_etf and sector_etf_pct is not None:
        sector_line = {"kind": "etf", "symbol": sector_etf, "label": f"{sector} · {sector_etf}",
                       "returnPct": sector_etf_pct, "series": rebased_series(sector_etf, months)}
    elif peer_med is not None:
        sector_line = {"kind": "peer-median", "symbol": None,
                       "label": f"{sector or 'Sector'} · peer median",
                       "returnPct": peer_med, "series": []}
    else:
        sector_line = {"kind": "unavailable", "label": "Sector performance unavailable",
                       "returnPct": None, "series": []}

    benchmarks_out: list[dict] = []
    for sym in compare_syms:
        benchmarks_out.append({"key": sym, "symbol": sym, "returnPct": single_return(sym, months),
                               "series": rebased_series(sym, months)})

    sector_pct_for_class = sector_etf_pct if (sector_etf and sector_etf_pct is not None) else None
    # Broad-market reference for the headline read: prefer a classic broad benchmark when present.
    broad_pct = next((b["returnPct"] for b in benchmarks_out if b["symbol"] in ("SPY", "VWRL.SW")), None)
    classification = classify(subject_pct, sector_pct_for_class, peer_med, broad_pct)

    # Opportunity-cost tie-in: the existing valuation band/MoS at the resolved price (cached).
    valuation = None
    try:
        rp = resolve_price(symbol, native_ccy)
        va = value_analysis(symbol, rp.get("price"), native_ccy, None, settings)
        valuation = {"band": va.get("band"), "marginOfSafety": va.get("marginOfSafety"),
                     "fairValue": va.get("fairValue")}
    except Exception:  # noqa: BLE001
        valuation = None

    return {
        "symbol": symbol, "name": name, "sector": sector, "industry": industry,
        "displayCurrency": "CHF", "range": range_key,
        "subject": {"returnPct": subject_pct, "returns": subj_returns,
                    "series": rebased_series(symbol, months)},
        "benchmarks": benchmarks_out,
        "sectorLine": sector_line,
        "competitors": competitors_out,
        "peerMedianReturnPct": peer_med,
        "classification": classification,
        "valuation": valuation,
    }

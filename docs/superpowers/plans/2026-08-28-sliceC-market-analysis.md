# Slice C — Market Analysis section Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dedicated "Market Analysis" view — shown on the position/Decisions detail page, in Research, and in the opportunity modal — that answers "is this company's weakness the market's, its sector's, or its own?" via competitor performance, a sector/broad-benchmark comparison, a market-vs-company-weakness verdict, and an opportunity-cost tie-in to the existing valuation.

**Architecture:** One reusable frontend component `<MarketAnalysis symbol range>` backed by one new backend endpoint `GET /research/market/{symbol}?range=`. The backend reuses the existing `competitors()` peer set and `value_analysis`, adds cached-only price-return computation per security, a curated sector-ETF map (with peer-median fallback), and a pure market-vs-company classifier. Everything reads the SQLite `price_cache`/`fundamentals_cache` **cached-only** (no per-request provider loop) to respect the Yahoo rate limit; the broad-benchmark/sector-ETF closes are warmed by a bounded background `ensure_history` (≤4 symbols), never a per-peer fetch.

**Tech Stack:** Python 3.12 / FastAPI, pytest (`backend/tests`); Vite + React + TypeScript + Tailwind (dark only), react-query, Recharts.

## Global Constraints

- **Never fabricate data.** No invented competitors, prices, sector performance, or fair values. Missing sector/competitor/history → an explicit "unavailable" state, never a guess. Cross-security performance comparison uses **price-return %** (currency-neutral — one consistent methodology). Market caps shown in CHF are converted via `fx` and omitted when FX is unresolved.
- **Never force a Sell.** The market-vs-company classifier is descriptive; it never emits a recommendation. Relative underperformance never becomes "Sell" (upholds the verdict-engine invariant).
- **Cached-only reads in the request path** for competitor loops (`price_cache` direct SELECTs). Only the subject + the two broad benchmarks + the one sector ETF may trigger a bounded background `ensure_history` (which serves cached now, backfills later).
- **Reuse, don't fork:** `services/competitors.py` (`competitors(symbol)`), `services/valuation.py` (`value_analysis`), `services/fx.py`, `services/marketdata.py` cached accessors. No duplicated business logic.
- Tests are **required for the financial engine** (`backend/tests`, pytest; run `cd backend && .venv/bin/python -m pytest`); test output must be pristine. Frontend has **no** automated tests — gate is `npm run build` (`tsc --noEmit && vite build`) from repo root; a pre-existing ">500 kB chunk" warning is expected.
- Dark-only Tailwind semantic tokens (`text`/`text-muted`/`text-faint`/`hairline`/`azure`/`gold`/`gain`/`loss`/`warn`); **modals not redirects** (the section is in-page / in the existing modal). Conventional Commits. Backend restart needed for the new route (no DB migration — additive JSON + read-only queries).
- yfinance sector strings are e.g. `Healthcare`, `Technology`, `Financial Services`, `Energy`, `Consumer Defensive`, `Consumer Cyclical`, `Industrials`, `Basic Materials`, `Utilities`, `Real Estate`, `Communication Services`.

---

### Task C1: Curated sector-ETF reference

**Files:**
- Create: `backend/app/reference/sector_etfs.py`
- Test: `backend/tests/test_sector_etfs.py`

**Interfaces:**
- Produces: `SECTOR_ETF: dict[str,str]`; `BROAD_BENCHMARKS: list[tuple[str,str]]` (key, symbol); `sector_etf_for(sector: str | None) -> str | None`; `MARKET_ANALYSIS_SYMBOLS: list[str]` (the sector ETFs + broad benchmark symbols, for background warming).

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_sector_etfs.py`:

```python
from app.reference import sector_etfs as se


def test_known_sector_maps_to_spdr_etf():
    assert se.sector_etf_for("Healthcare") == "XLV"
    assert se.sector_etf_for("Technology") == "XLK"
    assert se.sector_etf_for("Financial Services") == "XLF"


def test_unknown_or_missing_sector_is_none():
    assert se.sector_etf_for("Nonexistent Sector") is None
    assert se.sector_etf_for(None) is None
    assert se.sector_etf_for("") is None


def test_market_analysis_symbols_covers_etfs_and_broad_benchmarks():
    for sym in se.SECTOR_ETF.values():
        assert sym in se.MARKET_ANALYSIS_SYMBOLS
    for _key, sym in se.BROAD_BENCHMARKS:
        assert sym in se.MARKET_ANALYSIS_SYMBOLS
    # No duplicates.
    assert len(se.MARKET_ANALYSIS_SYMBOLS) == len(set(se.MARKET_ANALYSIS_SYMBOLS))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_sector_etfs.py -q`
Expected: FAIL — `ModuleNotFoundError: app.reference.sector_etfs`.

- [ ] **Step 3: Implement the reference**

Create `backend/app/reference/sector_etfs.py`:

```python
"""Curated sector benchmark proxy — the US SPDR sector ETFs, keyed by the provider's
sector string. There is no sector-index data feed, so this maps a company's sector to a
real, fetchable sector ETF used as the sector benchmark; when a sector has no mapping the
caller falls back to the median of the identified peers (never a fabricated index).
"""
from __future__ import annotations

# yfinance `sector` strings → SPDR sector ETF. Aliases included for the few sectors the
# provider labels inconsistently across listings.
SECTOR_ETF: dict[str, str] = {
    "Healthcare": "XLV",
    "Technology": "XLK",
    "Information Technology": "XLK",
    "Financial Services": "XLF",
    "Financials": "XLF",
    "Energy": "XLE",
    "Consumer Defensive": "XLP",
    "Consumer Staples": "XLP",
    "Consumer Cyclical": "XLY",
    "Consumer Discretionary": "XLY",
    "Industrials": "XLI",
    "Basic Materials": "XLB",
    "Materials": "XLB",
    "Utilities": "XLU",
    "Real Estate": "XLRE",
    "Communication Services": "XLC",
}

# Real, fetchable broad benchmarks: US large cap + global all-world (CHF-listed).
BROAD_BENCHMARKS: list[tuple[str, str]] = [("sp500", "SPY"), ("world", "VWRL.SW")]


def sector_etf_for(sector: str | None) -> str | None:
    """The sector ETF for a provider sector string, or None when unmapped/missing."""
    return SECTOR_ETF.get(sector) if sector else None


# Symbols whose price history the market-analysis endpoint warms in the background so the
# sector/broad-benchmark lines fill in (deduped, stable order).
MARKET_ANALYSIS_SYMBOLS: list[str] = list(dict.fromkeys(
    [*SECTOR_ETF.values(), *(sym for _key, sym in BROAD_BENCHMARKS)]
))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_sector_etfs.py -q`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/reference/sector_etfs.py backend/tests/test_sector_etfs.py
git commit -m "feat(reference): curated sector-ETF map for the sector benchmark proxy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

### Task C2: Cached-only price returns + rebased series

**Files:**
- Create: `backend/app/services/market_analysis.py` (returns/series helpers only in this task)
- Test: `backend/tests/test_market_returns.py`

**Interfaces:**
- Consumes: `app.core.db` (`db.q(sql).all(params)` → `list[sqlite3.Row]`, rows indexed by column name; `db.execute(sql, params)` for the tests to seed `price_cache(symbol, date, close)`).
- Produces:
  - `WINDOWS: list[tuple[str,int]]` = `[("1M",1),("3M",3),("6M",6),("1Y",12),("3Y",36),("5Y",60)]` (key, months).
  - `cached_closes(symbol: str, from_date: str) -> list[dict]` — `[{"date","close"}]` from `price_cache` only (close>0, ascending). Never fetches.
  - `returns_for(symbol: str) -> dict[str, float | None]` — price-return fraction per WINDOWS key from cached closes; `None` for a window with insufficient history.
  - `single_return(symbol: str, months: int) -> float | None` — the one-window return (used by the classifier).
  - `rebased_series(symbol: str, months: int) -> list[dict]` — `[{"date","value"}]` rebased to 100 at the window's first cached point; `[]` when <2 points.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_market_returns.py`:

```python
"""Cached-only price-return + rebased-series helpers for market analysis."""
from __future__ import annotations

import pandas as pd
import pytest

from app.core import db
from app.services import market_analysis as ma


def _seed(symbol: str, points: list[tuple[str, float]]) -> None:
    for d, c in points:
        db.execute(
            "INSERT OR REPLACE INTO price_cache (symbol, date, close) VALUES (?, ?, ?)",
            (symbol, d, c),
        )


@pytest.fixture(autouse=True)
def _clean():
    db.execute("DELETE FROM price_cache WHERE symbol LIKE 'TST%'")
    yield
    db.execute("DELETE FROM price_cache WHERE symbol LIKE 'TST%'")


def test_returns_for_computes_window_fractions():
    today = pd.Timestamp.utcnow().normalize()
    d_today = today.strftime("%Y-%m-%d")
    d_1m = (today - pd.DateOffset(months=1)).strftime("%Y-%m-%d")
    d_1y = (today - pd.DateOffset(months=12)).strftime("%Y-%m-%d")
    _seed("TSTA", [(d_1y, 100.0), (d_1m, 110.0), (d_today, 120.0)])
    r = ma.returns_for("TSTA")
    assert r["1Y"] == pytest.approx(0.20, abs=1e-6)   # 120/100 - 1
    assert r["1M"] == pytest.approx(120.0 / 110.0 - 1, abs=1e-6)
    assert r["5Y"] is None                             # no 5y-old close cached


def test_returns_for_insufficient_history_all_none():
    _seed("TSTB", [("2026-08-01", 50.0)])              # single point
    r = ma.returns_for("TSTB")
    assert all(v is None for v in r.values())


def test_rebased_series_starts_at_100():
    today = pd.Timestamp.utcnow().normalize()
    d0 = (today - pd.DateOffset(months=1)).strftime("%Y-%m-%d")
    d1 = today.strftime("%Y-%m-%d")
    _seed("TSTC", [(d0, 200.0), (d1, 220.0)])
    s = ma.rebased_series("TSTC", 3)
    assert len(s) == 2
    assert s[0]["value"] == pytest.approx(100.0, abs=1e-6)
    assert s[-1]["value"] == pytest.approx(110.0, abs=1e-6)  # 220/200 × 100


def test_single_return_matches_returns_for():
    today = pd.Timestamp.utcnow().normalize()
    d_6m = (today - pd.DateOffset(months=6)).strftime("%Y-%m-%d")
    d_now = today.strftime("%Y-%m-%d")
    _seed("TSTD", [(d_6m, 80.0), (d_now, 100.0)])
    assert ma.single_return("TSTD", 6) == pytest.approx(0.25, abs=1e-6)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_market_returns.py -q`
Expected: FAIL — `ModuleNotFoundError: app.services.market_analysis`.

- [ ] **Step 3: Implement the helpers**

Create `backend/app/services/market_analysis.py`:

```python
"""Market analysis — how a company performs vs its sector, the broad market and its
competitors, plus a market-vs-company-weakness read. All price reads are CACHED-ONLY
(direct price_cache SELECTs) so a competitor loop never hits the rate-limited provider;
returns are price-return % (currency-neutral) for one consistent cross-security method.
"""
from __future__ import annotations

import pandas as pd

from ..core import db

# (key, months) — the horizons the UI offers.
WINDOWS: list[tuple[str, int]] = [
    ("1M", 1), ("3M", 3), ("6M", 6), ("1Y", 12), ("3Y", 36), ("5Y", 60),
]
_MONTHS = dict(WINDOWS)


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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_market_returns.py -q`
Expected: PASS (4 passed).

- [ ] **Step 5: Run the full backend suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS (all prior + new; count = previous total + 4).

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/market_analysis.py backend/tests/test_market_returns.py
git commit -m "feat(market-analysis): cached-only price returns + rebased series helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

### Task C3: Sector line + market-vs-company classifier

**Files:**
- Modify: `backend/app/services/market_analysis.py` (add pure functions)
- Test: `backend/tests/test_market_classifier.py`

**Interfaces:**
- Consumes: `sector_etfs.sector_etf_for`, `returns_for`/`single_return` (Task C2), `statistics.median`.
- Produces:
  - `peer_median(returns_by_symbol: dict[str, dict], key: str) -> float | None` — median of peers' `key` returns (excludes None).
  - `classify(subject: float | None, sector: float | None, peer_med: float | None, benchmark: float | None) -> str | None` — one of `market-wide-weakness | company-specific-weakness | outperforming-sector | outperforming-peers | inline`, or `None` when there is nothing to compare against.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_market_classifier.py`:

```python
from app.services import market_analysis as ma


def test_scenario_a_market_wide_weakness():
    # Subject -20%, sector -18%, peers ~-19% → the whole market is weak.
    assert ma.classify(-0.20, -0.18, -0.19, -0.17) == "market-wide-weakness"


def test_scenario_b_company_specific_weakness():
    # Subject -20% while sector +12% and peers positive → the company, not the market.
    assert ma.classify(-0.20, 0.12, 0.10, 0.11) == "company-specific-weakness"


def test_outperforming_peers_when_ahead_of_both():
    assert ma.classify(0.30, 0.10, 0.08, 0.09) == "outperforming-peers"


def test_outperforming_sector_when_ahead_of_sector_only():
    # Ahead of the sector but not clearly ahead of the peer median.
    assert ma.classify(0.18, 0.10, 0.17, 0.09) == "outperforming-sector"


def test_inline_when_close_to_reference():
    assert ma.classify(0.11, 0.10, 0.10, 0.09) == "inline"


def test_none_when_no_reference():
    assert ma.classify(-0.20, None, None, None) is None
    assert ma.classify(None, 0.10, 0.10, 0.10) is None


def test_peer_median_ignores_none():
    r = {"A": {"1Y": 0.10}, "B": {"1Y": None}, "C": {"1Y": 0.30}}
    assert ma.peer_median(r, "1Y") == 0.20
    assert ma.peer_median({"A": {"1Y": None}}, "1Y") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_market_classifier.py -q`
Expected: FAIL — `AttributeError: module 'app.services.market_analysis' has no attribute 'classify'`.

- [ ] **Step 3: Implement the pure functions**

Add to `backend/app/services/market_analysis.py` (append after `rebased_series`; add `import statistics` to the imports at the top):

```python
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_market_classifier.py -q`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/market_analysis.py backend/tests/test_market_classifier.py
git commit -m "feat(market-analysis): sector-line reference + market-vs-company classifier

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

### Task C4: Assemble the bundle + the endpoint

**Files:**
- Modify: `backend/app/services/market_analysis.py` (add `market_analysis(...)`)
- Modify: `backend/app/routers/research.py` (add the route)
- Test: `backend/tests/test_market_analysis_bundle.py`

**Interfaces:**
- Consumes: `competitors` from `services/competitors.py`; `sector_etfs` (C1); `returns_for`/`rebased_series`/`peer_median`/`classify`/`single_return`/`WINDOWS` (C2/C3); `fx.get_fx_rate`; `marketdata.ensure_history`, `marketdata.resolve_price`; `valuation.value_analysis`; `fundamentals.get_cached_fundamentals`.
- Produces: `market_analysis(symbol: str, range_key: str = "1Y", settings: dict | None = None) -> dict` and route `GET /research/market/{symbol:path}?range=`.

Bundle shape:
```
{
  symbol, name, sector, industry, displayCurrency: "CHF", range,
  subject: { returnPct, returns: {..all windows..}, series: [{date,value}] },
  benchmarks: [ { key, symbol, returnPct, series } ],          # sp500, world
  sectorLine: { kind: "etf"|"peer-median"|"unavailable", symbol?, label, returnPct, series },
  competitors: [ { symbol, name, isSubject, marketCapCHF, trailingPE, priceToBook,
                   profitMargins, revenueGrowth, returns: {..}, relativeToSubjectPct } ],
  peerMedianReturnPct, classification,
  valuation: { band, marginOfSafety, fairValue } | null,       # opportunity-cost tie-in
}
```

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_market_analysis_bundle.py`:

```python
"""Bundle assembly for the market-analysis endpoint. Provider-touching sub-calls are
stubbed; price history is seeded into the cache so the returns/series are real."""
from __future__ import annotations

import pandas as pd
import pytest

from app.core import db
from app.services import market_analysis as ma


def _seed(symbol, points):
    for d, c in points:
        db.execute("INSERT OR REPLACE INTO price_cache (symbol, date, close) VALUES (?, ?, ?)",
                   (symbol, d, c))


@pytest.fixture(autouse=True)
def _clean():
    db.execute("DELETE FROM price_cache WHERE symbol LIKE 'MKT%' OR symbol IN ('SPY','VWRL.SW','XLV')")
    yield
    db.execute("DELETE FROM price_cache WHERE symbol LIKE 'MKT%' OR symbol IN ('SPY','VWRL.SW','XLV')")


def test_bundle_company_specific_weakness(monkeypatch):
    today = pd.Timestamp.utcnow().normalize()
    d1y = (today - pd.DateOffset(months=12)).strftime("%Y-%m-%d")
    dnow = today.strftime("%Y-%m-%d")
    # Subject down 20%, sector ETF up 12%, a peer up 10%.
    _seed("MKTS", [(d1y, 100.0), (dnow, 80.0)])
    _seed("XLV", [(d1y, 100.0), (dnow, 112.0)])
    _seed("MKTP", [(d1y, 100.0), (dnow, 110.0)])
    _seed("SPY", [(d1y, 100.0), (dnow, 111.0)])
    _seed("VWRL.SW", [(d1y, 100.0), (dnow, 108.0)])

    # Stub the peer set + fundamentals + price + valuation (no provider/network).
    monkeypatch.setattr(ma, "competitors", lambda sym: {
        "symbol": "MKTS", "sector": "Healthcare", "industry": "Drug Manufacturers",
        "peers": [
            {"symbol": "MKTS", "name": "Subject Co", "isSubject": True, "marketCap": 2e11,
             "currency": "USD", "trailingPE": 15, "priceToBook": 3, "profitMargins": 0.2,
             "revenueGrowth": 0.05},
            {"symbol": "MKTP", "name": "Peer Co", "isSubject": False, "marketCap": 1e11,
             "currency": "USD", "trailingPE": 20, "priceToBook": 4, "profitMargins": 0.1,
             "revenueGrowth": 0.08},
        ],
    })
    monkeypatch.setattr(ma, "get_cached_fundamentals", lambda sym: {
        "snapshot": {"name": "Subject Co", "sector": "Healthcare",
                     "industry": "Drug Manufacturers", "currency": "USD"}})
    monkeypatch.setattr(ma, "resolve_price", lambda sym, cur=None: {"price": 80.0, "currency": "USD"})
    monkeypatch.setattr(ma, "value_analysis", lambda *a, **k: {
        "band": {"band": "overvalued"}, "marginOfSafety": -0.15, "fairValue": 70.0})
    monkeypatch.setattr(ma, "get_fx_rate", lambda *a, **k: 0.9)
    monkeypatch.setattr(ma, "ensure_history", lambda *a, **k: None)

    b = ma.market_analysis("MKTS", "1Y", settings={})
    assert b["sector"] == "Healthcare"
    assert b["subject"]["returnPct"] == pytest.approx(-0.20, abs=1e-6)
    assert b["sectorLine"]["kind"] == "etf" and b["sectorLine"]["symbol"] == "XLV"
    assert b["sectorLine"]["returnPct"] == pytest.approx(0.12, abs=1e-6)
    assert b["classification"] == "company-specific-weakness"
    subj = next(c for c in b["competitors"] if c["isSubject"])
    assert subj["marketCapCHF"] == pytest.approx(2e11 * 0.9, rel=1e-6)
    assert b["valuation"]["band"]["band"] == "overvalued"
    assert any(bm["key"] == "sp500" for bm in b["benchmarks"])


def test_bundle_sector_falls_back_to_peer_median(monkeypatch):
    today = pd.Timestamp.utcnow().normalize()
    d1y = (today - pd.DateOffset(months=12)).strftime("%Y-%m-%d")
    dnow = today.strftime("%Y-%m-%d")
    _seed("MKTS", [(d1y, 100.0), (dnow, 90.0)])
    _seed("MKTP", [(d1y, 100.0), (dnow, 120.0)])   # peer +20%, no XLE seeded
    monkeypatch.setattr(ma, "competitors", lambda sym: {
        "symbol": "MKTS", "sector": "Energy", "industry": "Oil & Gas",
        "peers": [
            {"symbol": "MKTS", "name": "S", "isSubject": True, "marketCap": None, "currency": "USD"},
            {"symbol": "MKTP", "name": "P", "isSubject": False, "marketCap": None, "currency": "USD"},
        ]})
    monkeypatch.setattr(ma, "get_cached_fundamentals", lambda sym: {
        "snapshot": {"name": "S", "sector": "Energy", "industry": "Oil & Gas", "currency": "USD"}})
    monkeypatch.setattr(ma, "resolve_price", lambda sym, cur=None: {"price": 90.0, "currency": "USD"})
    monkeypatch.setattr(ma, "value_analysis", lambda *a, **k: {"band": None, "marginOfSafety": None, "fairValue": None})
    monkeypatch.setattr(ma, "get_fx_rate", lambda *a, **k: None)   # FX unresolved → no CHF cap
    monkeypatch.setattr(ma, "ensure_history", lambda *a, **k: None)
    db.execute("DELETE FROM price_cache WHERE symbol = 'XLE'")

    b = ma.market_analysis("MKTS", "1Y", settings={})
    assert b["sectorLine"]["kind"] == "peer-median"
    assert b["sectorLine"]["returnPct"] == pytest.approx(0.20, abs=1e-6)   # median of [peer +20%]
    subj = next(c for c in b["competitors"] if c["isSubject"])
    assert subj["marketCapCHF"] is None    # FX unresolved → not fabricated


def test_no_sector_yields_unavailable_sector_line(monkeypatch):
    monkeypatch.setattr(ma, "competitors", lambda sym: {
        "symbol": "MKTS", "sector": None, "industry": None, "peers": []})
    monkeypatch.setattr(ma, "get_cached_fundamentals", lambda sym: {"snapshot": {"currency": "USD"}})
    monkeypatch.setattr(ma, "resolve_price", lambda sym, cur=None: {"price": None, "currency": "USD"})
    monkeypatch.setattr(ma, "value_analysis", lambda *a, **k: {"band": None, "marginOfSafety": None, "fairValue": None})
    monkeypatch.setattr(ma, "get_fx_rate", lambda *a, **k: 0.9)
    monkeypatch.setattr(ma, "ensure_history", lambda *a, **k: None)
    b = ma.market_analysis("MKTS", "1Y", settings={})
    assert b["sectorLine"]["kind"] == "unavailable"
    assert b["classification"] is None
    assert b["competitors"] == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_market_analysis_bundle.py -q`
Expected: FAIL — `AttributeError: module 'app.services.market_analysis' has no attribute 'market_analysis'` (and missing imported names).

- [ ] **Step 3: Implement the assembler**

Add these imports to the top of `backend/app/services/market_analysis.py` (below the existing `from ..core import db`):

```python
from .competitors import competitors
from .fundamentals import get_cached_fundamentals
from .marketdata import ensure_history, resolve_price
from .valuation import value_analysis
from .fx import get_fx_rate
from ..reference.sector_etfs import sector_etf_for, BROAD_BENCHMARKS, MARKET_ANALYSIS_SYMBOLS
```

Then append the assembler:

```python
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


def market_analysis(symbol: str, range_key: str = "1Y", settings: dict | None = None) -> dict:
    months = _KEY_BY_RANGE.get(range_key, 12)
    range_key = range_key if range_key in _KEY_BY_RANGE else "1Y"

    comp = competitors(symbol)
    sector = comp.get("sector")
    industry = comp.get("industry")
    snap = (get_cached_fundamentals(symbol) or {}).get("snapshot") or {}
    name = snap.get("name") or symbol
    native_ccy = snap.get("currency") or "USD"

    sector_etf = sector_etf_for(sector)
    # Warm only the subject + broad benchmarks + this sector's ETF — never the peer loop.
    _warm_background(list(dict.fromkeys([symbol, *[s for _k, s in BROAD_BENCHMARKS],
                                         *([sector_etf] if sector_etf else [])])))

    # Per-security cached returns (subject + peers), computed once.
    peers = comp.get("peers") or []
    returns_by_symbol: dict[str, dict] = {p["symbol"]: returns_for(p["symbol"]) for p in peers}
    if symbol not in returns_by_symbol:
        returns_by_symbol[symbol] = returns_for(symbol)
    subj_returns = returns_by_symbol.get(symbol, returns_for(symbol))
    subject_pct = subj_returns.get(range_key)

    def _fx(amount, ccy):
        if amount is None:
            return None
        rate = get_fx_rate(ccy or native_ccy, "CHF", pd.Timestamp.utcnow().strftime("%Y-%m-%d"), strict=True)
        return round(amount * rate, 2) if rate is not None else None

    competitors_out: list[dict] = []
    for p in peers:
        r = returns_by_symbol.get(p["symbol"], {})
        peer_pct = r.get(range_key)
        competitors_out.append({
            "symbol": p["symbol"], "name": p.get("name"), "isSubject": p.get("isSubject", False),
            "marketCapCHF": _fx(p.get("marketCap"), p.get("currency")),
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
    for key, sym in BROAD_BENCHMARKS:
        benchmarks_out.append({"key": key, "symbol": sym, "returnPct": single_return(sym, months),
                               "series": rebased_series(sym, months)})

    sector_pct_for_class = sector_etf_pct if (sector_etf and sector_etf_pct is not None) else None
    broad_pct = next((b["returnPct"] for b in benchmarks_out if b["key"] == "sp500"), None)
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
```

- [ ] **Step 4: Add the route**

In `backend/app/routers/research.py`, add near the other GET routes (e.g. after the `competitors` route ~line 143):

```python
@router.get("/market/{symbol:path}")
async def market(symbol: str, range: str = "1Y") -> dict:
    """Market analysis: sector/broad-benchmark/competitor performance + a market-vs-company
    read + the valuation tie-in, so the user can tell company-specific weakness from a weak
    market. Cached-only reads."""
    from ..services.market_analysis import market_analysis
    settings = get_settings()
    return await run_in_threadpool(market_analysis, symbol, range, settings)
```

(Confirm `get_settings` and `run_in_threadpool` are already imported in this file — they are, used by neighbouring routes.)

- [ ] **Step 5: Run the bundle tests, then the full suite**

Run: `cd backend && .venv/bin/python -m pytest tests/test_market_analysis_bundle.py -q`
Expected: PASS (3 passed).
Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/market_analysis.py backend/app/routers/research.py backend/tests/test_market_analysis_bundle.py
git commit -m "feat(market-analysis): assemble bundle + GET /research/market/{symbol}

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

### Task C5: Frontend — `MarketAnalysis` component + API

**Files:**
- Modify: `frontend/src/lib/api.ts` (add `MarketAnalysisResult` + `api.marketAnalysis`)
- Create: `frontend/src/components/MarketAnalysis.tsx`

**Interfaces:**
- Consumes: `api` `req` helper; `Spinner`/`EmptyState`/`Stat` from `../components/ui`; `fmtPct`/`fmtPctSigned`/`fmtMoney` from `../lib/format`; Recharts; `ValuationBand` types (band) already in api.ts.
- Produces: `export function MarketAnalysis({ symbol }: { symbol: string })`.

- [ ] **Step 1: Add the API type + call**

In `frontend/src/lib/api.ts`, add the response type (place near the other research interfaces, e.g. after `CompetitorsResult`):

```typescript
export type MarketClassification =
  | 'market-wide-weakness' | 'company-specific-weakness'
  | 'outperforming-sector' | 'outperforming-peers' | 'inline';

export interface MarketSeriesPoint { date: string; value: number }
export interface MarketCompetitor {
  symbol: string; name: string | null; isSubject: boolean;
  marketCapCHF: number | null; trailingPE: number | null; priceToBook: number | null;
  profitMargins: number | null; revenueGrowth: number | null;
  returns: Record<string, number | null>; relativeToSubjectPct: number | null;
}
export interface MarketAnalysisResult {
  symbol: string; name: string; sector: string | null; industry: string | null;
  displayCurrency: string; range: string;
  subject: { returnPct: number | null; returns: Record<string, number | null>; series: MarketSeriesPoint[] };
  benchmarks: { key: string; symbol: string; returnPct: number | null; series: MarketSeriesPoint[] }[];
  sectorLine: { kind: 'etf' | 'peer-median' | 'unavailable'; symbol?: string | null; label: string; returnPct: number | null; series: MarketSeriesPoint[] };
  competitors: MarketCompetitor[];
  peerMedianReturnPct: number | null;
  classification: MarketClassification | null;
  valuation: { band: ValuationBand | null; marginOfSafety: number | null; fairValue: number | null } | null;
}
```

Add the method inside the exported `api` object, next to `competitors`:

```typescript
  marketAnalysis: (symbol: string, range = '1Y') =>
    req<MarketAnalysisResult>(`/research/market/${encodeURIComponent(symbol)}?range=${range}`),
```

- [ ] **Step 2: Create the component**

Create `frontend/src/components/MarketAnalysis.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import { api, type MarketAnalysisResult, type MarketClassification } from '../lib/api';
import { Spinner, EmptyState } from './ui';
import { fmtPct, fmtPctSigned, fmtMoney, fmtDate } from '../lib/format';

const RANGES = ['1M', '3M', '6M', '1Y', '3Y', '5Y'] as const;
type MarketRange = (typeof RANGES)[number];

const CLASS_META: Record<MarketClassification, { label: string; tone: string; blurb: string }> = {
  'market-wide-weakness': { label: 'Market-wide weakness', tone: 'text-warn',
    blurb: 'The whole sector is down — the weakness is largely the market, not the company alone.' },
  'company-specific-weakness': { label: 'Company-specific weakness', tone: 'text-loss',
    blurb: 'The sector is holding up while this company lags — the weakness looks specific to it.' },
  'outperforming-sector': { label: 'Outperforming its sector', tone: 'text-gain',
    blurb: 'Ahead of its sector benchmark over this horizon.' },
  'outperforming-peers': { label: 'Outperforming peers', tone: 'text-gain',
    blurb: 'Ahead of both its sector and the median competitor over this horizon.' },
  inline: { label: 'In line with its market', tone: 'text-text-muted',
    blurb: 'Tracking its sector and peers over this horizon.' },
};

// Distinct dark-legible line colours; azure is always the subject.
const LINE_COLORS = ['#4FD0E0', '#D9A94E', '#A98BFF', '#B6D94E', '#EC6DB0'];

export function MarketAnalysis({ symbol }: { symbol: string }) {
  const [range, setRange] = useState<MarketRange>('1Y');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['market-analysis', symbol, range],
    queryFn: () => api.marketAnalysis(symbol, range),
    staleTime: 60 * 60_000,
    retry: 1,
  });

  if (isLoading) return <Spinner label="Reading the market…" />;
  if (isError || !data) return <EmptyState title="Market analysis unavailable" hint="Try again shortly." />;

  const cls = data.classification ? CLASS_META[data.classification] : null;

  // Build a merged {date → {subject, sp500, world, sector}} for the multi-line chart.
  const lines: { key: string; label: string; color: string; series: { date: string; value: number }[] }[] = [];
  lines.push({ key: 'subject', label: data.symbol, color: '#4FD0E0', series: data.subject.series });
  data.benchmarks.forEach((b, i) => {
    if (b.series.length > 1) lines.push({ key: b.key, label: b.symbol, color: LINE_COLORS[(i + 1) % LINE_COLORS.length], series: b.series });
  });
  if (data.sectorLine.kind === 'etf' && data.sectorLine.series.length > 1) {
    lines.push({ key: 'sector', label: data.sectorLine.label, color: '#D9A94E', series: data.sectorLine.series });
  }
  const byDate = new Map<string, Record<string, number | string>>();
  for (const ln of lines) for (const p of ln.series) {
    const row = byDate.get(p.date) ?? { date: p.date };
    row[ln.key] = p.value;
    byDate.set(p.date, row);
  }
  const chartData = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return (
    <div className="space-y-5">
      {/* Company context */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div><span className="eyebrow mr-2">Company</span><span className="text-text">{data.name}</span></div>
        <div><span className="eyebrow mr-2">Sector</span><span className="text-text">{data.sector ?? 'unavailable'}</span></div>
        <div><span className="eyebrow mr-2">Industry</span><span className="text-text">{data.industry ?? 'unavailable'}</span></div>
      </div>

      {/* Range selector */}
      <div className="flex flex-wrap gap-1.5">
        {RANGES.map((r) => (
          <button key={r} onClick={() => setRange(r)}
            className={`chip cursor-pointer ${range === r ? '!border-azure/50 !text-text' : 'opacity-50'}`}>{r}</button>
        ))}
      </div>

      {/* Market-vs-company headline */}
      {cls && (
        <div className={`card !p-4 border-l-2 ${cls.tone === 'text-loss' ? 'border-l-loss' : cls.tone === 'text-gain' ? 'border-l-gain' : 'border-l-warn'}`}>
          <div className={`font-semibold ${cls.tone}`}>{cls.label}</div>
          <p className="text-sm text-text-muted mt-1">{cls.blurb}</p>
          <div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-[12px]">
            <span><span className="eyebrow mr-1">This stock</span><span className={data.subject.returnPct != null && data.subject.returnPct < 0 ? 'text-loss' : 'text-gain'}>{fmtPctSigned(data.subject.returnPct)}</span></span>
            <span><span className="eyebrow mr-1">Sector</span>{fmtPctSigned(data.sectorLine.returnPct)} <span className="text-text-faint">({data.sectorLine.kind === 'peer-median' ? 'peer median' : data.sectorLine.kind === 'etf' ? data.sectorLine.symbol : 'n/a'})</span></span>
            <span><span className="eyebrow mr-1">Peer median</span>{fmtPctSigned(data.peerMedianReturnPct)}</span>
            {data.benchmarks.map((b) => (
              <span key={b.key}><span className="eyebrow mr-1">{b.symbol}</span>{fmtPctSigned(b.returnPct)}</span>
            ))}
          </div>
        </div>
      )}

      {/* Rebased performance chart */}
      {chartData.length > 1 ? (
        <div style={{ width: '100%', height: 240 }}>
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#243040" strokeDasharray="2 4" strokeOpacity={0.5} vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#5F6E82' }} minTickGap={48}
                tickFormatter={(d) => fmtDate(d).replace(/ \d{4}$/, '')} stroke="#243040" />
              <YAxis tick={{ fontSize: 10, fill: '#5F6E82' }} width={40} stroke="#243040"
                tickFormatter={(v) => `${v}`} />
              <Tooltip contentStyle={{ background: '#1A2331', border: '1px solid #243040', borderRadius: 6, fontSize: 12 }}
                labelFormatter={(d) => fmtDate(d as string)} formatter={(v: number) => [`${Number(v).toFixed(1)}`, '']} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              {lines.map((ln) => (
                <Line key={ln.key} type="monotone" dataKey={ln.key} name={ln.label} stroke={ln.color}
                  strokeWidth={ln.key === 'subject' ? 2.4 : 1.5} dot={false} isAnimationActive={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <p className="text-[11px] text-text-faint mt-1">Rebased to 100 at the start of the window · price return (currency-neutral).</p>
        </div>
      ) : (
        <p className="text-[12px] text-text-faint">Not enough cached price history to chart this window yet — it fills in shortly.</p>
      )}

      {/* Competitor table */}
      <div>
        <div className="eyebrow mb-2">Competitors · same sector, ranked by size</div>
        {data.competitors.length === 0 ? (
          <p className="text-sm text-text-faint">No peers with cached data yet. Open a few same-sector names in Research/Discover to build the peer set.</p>
        ) : (
          <div className="border border-hairline rounded overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="th">Company</th>
                    <th className="th text-right">Mkt cap (CHF)</th>
                    <th className="th text-right">P/E</th>
                    <th className="th text-right">Net margin</th>
                    <th className="th text-right">{range} return</th>
                    <th className="th text-right">vs this stock</th>
                  </tr>
                </thead>
                <tbody>
                  {data.competitors.map((c) => (
                    <tr key={c.symbol} className={c.isSubject ? 'bg-surface-2' : ''}>
                      <td className="td">
                        <span className="font-mono text-text">{c.symbol}</span>
                        {c.isSubject && <span className="ml-2 text-[10px] uppercase text-azure">this</span>}
                        {c.name && <span className="ml-2 text-text-faint truncate">{c.name}</span>}
                      </td>
                      <td className="td text-right font-mono tnum">{c.marketCapCHF != null ? fmtMoney(c.marketCapCHF, 'CHF', false) : '—'}</td>
                      <td className="td text-right font-mono tnum">{c.trailingPE != null ? c.trailingPE.toFixed(1) : '—'}</td>
                      <td className="td text-right font-mono tnum">{fmtPct(c.profitMargins, 1)}</td>
                      <td className={`td text-right font-mono tnum ${c.returns[range] != null && c.returns[range]! < 0 ? 'text-loss' : 'text-gain'}`}>{fmtPctSigned(c.returns[range] ?? null)}</td>
                      <td className={`td text-right font-mono tnum ${c.relativeToSubjectPct != null && c.relativeToSubjectPct < 0 ? 'text-loss' : 'text-gain'}`}>{c.isSubject ? '—' : fmtPctSigned(c.relativeToSubjectPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <p className="text-[11px] text-text-faint mt-1">Peers are same-sector names with cached data; market caps converted to CHF (omitted when no FX rate).</p>
      </div>

      {/* Opportunity-cost / valuation tie-in */}
      {data.valuation && data.valuation.band && (
        <div className="card !p-4">
          <div className="eyebrow mb-1">Opportunity cost · valuation</div>
          <p className="text-sm text-text-muted">
            Valuation reads <span className="text-text">{data.valuation.band.band.replace(/-/g, ' ')}</span>
            {data.valuation.marginOfSafety != null && (
              <> · margin of safety <span className={data.valuation.marginOfSafety < 0 ? 'text-loss' : 'text-gain'}>{fmtPctSigned(data.valuation.marginOfSafety)}</span></>
            )}. Read this together with the relative performance above: a name that is both expensive and lagging its market carries a higher opportunity cost than one that is merely lagging a strong sector.
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify the frontend builds**

Run: `npm run build`
Expected: `tsc --noEmit` clean and `vite build` succeeds. (If `EmptyState`'s prop names differ, adjust to its actual signature in `components/ui.tsx` — it exists there.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/MarketAnalysis.tsx
git commit -m "feat(market-analysis): MarketAnalysis component + api client

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

### Task C6: Wire MarketAnalysis into the three surfaces

**Files:**
- Modify: `frontend/src/views/PositionDetail.tsx` (add SectionNav entry + section)
- Modify: `frontend/src/views/Research.tsx` (replace `CompetitorsPanel` with `MarketAnalysis`)
- Modify: `frontend/src/modals/OpportunityModal.tsx` (add a section)

**Interfaces:**
- Consumes: `MarketAnalysis` (Task C5).

- [ ] **Step 1: PositionDetail — import, nav entry, section**

In `frontend/src/views/PositionDetail.tsx`:
1. Add import near the other component imports: `import { MarketAnalysis } from '../components/MarketAnalysis';` and add `Radar` to the existing `lucide-react` import list.
2. In the `navSections` array (the `...(!delisted && isStock ? [{ id: 'sec-value', ... }] : [])` region ~line 180), add after the value entry:
```typescript
    ...(!delisted && isStock ? [{ id: 'sec-market', label: 'Market analysis', icon: Radar }] : []),
```
3. Add a matching section. Immediately after the closing `</section>` of the existing `sec-value` block (the Value analysis card ~line 551), insert:
```jsx
        {!delisted && inst.kind === 'stock' && (
          <section id="sec-market" className="card mb-6 scroll-mt-24">
            <div className="eyebrow mb-3">Market analysis · sector, competitors & relative performance</div>
            <MarketAnalysis symbol={inst.symbol} />
          </section>
        )}
```

- [ ] **Step 2: Research — replace CompetitorsPanel usage and remove the now-dead component**

In `frontend/src/views/Research.tsx`:
1. Add import: `import { MarketAnalysis } from '../components/MarketAnalysis';`
2. Replace the render at line 404 `<CompetitorsPanel symbol={data.symbol} />` with:
```jsx
          <MarketAnalysis symbol={data.symbol} />
```
3. Delete the entire now-unused `CompetitorsPanel` function definition (starts `function CompetitorsPanel({ symbol }: { symbol: string }) {` ~line 238 through its closing `}`), and remove any imports that become unused as a result (e.g. if `api.competitors`/`CompetitorsResult`/`CompetitorPeer` were only used there — check and remove only genuinely-unused imports so `tsc` stays clean). If disentangling imports proves noisy, it is acceptable to leave the `CompetitorsPanel` function in place unused (the build does not enable `noUnusedLocals`), but prefer removing dead code.

- [ ] **Step 3: OpportunityModal — add a section**

In `frontend/src/modals/OpportunityModal.tsx`, add `import { MarketAnalysis } from '../components/MarketAnalysis';`, then add a new bordered section in the modal body after the `PortfolioFit` block (mirroring the existing `mt-6 pt-5 border-t border-hairline` dividers):
```jsx
          <div className="mt-6 pt-5 border-t border-hairline">
            <div className="eyebrow mb-3">Market analysis</div>
            <MarketAnalysis symbol={symbol} />
          </div>
```

- [ ] **Step 4: Verify the frontend builds**

Run: `npm run build`
Expected: `tsc --noEmit` clean (no unused imports/locals errors) and `vite build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/views/PositionDetail.tsx frontend/src/views/Research.tsx frontend/src/modals/OpportunityModal.tsx
git commit -m "feat(market-analysis): surface MarketAnalysis in PositionDetail, Research & OpportunityModal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

## Owner verification (hand-tested running app)

After a **backend restart**: open a held stock (Decisions → e.g. UnitedHealth) → new "Market analysis" section shows sector/industry, a market-vs-company headline, a rebased multi-line chart (stock vs S&P 500 / All-World / sector ETF), a competitor table with per-name returns and market caps in CHF, and an opportunity-cost/valuation line. The same section appears in Research (replacing the old competitors-only panel) and in the opportunity modal. Sector ETFs/broad benchmarks may show "unavailable"/thin on first open and fill in on later polls (background warm).

## Self-review notes

- **Spec coverage (§3–10, §19, §24 Market Analysis):** dedicated section (C5/C6); sector+industry (C4 bundle); competitors with performance (C2/C4); sector + broad-benchmark comparison (C1/C4); market-vs-company distinction (C3 classifier, headline card in C5); charts (C5); horizons 1M–5Y (C2 WINDOWS + C5 selector); opportunity-cost tie-in via existing valuation (C4/C5); never fabricates (unavailable states throughout); never forces Sell (classifier is descriptive).
- **Reuse / no fork:** `competitors()`, `value_analysis`, `fx`, cached `price_cache` reads; only additive new module + one route.
- **Rate-limit safety:** competitor loop is cached-only; only ≤4 symbols warmed in background.
- **Type consistency:** bundle keys ↔ `MarketAnalysisResult` fields; classification union matches the backend string set; `WINDOWS` keys (`1M/3M/6M/1Y/3Y/5Y`) match the frontend `RANGES`.

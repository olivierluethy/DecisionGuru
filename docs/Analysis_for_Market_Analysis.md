# Market Analysis — Current Implementation Analysis

> **Scope.** This is a strictly *as-is* investigation of the Market Analysis feature in
> this repository. No behaviour was changed. Every claim is tagged **[Confirmed by Code]**,
> **[Inferred]**, or **[Unknown]**. File/line references point at the code as it exists on
> branch `feat/value-investing-engine-2`.

---

## 1. Executive Summary

Market Analysis is a **single, shared implementation** reached from three places in the UI.
All three render the same React component, which calls one API endpoint, which calls one
backend service. There is no second code path.

The most important finding: **comparable companies ("competitors") are selected by exact
equality on a single field — the provider's broad `sector` string** (e.g. `"Consumer
Cyclical"`, `"Technology"`). The finer `industry` field *is* fetched and *is* displayed in
the UI, but it is **never used to filter** the peer set. Consequently, when Toyota is
selected, every other cached name whose yfinance `sector` is `"Consumer Cyclical"` —
Starbucks, McDonald's, Nike, Home Depot, Disney, Tesla, Swatch, Amazon, plus the actual car
makers BMW/VW/Mercedes — is treated as a peer. The unrelated companies are not a bug in a
similarity algorithm; **there is no similarity algorithm.** The peer set is "same broad
sector ∩ has cached fundamentals," ranked by market cap.

- **Selection field:** `sector` only (equality). **[Confirmed by Code]**
- **Definition of "market":** the yfinance broad `sector` label. **[Confirmed by Code]**
- **Ranking:** market cap, largest first; unknown caps sink to the bottom. **[Confirmed by Code]**
- **Peer universe:** a hard-coded seed list ∪ your holdings ∪ your watchlist, restricted to
  names that already have cached fundamentals. **[Confirmed by Code]**
- **Market cap:** retrieved, FX-converted to CHF, displayed, and already used for ranking. **[Confirmed by Code]**

---

## 2. Market Analysis Entry Points

All three entry points import and render the **same** component
(`frontend/src/components/MarketAnalysis.tsx`) with a single `symbol` prop. **[Confirmed by Code]**

| # | Location | File / line | Rendered as |
|---|----------|-------------|-------------|
| 1 | **Research** → open a stock → "Market analysis" card | `frontend/src/views/Research.tsx:339` | `<MarketAnalysis symbol={data.symbol} />` |
| 2 | **Portfolio / Position Detail** → open a position → "Market analysis · sector, competitors & relative performance" section | `frontend/src/views/PositionDetail.tsx:560` | `<MarketAnalysis symbol={inst.symbol} />` |
| 3 | **Opportunity Modal** (buy-candidate deep-dive) | `frontend/src/modals/OpportunityModal.tsx:63` | `<MarketAnalysis symbol={symbol} />` |

Gating conditions **[Confirmed by Code]**:

- Research renders it only for `data.kind === 'stock'` (`Research.tsx:336`).
- PositionDetail renders it only when `!delisted && inst.kind === 'stock'` (`PositionDetail.tsx:557`).
- OpportunityModal renders it unconditionally within the modal body.

**They share everything below the prop:** same component, same API method, same endpoint,
same backend service, same calculation logic. **[Confirmed by Code]**

---

## 3. Current Architecture

```
UI (3 entry points)
  └─ <MarketAnalysis symbol=… />           frontend/src/components/MarketAnalysis.tsx
       └─ api.marketAnalysis(symbol, range) frontend/src/lib/api.ts:250
            └─ GET /research/market/{symbol}?range=…  backend/app/routers/research.py:148
                 └─ market_analysis(symbol, range, settings)  backend/app/services/market_analysis.py:142
                      ├─ competitors(symbol)               backend/app/services/competitors.py:33   ← PEER SELECTION
                      ├─ get_cached_fundamentals(symbol)   backend/app/services/fundamentals.py:29
                      ├─ sector_etf_for(sector)            backend/app/reference/sector_etfs.py:33
                      ├─ returns_for / single_return / rebased_series (cached price reads)
                      ├─ value_analysis(...)               backend/app/services/valuation.py
                      └─ get_fx_rate(...)                  backend/app/services/fx.py
```

**[Confirmed by Code]** — Router: `research.py:148-155`:

```python
@router.get("/market/{symbol:path}")
async def market(symbol: str, range: str = "1Y") -> dict:
    from ..services.market_analysis import market_analysis
    return await run_in_threadpool(market_analysis, symbol, range, settings)
```

Data provider is **yfinance**, wrapped in `backend/app/providers/yfinance_provider.py`.
Persistence is a local database with two tables that matter here: `fundamentals_cache`
(JSON snapshot per symbol) and `price_cache` (daily closes). **[Confirmed by Code]**

---

## 4. Complete Data Flow

`market_analysis(symbol, range_key="1Y", settings)` in
`backend/app/services/market_analysis.py:142` does, in order **[Confirmed by Code]**:

1. `months = _KEY_BY_RANGE.get(range_key, 12)` — maps `1M/3M/6M/1Y/3Y/5Y` → months; unknown
   ranges fall back to `1Y` (`market_analysis.py:143-144`).
2. `comp = competitors(symbol)` → `sector`, `industry`, and the `peers` list (see §5/§8).
3. `snap = get_cached_fundamentals(symbol)["snapshot"]` → `name`, `native_ccy`
   (`market_analysis.py:149-151`).
4. `sector_etf = sector_etf_for(sector)` — maps the sector string to a SPDR ETF (§6).
5. `_warm_background([symbol, *broad benchmarks, sector_etf])` — best-effort, bounded
   background history fetch for **only** the subject + `SPY` + `VWRL.SW` + the sector ETF.
   **It never fetches the competitor loop** (`market_analysis.py:154-156`, `131-139`).
6. For the subject and **each peer**, compute a cached-only per-window return map
   `returns_by_symbol` (`market_analysis.py:160-163`).
7. Build `competitors_out`: for each peer, attach FX-converted market cap, valuation
   multiples, the window returns, and `relativeToSubjectPct` (peer return − subject return)
   (`market_analysis.py:172-184`).
8. `peer_med = peer_median(...)` — median of peers' returns for the selected window
   (`market_analysis.py:186-187`).
9. Sector line: real ETF return if its history is cached; else peer median; else
   "unavailable" (`market_analysis.py:189-200`).
10. Broad benchmarks: `SPY` and `VWRL.SW` returns + rebased series (`market_analysis.py:202-205`).
11. `classification = classify(subject, sector_pct, peer_med, broad_pct)` — a descriptive
    market-vs-company label, never a recommendation (`market_analysis.py:105-125`, `207-209`).
12. `valuation` — pulls the existing valuation band / margin-of-safety at the cached price
    (`market_analysis.py:211-219`).
13. Returns the assembled dict (`market_analysis.py:221-232`), typed on the frontend as
    `MarketAnalysisResult` (`frontend/src/lib/api.ts:921-931`).

**Key property:** all price reads are **cached-only** (direct `price_cache` SELECTs in
`cached_closes`, `market_analysis.py:26-32`). A competitor loop can therefore never hit the
rate-limited provider. Returns are **price-return %** (currency-neutral), so cross-currency
peers are comparable on return without FX. **[Confirmed by Code]**

---

## 5. How Comparable Companies Are Currently Selected

The entire selection lives in `backend/app/services/competitors.py:33-63`. **[Confirmed by Code]**

```python
def competitors(symbol: str) -> dict:
    subject = get_cached_fundamentals(symbol)
    subj_snap = (subject or {}).get("snapshot")
    sector = (subj_snap or {}).get("sector")
    if not subj_snap or not sector:
        return {..., "peers": [], "peerCount": 0, "subjectRank": None}   # ← fallback: empty

    holdings = [i["symbol"] for i in repo.list_instruments() if i.get("symbol")]
    watch    = [w["symbol"] for w in list_watchlist() if w.get("symbol")]
    pool = list(dict.fromkeys([symbol, *UNIVERSE_SEED, *holdings, *watch]))

    peers = []
    for sym in pool:
        data = get_cached_fundamentals(sym)
        snap = (data or {}).get("snapshot")
        if not snap or (snap.get("sector") or "") != sector:   # ← THE ONLY FILTER
            continue
        peers.append(_peer(sym, snap, sym == symbol))

    peers.sort(key=lambda p: (p["marketCap"] is not None, p["marketCap"] or 0), reverse=True)
    ...
```

Step by step:

1. **Candidate pool** = deduplicated `[subject] ∪ UNIVERSE_SEED ∪ holdings ∪ watchlist`.
   `UNIVERSE_SEED` is a hard-coded list of ~130 tickers in
   `backend/app/reference/universe.py` (Swiss/US/Europe/Asia large caps + ETFs). **[Confirmed by Code]**
2. **Filter** = keep a candidate **iff** it has a cached fundamentals snapshot **and**
   `snap.get("sector") == subject.sector` (exact string equality). This is the *only*
   comparability test. **[Confirmed by Code]**
3. **Rank** = market cap descending; candidates with unknown market cap sort last. **[Confirmed by Code]**

So a company appears as a peer of the subject **exactly when**: it is in the seed/holdings/
watchlist pool, its fundamentals are already cached, and its yfinance `sector` string is
character-for-character equal to the subject's. Nothing else is consulted. **[Confirmed by Code]**

**Answers to the specific questions in the brief** (all **[Confirmed by Code]** unless noted):

- Predefined list? Yes — `UNIVERSE_SEED` (the candidate pool), but membership as a *peer*
  still requires the sector match. `UNIVERSE_SEED` is not itself the displayed set.
- Sector filter? **Yes — the only filter.**
- Industry filter? **No.** `industry` is fetched and displayed, never filtered on.
- Market/category/geography/exchange/size filter? **No.**
- Similarity algorithm / scoring / ranking by relevance? **No.** Ranking is by market cap only.
- SIC / NAICS / GICS / business description / tags? **None used.** Only the yfinance
  `sector` string (a GICS-*like* label, but consumed verbatim as a string). **[Inferred]** that
  yfinance derives it from a GICS-style taxonomy; the code treats it purely as an opaque string.
- Market cap in *selection*? **No** — only in *ranking*. A peer with unknown cap is still a peer.
- Hard-coded inclusions/exclusions? The candidate pool is hard-coded (`UNIVERSE_SEED`); there
  are **no** hard-coded per-company include/exclude rules in the comparison itself.
- Fallback logic? If the subject has no cached snapshot or no sector, `competitors` returns an
  **empty** peer list (`competitors.py:37-38`). If a sector has no ETF mapping, the sector line
  falls back to the peer median, then to "unavailable" (`market_analysis.py:189-200`).
- Too few comparables? The competitor table renders an empty-state message ("No peers with
  cached data yet…", `MarketAnalysis.tsx:120`); the peer-median line and the classification
  degrade to `null`/"unavailable" rather than erroring. **[Confirmed by Code]**

---

## 6. Current Definition of "Market"

**The implementation's operative definition of "market" is: the yfinance `sector` string of
the subject company.** **[Confirmed by Code]**

Evidence:

- Peer comparability is `snap.get("sector") == sector` (`competitors.py:48`).
- The "sector benchmark" is a SPDR **sector** ETF chosen by that same sector string
  (`sector_etfs.py:10-27`, `sector_etf_for` at `:33`).
- The classification headline compares the subject to its **sector** reference
  (`market_analysis.py:105-125`).

There is **no** concept in code of a *competitive market*, product market, revenue market, or
sub-industry as a selection unit. "Industry" exists as data (`snap.get("industry")`) and is
surfaced in the header (`MarketAnalysis.tsx:64`) and per-peer payload, but it drives **no**
logic. The stock exchange, domicile/geography, and company size are **not** part of the
market definition. **[Confirmed by Code]**

`SECTOR_ETF` recognises ~15 sector strings (with a few provider aliases like
`"Financial Services"`/`"Financials"`). The two broad benchmarks are `SPY` (S&P 500) and
`VWRL.SW` (FTSE All-World, CHF-listed) — `sector_etfs.py:30`. **[Confirmed by Code]**

---

## 7. Company Classification System

**Fields and origin** **[Confirmed by Code]**:

- The classification fields are `sector` and `industry`. They originate **directly from
  yfinance `info`** — `yfinance_provider.py:229-230`:
  ```python
  "sector":   info.get("sector"),
  "industry": info.get("industry"),
  ```
  (also mirrored into the fund/ETF snapshot at `:178-179`).
- They are stored verbatim inside the JSON `snapshot` in the `fundamentals_cache` table
  (`fundamentals.py:37-55`), read back by `get_cached_fundamentals` (`fundamentals.py:29`).
- **No normalization** is applied to `sector`/`industry` — the raw provider string is stored
  and compared as-is. (The only aliasing anywhere is the *ETF lookup table* in
  `sector_etfs.py`, which maps a handful of alternative sector spellings to the same ETF; it
  does **not** normalize what is stored or what is compared in `competitors.py`.) **[Confirmed by Code]**

**Consequences / consistency** **[Inferred, grounded in code]**:

- Because comparison is exact string equality on an un-normalized field, **any** provider
  inconsistency across listings (e.g. `"Financial Services"` vs `"Financials"`,
  `"Technology"` vs `"Information Technology"`) would split otherwise-identical companies into
  different "markets." The ETF alias table hints the provider does emit such variants.
- yfinance sectors are **broad** (roughly GICS sectors). A single sector such as
  `"Consumer Cyclical"` spans autos, apparel, restaurants, luxury goods, home improvement,
  travel, and e-commerce. The code treats all of these as one market.
- Classifications can be **missing**: if `info` lacks a sector, the subject yields an empty
  peer set, and a candidate lacking a sector is skipped. **[Confirmed by Code]**
- **The app treats `sector` and `market` as equivalent, and ignores `industry`/`sub-industry`
  for selection.** **[Confirmed by Code]**

**[Unknown]**: whether yfinance's `sector` is stable over time for a given symbol, and how
often it disagrees between a company's home listing and its ADR/foreign listing. Not
determinable from code alone.

---

## 8. Comparison / Competitor Selection Logic

Reconstructed pipeline (matches the brief's template) **[Confirmed by Code]**:

```
Selected symbol
      ↓  get_cached_fundamentals(symbol).snapshot.sector      (competitors.py:34-36)
Subject sector string  (e.g. "Consumer Cyclical")
      ↓  pool = subject ∪ UNIVERSE_SEED ∪ holdings ∪ watchlist (competitors.py:40-42)
Candidate symbols (~130+)
      ↓  keep if cached snapshot AND snap.sector == subject.sector   (competitors.py:45-50)
Peers (same broad sector, cached)
      ↓  sort by marketCap desc, unknowns last                (competitors.py:53)
Ranked peers
      ↓  per-peer cached returns + FX'd market cap + multiples (market_analysis.py:172-184)
Displayed competitor table                                    (MarketAnalysis.tsx:116-156)
```

| Step | File · function | Input | Output | Condition/filter | Sort | Limit | Fallback |
|------|-----------------|-------|--------|------------------|------|-------|----------|
| Subject sector | `competitors.py:34-36` | symbol | sector string | needs cached snapshot | – | – | empty peers if none |
| Build pool | `competitors.py:40-42` | seed+holdings+watch | dedup symbol list | – | insertion order | none | – |
| Filter peers | `competitors.py:45-50` | pool | peer dicts | cached ∧ `sector==` | – | **none** | skip candidate |
| Rank | `competitors.py:53` | peers | ordered peers | – | marketCap desc | none | unknown cap → last |
| Enrich | `market_analysis.py:172-184` | peers | competitor rows | – | preserves rank | none | `None` fields |

**There is no cap on how many peers are returned** — the whole matching set is emitted
(`competitors.py` has no slice/limit; `MarketAnalysis.tsx` renders all rows). **[Confirmed by Code]**

`peerCount` is `len(peers) - 1` and `subjectRank` is the subject's 1-based index in the
market-cap ranking (`competitors.py:54, 61`). **[Confirmed by Code]**

---

## 9. Ranking and Sorting Logic

- **Competitor table order:** market capitalization, largest first; unknown caps sink to the
  bottom (`competitors.py:53`). This ordering is preserved through `market_analysis.py` into
  the payload and rendered in that order. **[Confirmed by Code]**
- **No relevance/similarity score exists.** Ranking is *independent of competitive relevance*
  — a giant unrelated same-sector company outranks a small direct rival. **[Confirmed by Code]**
- The UI column header literally reads "Competitors · same sector, ranked by size"
  (`MarketAnalysis.tsx:118`) and the footnote says peers are "same-sector names with cached
  data" (`:155`). **[Confirmed by Code]**
- Not alphabetical, not by return, not by revenue. The `relativeToSubjectPct` column exists
  but is a *display* value, not a sort key (`market_analysis.py:182-183`). **[Confirmed by Code]**

---

## 10. Market Capitalization Handling

**[Confirmed by Code]**:

1. **Source:** yfinance `info["marketCap"]`, captured into the snapshot at
   `yfinance_provider.py:233` (`"marketCap": num("marketCap")`).
2. **Field:** `snapshot.marketCap`, surfaced by `_peer` (`competitors.py:26`) as `marketCap`
   in the peer's native currency.
3. **Current vs historical:** it is whatever yfinance returned at fetch time and was cached —
   effectively a **point-in-time current** cap, as fresh as the fundamentals cache entry. Not
   a historical time series. **[Inferred]** (freshness depends on `cache_ttl_fundamentals`).
4. **Currency normalization:** yes — converted to **CHF** in `market_analysis._fx`
   (`market_analysis.py:166-170, 178`) using `get_fx_rate(native_ccy → CHF, strict=True)`;
   returns `None` when no FX rate is available. Peers keep their own native currency for the
   conversion input (`p.get("currency")`).
5. **Cross-exchange/currency inconsistency:** because each peer's cap is converted from its
   own listing currency, cross-currency peers are made comparable in CHF. If a rate is
   missing, that peer's CHF cap is `None` (shown as "—"). The **ranking**, however, sorts on
   the *native* `marketCap` number (`competitors.py:53`), **not** the CHF value — so ranking
   mixes currencies while display is CHF-normalized. **[Confirmed by Code]** (a latent
   inconsistency, noted, not fixed.)
6. **Available in Market Analysis data:** yes — `marketCapCHF` per competitor
   (`api.ts:917`, payload at `market_analysis.py:178`).
7. **Usable for sorting:** already used (native cap) for the competitor ranking.
8. **Displayed in UI:** yes — the "Mkt cap (CHF)" column (`MarketAnalysis.tsx:130, 143`).

The brief's "future requirement" (show and rank by market cap) is therefore **already
partially met**: market cap is retrieved, FX-converted, displayed, and used to rank. The
only latent gap is that ranking sorts on the native-currency number rather than the CHF
number. **Nothing changed here.** **[Confirmed by Code]**

---

## 11. Market Analysis UI

Component: `frontend/src/components/MarketAnalysis.tsx`. **[Confirmed by Code]** It renders:

1. **Company context row** — name, sector, industry (`:60-65`).
2. **Range selector** — chips for `1M/3M/6M/1Y/3Y/5Y` (`:68-73`); default `1Y` (`:28`).
3. **Market-vs-company headline card** — the `classification` label + blurb, plus this-stock
   / sector / peer-median / benchmark returns (`:76-89`).
4. **Rebased performance line chart** (Recharts) — subject + benchmarks + sector-ETF line,
   rebased to 100, currency-neutral (`:91-114`).
5. **Competitor table** — columns: Company (symbol + name, "this" badge for subject),
   Mkt cap (CHF), P/E, Net margin, `{range}` return, vs this stock (`:116-156`). All matching
   peers shown (no pagination).
6. **Opportunity-cost / valuation card** — valuation band + margin of safety (`:158-169`).

- **Company representation:** one table row per peer; subject row is highlighted
  (`bg-surface-2`) and tagged "this" (`:137-141`). **[Confirmed by Code]**
- **Ranking concept in UI:** implicit — rows are pre-sorted by size server-side; header states
  "ranked by size." No client-side re-sort. **[Confirmed by Code]**
- **Could market cap be added without model changes?** It is **already present**. **[Confirmed by Code]**

---

## 12. Why Unrelated Companies Can Currently Appear

**Root mechanism:** peer inclusion is `subject.sector == candidate.sector` on the **broad**
yfinance sector string, with **no industry/sub-industry constraint**. yfinance sectors are
coarse; a single sector holds many unrelated businesses. Therefore any cached same-sector
name is displayed as a "competitor" regardless of what it actually sells. **[Confirmed by Code]**

For each company "type" that can appear alongside a subject:

> **Company X appears because** it is present in `UNIVERSE_SEED` (or your holdings/watchlist),
> its fundamentals are cached, and its `snapshot.sector` string equals the subject's — the
> only condition checked (`competitors.py:48`). **Its industry, products, and geography are
> never examined.** **[Confirmed by Code]**

Secondary contributing factors **[Confirmed by Code]**:

- **No relevance ranking** — size, not competitive closeness, orders the list, so the biggest
  same-sector names dominate the top even if unrelated.
- **Un-normalized sector strings** — provider variants can *also* wrongly *exclude* true peers
  (the inverse failure).
- **Pool is a broad global seed** — `UNIVERSE_SEED` deliberately spans regions/sectors, so many
  candidates are available to match a broad sector.

---

## 13. Concrete Example: Toyota Motor Corporation

Toyota is in the seed as `7203.T` (`universe.py`, `_ASIA`). Walking the actual code:

```
7203.T (Toyota)
   ↓  get_cached_fundamentals("7203.T").snapshot.sector
sector = "Consumer Cyclical"          ← yfinance info["sector"]  [Inferred value; Confirmed mechanism]
   ↓  pool = 7203.T ∪ UNIVERSE_SEED ∪ holdings ∪ watchlist
candidates include (all Consumer Cyclical in yfinance):
   BMW.DE, VOW3.DE, MBG.DE   (Auto Manufacturers)      ← genuine rivals
   SBUX, MCD                 (Restaurants)
   NKE                       (Footwear & Accessories)
   HD                        (Home Improvement Retail)
   DIS                       (Entertainment)
   AMZN, BABA                (Internet/Specialty Retail)
   TSLA                      (Auto Manufacturers)       ← genuine rival
   UHR.SW / CFR.SW           (Luxury Goods)             ← Swatch / Richemont
   ↓  keep those with cached fundamentals AND sector == "Consumer Cyclical"
   ↓  sort by market cap desc
Displayed competitors: the whole broad-sector set, size-ordered
```

**Why the "wrong" companies show up** **[Confirmed by Code for the mechanism]**:

- **Starbucks / McDonald's** appear because their yfinance sector is `"Consumer Cyclical"`
  (industry "Restaurants") — equal to Toyota's sector. The industry mismatch is never checked.
- **Nike** appears for the same reason (industry "Footwear & Accessories").
- **Swatch Group (UHR.SW)** appears because Swatch's sector is `"Consumer Cyclical"` (industry
  "Luxury Goods"). *(Note: Swatch is in the Swiss seed and commonly cached, making it a likely
  visible peer.)*
- **BMW / Volkswagen / Mercedes** appear for the *correct* reason — same sector *and* same
  industry ("Auto Manufacturers") — but the code got them the same way it got the others:
  purely via the sector match.

The precise sector/industry strings above are **[Inferred]** from yfinance's known taxonomy;
what is **[Confirmed by Code]** is that whatever `info["sector"]` yfinance returns is the sole
determinant, and that industry is ignored. If any listed name is *not* currently cached, it
simply won't appear (a data-availability effect, not a logic effect).

---

## 14. Root Cause Analysis

Ranked by impact **[Confirmed by Code]** unless noted:

1. **Selection uses the broad `sector` only; `industry`/`sub-industry` is ignored.** This is
   the primary cause of unrelated peers (`competitors.py:48`). A finer field is available but
   unused.
2. **"Market" is defined as a broad economic sector, not a competitive market.** No concept of
   product/competitive market exists in code (§6).
3. **Ranking is by size, independent of competitive relevance** (`competitors.py:53`) — even a
   correct-industry peer can be buried below unrelated giants.
4. **No normalization of the sector string** — exact-equality matching is brittle to provider
   label variants, causing both false peers (broadness) and potential missed peers (variants).
5. **Data-availability coupling** — the visible peer set is whatever happens to be cached, so
   results vary by browsing history, independent of the "right" answer.

None of these is a join bug, an API-parameter bug, or a hard-coded bad list. The behaviour is
the *designed* behaviour of a deliberately offline, rate-limit-safe heuristic; it is simply
too coarse for "who actually competes." **[Inferred]** — design intent from the module
docstrings (`competitors.py:1-8`, `market_analysis.py:1-5`).

---

## 15. Current Limitations

**[Confirmed by Code]**:

- Peers limited to the broad sector; unrelated businesses included, some true rivals excluded
  if in a different (variant) sector string or uncached.
- Peer set depends on the cache state (holdings/watchlist/previously-opened names).
- No pagination/cap — a very populous sector could render a long table.
- Sector ETF benchmark only covers the ~15 mapped sector strings; unmapped sectors fall back
  to peer median (`market_analysis.py:189-200`).
- Ranking sorts on **native-currency** market cap while displaying **CHF** — mixed-currency
  ordering (`competitors.py:53` vs `market_analysis.py:178`).
- Sector benchmark is a **US** SPDR ETF even for non-US subjects (`sector_etfs.py`), so the
  "sector line" is a US-sector proxy. **[Inferred]** implication.

---

## 16. Relevant Files and Code References

| Concern | File · lines |
|--------|--------------|
| **Peer selection (the crux)** | `backend/app/services/competitors.py:33-63` |
| Market-analysis assembly | `backend/app/services/market_analysis.py:142-232` |
| Cached returns / rebasing | `backend/app/services/market_analysis.py:26-91` |
| Classification (market-vs-company) | `backend/app/services/market_analysis.py:105-125` |
| Sector→ETF mapping + broad benchmarks | `backend/app/reference/sector_etfs.py` |
| Candidate universe seed | `backend/app/reference/universe.py` |
| Sector/industry/marketCap origin (yfinance) | `backend/app/providers/yfinance_provider.py:178-179, 226-233` |
| Fundamentals cache read | `backend/app/services/fundamentals.py:29-55` |
| API route | `backend/app/routers/research.py:148-155` |
| API client + result type | `frontend/src/lib/api.ts:250-251, 910-931` |
| UI component | `frontend/src/components/MarketAnalysis.tsx` |
| Entry: Research | `frontend/src/views/Research.tsx:339` |
| Entry: Position Detail | `frontend/src/views/PositionDetail.tsx:560` |
| Entry: Opportunity Modal | `frontend/src/modals/OpportunityModal.tsx:63` |
| Tests | `backend/tests/test_market_analysis_bundle.py`, `test_market_classifier.py`, `test_market_returns.py`, `test_sector_etfs.py` |

---

## 17. Open Questions / Unknowns

- **[Unknown]** The exact `sector`/`industry` strings yfinance returns for each specific
  symbol (e.g. is Toyota's sector `"Consumer Cyclical"` on `7203.T` and on the `TM` ADR?).
  The *mechanism* is confirmed; the *literal values* are inferred from yfinance's taxonomy and
  would need a live/cached DB read to confirm per symbol.
- **[Unknown]** How consistently the provider labels the same company across listings — the
  practical rate of false splits from un-normalized equality.
- **[Unknown]** How stale a given peer's cached market cap/fundamentals is at view time
  (depends on `cache_ttl_fundamentals` and last fetch).
- **[Unknown]** Whether any subject in practice hits the empty-peer fallback because its sector
  is missing from the provider.

To resolve these, query the local `fundamentals_cache` for the relevant symbols and inspect
the stored `snapshot.sector`/`industry`/`marketCap`. (Not done — read-only analysis, and it
requires the running DB.)

---

## 18. What Must Be Understood Before Making Changes

- Peer selection is **one field, one equality** (`competitors.py:48`). Any redesign that wants
  "true competitors" must introduce a finer signal (industry/sub-industry, business
  description, or a curated peer map) — the data (`industry`) is *already fetched*.
- The system is intentionally **cached-only and rate-limit-safe**. Any new selection logic
  must not trigger per-peer provider fetches (the current loop deliberately never does —
  `market_analysis.py:154-156`).
- `competitors()` is **shared** — it also backs a competitors endpoint (`research.py:143`) and
  ranking (`subjectRank`). Changing its filter changes every consumer.
- Market cap is **already** retrieved, CHF-converted, displayed, and used for ranking; the only
  latent fix is native-vs-CHF sort consistency. A "add market cap" task is largely already done.
- Sector strings are **un-normalized**; any equality-based approach needs a normalization/alias
  layer (the ETF table at `sector_etfs.py:10-27` is a partial precedent, but for ETF lookup
  only).

---

## Key Findings

### Current Selection Mechanism
Peers = candidates from `UNIVERSE_SEED ∪ holdings ∪ watchlist` that (a) have cached
fundamentals and (b) whose yfinance `sector` string exactly equals the subject's. This single
equality (`competitors.py:48`) is the entire comparability test. **[Confirmed by Code]**

### Current Definition of Market
"Market" = the subject's broad yfinance `sector` label (e.g. `"Consumer Cyclical"`). No
competitive/product/sub-industry concept exists; `industry` is displayed but never filtered.
**[Confirmed by Code]**

### Why Unrelated Companies Appear
Broad sectors bundle unrelated businesses, and only the sector is matched. Toyota, Starbucks,
McDonald's, Nike, Swatch, Home Depot, Disney, Amazon, and Tesla all carry sector
`"Consumer Cyclical"`, so all become "competitors" of one another. Size-based ranking (not
relevance) then floats the biggest unrelated names to the top. **[Confirmed mechanism;
specific sector values Inferred]**

### Current Ranking Mechanism
Market capitalization, largest first, unknown caps last (`competitors.py:53`). No
similarity/relevance score. Ranking sorts on native-currency cap while the UI shows CHF.
**[Confirmed by Code]**

### Current Market Cap Handling
Retrieved from yfinance `info["marketCap"]`, cached, FX-converted to CHF
(`market_analysis.py:166-178`), displayed ("Mkt cap (CHF)" column), and used to rank. Already
present end-to-end. **[Confirmed by Code]**

### Most Relevant Code Locations
`backend/app/services/competitors.py:33-63` (selection) · `market_analysis.py:142-232`
(assembly) · `reference/sector_etfs.py` + `reference/universe.py` (references) ·
`providers/yfinance_provider.py:226-233` (sector/industry/cap origin) ·
`components/MarketAnalysis.tsx` (UI). **[Confirmed by Code]**

### Main Technical Problems Identified
1. Selection on broad `sector` only; `industry` ignored. 2. "Market" ≡ broad sector, not a
competitive market. 3. Ranking by size, not relevance. 4. Un-normalized sector-string
equality. 5. Peer set coupled to cache state. **[Confirmed by Code / Inferred as noted]**

### Changes That Should NOT Be Made Yet
Per the task, no functional changes were made and none should be until the conceptual model is
agreed: do not change the selection filter, ranking, sector definition, add per-peer fetches,
alter the market-cap pipeline, or touch the shared `competitors()` consumers. The only change
made in this task is the creation of this document. **[Confirmed]**

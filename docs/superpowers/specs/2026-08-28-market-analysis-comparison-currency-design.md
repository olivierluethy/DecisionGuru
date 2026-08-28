# Market Analysis, general comparison & display-currency consistency — design

Date: 2026-08-28
Status: draft (design) — awaiting owner review

## Context

DecisionGuru already ships most of the substrate this spec needs, so the work is
**extension, not new construction**:

- **Comparison** already exists twice: (A) the counterfactual **VS** (`POST
  /analysis/compare` → `CompareModal`, `services/counterfactual.py`) is genuinely
  N×N, in **CHF**, **total-return after Swiss tax**; (B) **universal compare** (`POST
  /research/compare` → `UniversalCompare` in Research, `services/universal.py`) accepts
  **arbitrary symbols** + portfolio and returns price-return / risk metrics. The only
  restriction is UI: `CompareModal` offers just the five hardcoded `DEFAULT_BENCHMARKS`
  (`reference/defaults.py:25`) as chips and never wires in `SymbolSearch`
  (`/instruments/search`), which already searches any security.
- **Competitors** already exist and are wired: `services/competitors.py` →
  `GET /research/competitors/{symbol}` → `CompetitorsPanel` (`views/Research.tsx:238`).
  It derives **same-sector** peers from **cached** fundamentals ranked by market cap,
  but carries **no price performance**, is sector-only, and only shows peers already in
  the fundamentals cache.
- **Sector/industry** is already fetched and cached per symbol in the fundamentals
  snapshot (`yfinance_provider.py:229-230`). There is **no sector/industry performance
  benchmark** anywhere in the codebase.
- **Valuation is already currency-consistent internally**: every field out of
  `value_analysis` (`services/valuation.py`) is in the stock's **native** currency, and
  Margin of Safety is a native/native ratio (mathematically correct). `fx.py` already
  provides `resolve_fx` / `get_fx_rate(strict=)` / `to_chf` that **never fabricate** a
  rate (they degrade to `unresolved`, not a silent 1.0).

Standing constraints apply: Tailwind only, **dark mode only**, **modals not page
redirects**, Conventional Commits (many small commits), **never fabricate financial
data** (mark unavailable as unavailable). Per the value-investing-engine decision,
**automated tests are required for the financial engine only** (`backend/tests/`,
pytest); UI stays hand-tested by the owner.

## The two concrete defects the owner called out

1. **Currency split in the valuation panel.** On the position-detail view the current
   price renders as **CHF 317.62** (`PositionDetail.tsx:220/335`, from
   `currentValueCHF / openQuantity`), while directly beneath it `ValueAnalysis` renders
   Fair Value / Graham / entry in the stock's **native** currency (USD) — because
   valuation fundamentals are never FX-converted and the panel formats every field with
   the native currency code. The owner wants **no currency distinction between the
   displayed price and the Fair Value**: convert the valuation figures to **CHF** so the
   discrepancy is legible CHF-to-CHF. (This supersedes an earlier "native primary"
   direction.)

2. **Competitors only reachable in Research.** The Competitive-Position/Competitors view
   exists only in Research. The owner wants the **same view on the position-detail page**
   (Decisions → a holding → e.g. UnitedHealth) so comparing competitors does not force a
   detour into Research.

Both are folded into the larger Market-Analysis / general-comparison work below.

## Guiding principle

Extend the existing engines; do not fork. Reuse `counterfactual.py`, `universal.py`,
`value_analysis`, `competitors.py`, `periods.py`, `fx.py`, and the single verdict engine
(`verdict.py`). **All new market-data reads are cached-only** (stale-while-revalidate) to
respect the Yahoo IP rate limit; per-security freshness is surfaced, never hidden.

---

## Part A — Display-currency consistency (spec §11–17)

**Decision: the valuation panel displays in CHF (the base currency) as the primary
figure, matching the price the owner already sees in CHF. Native is kept as a faint
secondary. Margin of Safety is unchanged. When FX is unavailable, both price and Fair
Value fall back to native — never mixed.**

### A1. Backend — additive `displayCurrency` block on the valuation payload

`value_analysis` stays entirely native (unchanged; MoS stays native/native → exact).
A new helper — `valuation.attach_display_currency(va, native_ccy, base="CHF",
as_of=today)` — augments the returned dict with:

```
displayCurrency: {
  code: "CHF",
  fxRate: <float>,          # resolve_fx(native_ccy, "CHF", as_of).rate
  fxAsOf: "YYYY-MM-DD",
  fxSource: "cache|nearest|range|latest",
  price:         <native price × rate>,
  fairValue:     <fairValue × rate>,
  grahamNumber:  <graham × rate>,
  entryTarget:   <entryTarget × rate>,
  intrinsicLow/Mid/High: <× rate>,
}
```

If `resolve_fx` returns `unresolved` → `displayCurrency: { code: "CHF", fxRate: null }`
and **no converted amounts** (never fabricated). Native `ccy` already on the payload is
untouched, so the original currency is always preserved (spec §13). MoS is **not**
recomputed — it is currency-invariant.

Wired wherever `value_analysis` is returned to a valuation-panel consumer: the research
valuation route (`_valuation_now`), the position endpoint's `valueAnalysis`, and the
screener/opportunity paths that feed `ValueAnalysis`. Additive only.

### A2. Frontend — `ValueAnalysis.tsx` shows CHF primary, native secondary

- When `data.displayCurrency?.fxRate` is present: render Current Price, Fair Value,
  Graham, entry target, and the intrinsic range with **CHF as the primary number**
  (`fmtMoney(chfValue, "CHF")`), and a faint secondary `(USD 300)` beneath using the
  native value. One footer line: `FX USD→CHF 0.88 · 26 Aug 2026` (rate + `fxAsOf`).
- When `fxRate` is null: render **everything native** (as today) plus a muted note
  "CHF conversion unavailable" — never one CHF figure next to one native figure.
- Margin of Safety % is displayed unchanged.

### A3. Frontend — `PositionDetail.tsx` header/price coherence

Keep the position **value** in CHF. Fix the internal contradiction where
`PositionDetail.tsx:224` treats `currentPrice` as native and `:335` treats it as CHF:
the per-share price shown against the valuation panel uses the same CHF figure as the
panel's Current Price (via `displayCurrency.price`), with native as the faint secondary,
so header and panel agree. No change to `currentValueCHF` accounting.

### A4. Tests (financial engine)

- MoS in USD == MoS after converting both price and fair value to CHF, subject to
  rounding (the invariance the spec §15/§23 demands).
- USD-stock-in-USD, USD-stock-in-CHF, EUR-stock-in-CHF conversion correctness.
- Fair Value and Graham convert by the same rate as the price.
- FX unresolved → `fxRate:null`, no converted fields, no fabricated 1.0.

---

## Part B — Generalize the VS comparison (spec §1–2)

**No backend change required** — `/analysis/compare` already accepts arbitrary
`benchmarks: string[]` and the counterfactual resolves any symbol via
`_resolve_benchmark` (`counterfactual.py:20`).

- `CompareModal.tsx`: add a `SymbolSearch`-backed "Add comparison" input. Any searched
  stock / ETF / index is appended to the selected comparison set alongside the existing
  five default chips (which stay as quick-picks). The modal is already N×N, so multiple
  comparisons already work.
- Existing ETF comparisons are untouched (regression-guarded by a test that the default
  benchmark path still returns a comparison).
- Sanity test: an arbitrary **stock** symbol as the counterfactual target produces a
  valid comparison (cash mirrored into that symbol's price series + its distributions).

---

## Part C — Market Analysis section (spec §3–10)

One reusable, self-fetching component backed by one new endpoint. It **supersedes** the
old `CompetitorsPanel` in Research (so Research is upgraded in place, not duplicated) and
is **also placed on the position-detail view** and in `OpportunityModal` — directly
satisfying defect #2 (competitor parity under Decisions).

### C1. Backend — `services/market_analysis.py` + `GET /research/market/{symbol}?range=`

Returns one bundle (all reads cached-only; each block degrades independently):

```
{
  symbol, name, sector, industry,          # cached snapshot; nulls → UI "unavailable"
  displayCurrency: "CHF",
  range,                                    # 1M|3M|6M|1Y|3Y|5Y (default 1Y)
  subject:   { returnPct, series[] },       # rebased price return, cached closes
  benchmarks: [                             # real, cached closes
    { key:"sp500",  symbol:"^GSPC"|"SPY", returnPct, series[] },
    { key:"world",  symbol:"VWRL.SW",     returnPct, series[] },
  ],
  sectorLine: {                             # curated ETF, else peer-median fallback
    kind: "etf" | "peer-median" | "unavailable",
    symbol?, label, returnPct, series[]?
  },
  competitors: [                            # reuse competitors(); add performance
    { symbol, name, isSubject, marketCapCHF, trailingPE, priceToBook,
      profitMargins, revenueGrowth,
      returns: { "1M":x, "3M":x, "6M":x, "1Y":x, "3Y":x, "5Y":x } | partial,
      relativeToSubjectPct }               # subject horizon minus peer horizon
  ],
  peerMedianReturnPct,
  classification: "market-wide-weakness" | "company-specific-weakness"
                | "outperforming-sector" | "outperforming-peers" | "inline",
  freshness: { subject, benchmarks, competitors }  # live|delayed|prev-close|none
}
```

Building blocks:

- **Sector line**: new `reference/sector_etfs.py` maps a sector (and, where finer,
  industry) to a real, fetchable sector ETF — e.g. Healthcare→`XLV`, Technology→`XLK`,
  Financials→`XLF`, Energy→`XLE`, Consumer Staples→`XLP`, Consumer Discretionary→`XLY`,
  Industrials→`XLI`, Materials→`XLB`, Utilities→`XLU`, Real Estate→`XLRE`, Comm.
  Services→`XLC`. If no mapping (or ETF history uncached) → **peer-median** of the
  competitor returns, `kind:"peer-median"`, clearly labeled. If neither → `unavailable`.
- **Competitor performance**: reuse `competitors(symbol)` for the peer set, then compute
  each peer's multi-horizon **price return** from cached closes (reuse `periods.py` /
  `history`), degrading per-peer when history is thin. Market caps FX-normalized to CHF
  via `fx.to_chf` (removes today's native-cap caveat). Optionally narrow to same
  **industry** where available, else same sector.
- **Performance methodology = price-return %** across every security. Percentage returns
  are currency-neutral, giving one consistent methodology (spec §17); no FX distortion in
  the comparison itself.
- **Market-vs-company classifier** (pure function, honest, never forces Sell):
  compares the subject's horizon return against the sector line, the broad benchmarks,
  and the peer median → one label. E.g. subject −20% with sector −18% & peers ≈ −15..−22%
  → `market-wide-weakness`; subject −20% with sector +12% & peers positive →
  `company-specific-weakness`. Upholds the verdict-engine invariant (relative
  underperformance never becomes a Sell).
- **Opportunity cost**: reuse the existing verdict `dimensions.opportunityCost` +
  `value_analysis` band/MoS. The bundle exposes the valuation status (overvalued/MoS) so
  the UI can state — objectively — whether valuation and relative performance agree or
  diverge. No fabricated or forced conclusion (spec §9/§10/§24).

### C2. Frontend — `components/MarketAnalysis.tsx`

Self-fetching via a new `api.marketAnalysis(symbol, range)` + react-query (the
`Fundamentals.tsx` pattern). Contents, using existing design-system tokens/components:

- **Company overview**: name · sector · industry (or "unavailable").
- **Market-vs-company callout** (the headline): a prominent card keyed on
  `classification`, using `gain`/`loss` tokens — makes "is it the market or the company?"
  immediately obvious.
- **Relative performance chart**: rebased multi-line (subject azure; sector + benchmarks
  muted; competitors optional) over the selected `TimeRangeSelector` horizon.
- **Competitor table**: company · market cap (CHF) · P/E · P/B · net margin · rev growth
  · 1M/1Y/3Y/5Y return · relative-to-subject; subject row highlighted; per-cell
  unavailable states; freshness dot. (Superset of today's `CompetitorsPanel`.)
- **Valuation-vs-competitors / opportunity-cost** strip: subject valuation band + MoS
  (in CHF, from Part A) beside the relative-performance verdict.

Placement:
- `PositionDetail.tsx`: new `navSections` entry `{ id:'sec-market', label:'Market
  analysis', icon: <Radar/Building2> }` + a matching `<section id="sec-market"
  className="card mb-6 scroll-mt-24">`.
- `Research.tsx`: replace the standalone `CompetitorsPanel` block with `<MarketAnalysis>`
  in the `AssetView` stack (Research gains competitor performance + sector/benchmark).
- `OpportunityModal.tsx`: one more `border-t` section with `<MarketAnalysis>`.

### C3. Tests (financial engine)

- Sector line: curated ETF resolves when mapped + cached; peer-median fallback when
  unmapped; `unavailable` when neither.
- Competitor performance computed from cached closes; per-peer partial when history thin.
- Market-vs-company classifier: Scenario A (weak market) → `market-wide-weakness`;
  Scenario B (company-specific) → `company-specific-weakness`; plus outperform/inline.
- Graceful states: sector unavailable, competitors unavailable, insufficient history,
  provider/cache miss → structured empty, never a crash or fabricated number.

---

## Non-goals (YAGNI)

No new FX provider; no real-time sector-index feed (curated ETF + peer-median only); no
per-view CHF/native toggle (CHF primary, native secondary is enough); no live bulk peer
fetching (cached-only); **no forced Sell** — the data determines the conclusion.

## Sequencing (each its own branch, small commits)

1. **A — Currency consistency** (backend `displayCurrency` block + `ValueAnalysis` /
   `PositionDetail` render + tests). Smallest, highest-value; unblocks the owner's #1.
2. **B — Generalize CompareModal** (frontend `SymbolSearch` wiring + one regression
   test). Small.
3. **C — Market Analysis** (backend service + endpoint + `MarketAnalysis` component into
   PositionDetail / Research / OpportunityModal + tests). The bulk; delivers defect #2
   and spec §3–10.

Each slice gets its own implementation plan when reached. Backend restart is required to
pick up the new route (no migrations — additive JSON + read-only queries).

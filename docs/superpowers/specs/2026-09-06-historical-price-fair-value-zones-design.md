# Historical Price vs Fair Value Zones — Design

**Date:** 2026-09-06
**Status:** Approved (brainstorming) → ready for implementation planning
**Component:** `frontend/src/components/ValuationBand.tsx` (`PriceBandChart`) + new backend service/endpoint

---

## 1. Problem

The current "Price vs Fair Value Zones" chart draws today's Fair Value and its
Buy / Fair / Overvalued / Sell zones as **flat horizontal bands across the entire
history**. This visually implies that today's thresholds also existed years ago.
They did not — the valuation zones move as the underlying fundamentals change.

The chart even admits this in its own footnote today:

> "Zones are a snapshot of today's fair value — held flat across the window. The
> price line is real history; earlier prices were valued against different
> fundamentals."

**Old question the chart answers:** *Where was historical price relative to today's Fair Value?*

**New question it must answer:** *Where was historical price relative to the Fair
Value that existed at that point in time — and how/why did that Fair Value move?*

---

## 2. Data reality (the constraint that shapes everything)

Investigated in the codebase before designing. Verdict:

| Data | Status | Source |
|---|---|---|
| Daily price history, multi-year | ✅ Available | `price_cache`, `marketdata.get_history` / `price_on` |
| Annual statements (~4 fiscal years): revenue, net income, FCF, D&A, capex, stockholders' equity, invested capital, **shares outstanding** | ✅ Available as historical facts | `history[]`, `cashflow.years[]`, `balance.years[]` from `yfinance_provider.fundamentals()` |
| Point-in-time **snapshot** fundamentals (trailingEps, priceToBook, growth) by date | ❌ Not stored | `fundamentals_cache` keeps **one row per symbol**, overwritten (`INSERT OR REPLACE`) on every refresh |
| Quarterly statements | ❌ Never fetched | — |

An existing "Replay" feature (`frontend/src/modals/ReplayModal.tsx` +
`backend/app/routers/research.py::_valuation_as_of`) already values a stock at its
historical **price** but with **today's** fundamentals, and honestly labels itself
as "indicative" because "the data provider has no point-in-time financial
statements." This design fixes that gap for the chart, using only data actually
known at each past date.

### Consequence

A truthful, no-look-ahead reconstruction is possible **only at annual
(fiscal-year report) granularity, for roughly the last 4 years** — the depth
yfinance provides. Fair Value and the zones therefore form a **step function**
that changes only when a new annual report became public, not a smooth daily line.

The spec's originally-imagined **daily** driver decomposition ("Sep 5 → Sep 6:
EPS +8.4%…") is **not truthfully supportable** and is out of scope. Year-over-year
change at each annual step **is** supportable and is included.

---

## 3. Decisions (from brainstorming)

1. **Scope:** Annual-step reconstruction. Rebuild the valuation models to run off
   the annual statement lanes at each fiscal-year report date. **No new persistence
   table** in this build.
2. **Explainability:** **Full driver breakdown** — at each annual step, show the
   year-over-year change of each underlying input (EPS, FCF/share, book value,
   growth/CAGR).
3. **Primary visualization:** **FV spine + stepped zone bands + scrub cursor.** A
   prominent stepped Fair Value line, softly shaded stepped zone bands around it,
   the real daily price line on top; hover/scrub drives a snapshot card + driver
   breakdown. Today's boundaries drawn strongest, history quieter.

---

## 4. Point-in-time integrity (must-not-be-wrong invariants)

These are the correctness invariants. Backend tests assert each; **no look-ahead is
a hard acceptance criterion**, not a best-effort goal.

### 4.1 Three distinct dates (never conflated)

- **Fiscal period end** — the accounting period the statement covers (e.g.
  2020-09-26). Not when the data became public.
- **Statement / filing date** — when the report was actually published/filed. Use
  the **real filing (or report/publication) date where the provider exposes it.**
- **Effective date** — the date from which we allow a snapshot to affect the chart.
  `effectiveDate = filingDate` **when a real filing date is available**; otherwise
  `effectiveDate = fiscalPeriodEnd + filingLag` where `filingLag` is a
  **configurable fallback assumption (default 90 days)** — explicitly flagged in the
  response as an assumption, **never presented as historical fact**.

### 4.2 Invariants

- **Selection rule:** `snapshot(T) = the latest defensible valuation snapshot whose
  effectiveDate ≤ T`. Held flat (step) between reports; no smoothing/interpolation.
- **No look-ahead:** historical Fair Value must **never** depend on fundamentals
  not yet available at that historical point. Trailing CAGR at fiscal year `Y` uses
  **only** statement years `≤ Y`.
- **Stability:** changing **today's** fundamentals must **not** alter any historical
  snapshot. Historical snapshots depend solely on statements whose effective date
  precedes them. (Backend test: mutate the latest snapshot's inputs → all prior
  snapshots byte-identical.)
- **Before the earliest reconstructable step:** an explicit *"insufficient
  fundamental history"* region. **Never** backfilled with today's zones.
- Coverage ceiling is whatever the provider returns (~4 annual periods). Do not
  fabricate deeper history.

---

## 5. Backend design

### 5.1 New service: `backend/app/services/valuation_history.py`

For each fiscal year `Y` present across the annual statement lanes, derive
**as-of inputs** using only facts known at `Y`:

- `eps_Y      = netIncome_Y / sharesOutstanding_Y`
- `bvps_Y     = stockholdersEquity_Y / sharesOutstanding_Y`
- `fcfps_Y    = freeCashFlow_Y / sharesOutstanding_Y` (and a trailing **normalized**
  FCF/share = median of FCF/share for years `≤ Y`, mirroring today's
  `normalized_fcf_ps`)
- `growth_Y   = income CAGR computed over statement years ≤ Y` (mirrors
  `_pick_growth`'s multi-year CAGR path; snapshot-based growth fallbacks are
  **not** available historically and are simply omitted). Computing a CAGR needs
  **≥ 2 income years ≤ Y**; a year without a computable trailing growth (and
  without derivable per-share inputs) is **not reconstructable**. `coverageFrom` is
  therefore the effective date of the **earliest year that has both** a computable
  growth and valid per-share inputs — not necessarily the oldest statement on file.

Then run the **same** model functions used today (reuse `valuation.py` internals;
extract shared helpers rather than duplicating):

- Graham Number: `sqrt(22.5 · eps_Y · bvps_Y)` (dropped if `eps_Y ≤ 0` or `bvps_Y ≤ 0`)
- Graham Growth: `eps_Y · (8.5 + 2·min(max(growth_Y·100, 0), 15))`
- Earnings DCF: `_dcf(eps_Y, growth_Y, …)`
- FCF DCF: `_dcf(normalized_fcfps_Y, growth_Y, …)`

`fairValue_Y = median(available models)`. Zone edges from the existing
`classify_band(price, fairValue_Y, cfg)` using the same user `cfg`
(MoS / overvalued / significant premiums). `price` for classification of a *step*
is not needed to draw bands (bands are derived from `fairValue_Y` and `cfg` alone);
the band **verdict** at a given date uses the historical price on that date
(`price_on`).

**Effective date** for step `Y` (see §4.1): prefer the **real filing/report date**
where the provider exposes it; otherwise fall back to `fiscalPeriodEnd_Y +
filingLagDays` (default 90, configurable) and mark `effectiveDateSource:
"filing" | "assumed"` on the snapshot. Requires retaining, per statement year, the
**fiscal-period-end date** (yfinance statement columns are period-end timestamps)
and, if available, the filing date. If the provider currently retains only an
integer `year`, the plan must extend `yfinance_provider` to retain these dates.

**Drivers & the valuation chain** (honest, no fabricated causal split). Fair Value
is the **median of four models**, so we do **not** attribute a percentage of the FV
move to any single input. Instead, for step `Y` vs previous step `Y-1`, return
enough to let the UI explain the whole chain **Fundamentals → Model outputs → Fair
Value → Zones**:

- **Input changes:** for each of `eps`, `fcfPerShare` (normalized), `bvps`,
  `growth` — `{ before, after, deltaPct, dir: "up"|"down"|"flat" }`.
- **Model responses:** for each of `grahamNumber`, `grahamGrowth`, `epsDcf`,
  `fcfDcf` — `{ before, after, deltaPct, contributed: bool }` (`contributed` =
  whether the model was part of the median before/after; a model can drop in/out,
  e.g. EPS turning positive).
- **Outputs:** `fairValue { before, after, deltaPct }` and the zone edges
  `{ before, after }` for entry / overvalued / sell.

First step has `drivers = null` (no prior snapshot to diff against).

### 5.2 New endpoint: `GET /research/valuation/history/{symbol}`

Response shape (final field names follow existing conventions during
implementation):

```jsonc
{
  "symbol": "AAPL",
  "currency": "USD",              // financial currency; FX handled on frontend via existing scalar
  "coverageFrom": "2021-01-27",   // earliest effective date reconstructable (= earliest snapshot.asOf)
  "snapshots": [
    {
      "asOf": "2021-01-27",           // effective date (see effectiveDateSource)
      "effectiveDateSource": "filing",// "filing" (real) | "assumed" (period-end + lag)
      "fiscalPeriodEnd": "2020-09-26",
      "filingDate": "2021-01-27",     // null when not available from provider
      "fiscalYear": 2020,
      "fairValue": 120.4,
      "entryTarget": 84.3,            // FV·(1-MoS)
      "overvaluedAt": 144.5,          // FV·(1+ovPremium)
      "sellZoneAt": 168.6,            // FV·(1+sigPremium)
      "inputs":  { "eps": 3.28, "bvps": 3.85, "fcfPerShare": 4.0, "growth": 0.09 },
      "models":  { "grahamNumber": 16.9, "grahamGrowth": 88.6, "epsDcf": 130.2, "fcfDcf": 150.1 },
      "drivers": null                 // first step; otherwise the object below
    }
  ],
  "note": "Reconstructed from annual statements known at each date. Effective date = real filing date where available, else period-end + configurable lag (default 90d). ~4y coverage; annual granularity."
}
```

`drivers` (non-first steps) — supports the Fundamentals → Models → FV → Zones chain:

```jsonc
{
  "inputs": {
    "eps":         { "before": 3.28, "after": 3.61, "deltaPct":  0.101, "dir": "up" },
    "fcfPerShare": { "before": 4.00, "after": 4.24, "deltaPct":  0.060, "dir": "up" },
    "bvps":        { "before": 3.85, "after": 3.97, "deltaPct":  0.031, "dir": "up" },
    "growth":      { "before": 0.09, "after": 0.088,"deltaPct": -0.017, "dir": "down" }
  },
  "models": {
    "grahamNumber": { "before": 16.9,  "after": 18.0,  "deltaPct": 0.065, "contributed": true },
    "grahamGrowth": { "before": 88.6,  "after": 94.1,  "deltaPct": 0.062, "contributed": true },
    "epsDcf":       { "before": 130.2, "after": 143.4, "deltaPct": 0.101, "contributed": true },
    "fcfDcf":       { "before": 150.1, "after": 159.3, "deltaPct": 0.061, "contributed": true }
  },
  "fairValue": { "before": 120.4, "after": 139.6, "deltaPct": 0.159 },
  "zones": {
    "entryTarget":  { "before": 84.3,  "after": 97.7 },
    "overvaluedAt": { "before": 144.5, "after": 167.5 },
    "sellZoneAt":   { "before": 168.6, "after": 195.4 }
  }
}
```

Cached alongside fundamentals (same TTL story). Reconstruction cost is trivial
(~4 models × ~4 years).

---

## 6. Frontend design

### 6.1 API layer

`frontend/src/lib/api.ts`: add `api.valuationHistory(symbol)` + types
`ValuationHistory` and `ValuationSnapshot`. Fetched with React Query alongside the
existing `marketHistory` query in `PriceBandChart`.

### 6.2 Merge (price ↔ step)

For each daily price point `d`, resolve the applicable snapshot = last snapshot
with `asOf ≤ d.date`. Produce a merged row `{ date, close, fairValue, entryTarget,
overvaluedAt, sellZoneAt }`. Points before `coverageFrom` carry `null` valuation
fields (drive the pre-coverage region). Memoized; O(n) with a single forward pass
(snapshots are sorted).

### 6.3 Chart (rework `PriceBandChart`)

- **Stepped zone bands:** replace flat `ReferenceArea`s with stacked `Area
  type="stepAfter"` layers between `0→entryTarget→overvaluedAt→sellZoneAt→top`, per
  date. Buy=green, Fair=azure, Over=amber, Sell=red (reuse existing `C` tokens and
  `ZONE_STYLE`).
- **FV spine:** prominent `Line type="stepAfter"` on `fairValue`.
- **Price:** real daily line on top; keep line / area / dots marks.
- **Current vs history emphasis:** rightmost (today's) boundaries at full opacity
  with right-edge labels + a FV badge; earlier steps at reduced opacity.
- **Pre-coverage region:** hatched/greyed band with an inline "insufficient
  fundamental history" label; **no** zone fills there.
- **No smoothing:** the FV spine and zone edges use `stepAfter` only. Historical
  Fair Value is never interpolated between reports.
- **Scrub cursor:** hover or click pins a date → vertical cursor + a **snapshot
  card** (price, Fair Value, discount to FV, zone verdict, and the zone edges Buy /
  Fair range / Overvalued / Sell). **Keyboard accessible**: focusable chart, arrow
  keys move the selected date, not hover-only.
- **Valuation transitions as first-class events:** each report date (where FV
  steps) is a distinct marker on the timeline. Selecting/clicking a transition
  opens a **transition detail view** that shows *exactly what changed between the
  two annual snapshots*, laid out as the chain **Fundamentals → Model outputs →
  Fair Value → Zones**: the four input before→after values, then how each of the
  four models responded (before→after, and whether it entered/left the median),
  then the resulting FV and zone-edge before→after. This is the spec's headline
  explainability surface, driven entirely by `drivers`.
- **Controls preserved:** timeframe presets (Max/5J/3J/1J/6M/3M/1M), mark type
  (Linie/Fläche/Punkte), Linear/Log, % Rebase. Rebase still hides absolute-price
  zones (unchanged).
- **New caption** replacing the "held flat" apology, e.g.: *"Valuation zones are
  reconstructed from the fundamentals reported at each date. Scrub to any point to
  see the Fair Value and zones as they stood then."* Final copy owned during
  implementation.

### 6.4 Responsive & motion

Snapshot card stacks below the chart on narrow viewports; labels simplify; touch
targets remain adequate. Transitions subtle and gated on `prefers-reduced-motion`.

---

## 7. States & edge cases

- **Loading:** existing placeholder pattern, extended to await both queries.
- **Insufficient history** (< 2 usable annual statements, or no derivable
  per-share inputs): show an **honest unavailable state** — the real daily price
  line plus an explicit *"historical valuation unavailable — insufficient
  fundamental history"* message and **no zones at all**. **Never** fall back to
  today's zones. (Today's single FV may appear only as a labeled current-date badge,
  never as bands spanning history.)
- **Negative EPS / non-positive book value:** the affected Graham model drops out;
  FV = median of the rest (matches today's behavior). If no model is valid for a
  year, that step is omitted (gap → pre-coverage/gap treatment).
- **Missing shares for a year:** skip that step (can't derive per-share).
- **ETFs / instruments without meaningful fundamentals:** honest unavailable state
  (price line + message, **no zones**); never today's zones. Respect existing domain
  limits.
- **Currency:** display via the existing scalar `rate` prop (unchanged mechanism).
- **Known limitation (documented in the note):** yfinance prices are
  split-adjusted while reported shares outstanding may not align perfectly across
  splits, so very-long-horizon per-share figures can be approximate.

---

## 8. Testing

TDD throughout.

**Backend (unit):**
- **No-look-ahead (hard criterion):** FV/inputs at effective date `T` use only
  statement years whose effective date `≤ T`; trailing CAGR excludes future years.
- **Stability:** mutating today's/latest fundamentals leaves every prior snapshot
  byte-identical.
- **Effective date:** real filing date used when present (`effectiveDateSource:
  "filing"`); period-end + configurable lag used only as fallback
  (`"assumed"`), and the lag is not baked in as fact.
- Correct derivation of `eps/bvps/fcfps` from synthetic statements.
- Step behavior (applicable-snapshot resolution: latest defensible with
  `effectiveDate ≤ T`).
- Drivers: input before/after + deltaPct + dir; per-model before/after +
  `contributed` (including a model entering/leaving the median); FV & zone
  before/after; first step `null`.
- Model drop-out on negative EPS / non-positive book value / missing inputs.
- Endpoint contract test.

**Frontend:**
- Price→step merge (correct snapshot per date; `null` before coverage; step, not
  interpolated).
- Stepped-series alignment feeding `stepAfter`.
- Pre-coverage + insufficient-data + ETF states render **no zones** (never today's).
- Scrub/pin selection + keyboard navigation.
- Transition detail view renders the full Fundamentals → Models → FV → Zones chain
  from `drivers`.

**Visual QA (Playwright)** across spec §40 states: today, 5y, 3y, 1y, a specific
historical date, a big FV step, a price-moved-while-FV-flat window, desktop,
narrow, hover, pinned snapshot, loading, no-data. Screenshots inspected and
iterated.

**Regression:** all existing controls (presets, marks, linear/log, rebase, Brush)
still work. Per project memory, the pre-existing `market_analysis_bundle` (×3) and
flaky document-preview e2e failures are known and not chased.

---

## 9. Non-goals

- No quarterly or daily Fair Value (data doesn't exist).
- No new persistence table in this build. **Future enhancement:** a
  `fundamentals_history(symbol, asOfDate, payload)` table populated on refresh
  would grow a genuinely denser point-in-time series over time.
- `ReplayModal` left unchanged for now. Possible follow-up: point it at this honest
  reconstruction.
- No fabricated pre-coverage zones, no fabricated causal attribution of FV moves.

---

## 10. Success criteria

- The chart no longer implies today's zones existed unchanged in the past.
- Buy/Fair/Overvalued/Sell thresholds visibly **step** (never smoothed) as
  fundamentals changed.
- **No look-ahead (hard criterion):** historical valuation uses only point-in-time
  information; changing today's fundamentals does not alter historical snapshots
  (both asserted by tests).
- Effective dates prefer real filing dates; the lag fallback is labeled as an
  assumption.
- Market Price, Fair Value, and zones are immediately distinguishable.
- The user can scrub to any date, and clicking a transition reveals the full
  **Fundamentals → Model outputs → Fair Value → Zones** chain for that step.
- Today's valuation stays highly visible.
- Pre-coverage, insufficient-data, and ETF cases produce honest **no-zone** states;
  never today's zones.
- Existing controls and functionality remain intact.

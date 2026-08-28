# DecisionGuru — Complete Application & Investment-Logic Overview

> **Status:** forensic audit baseline (2026-08-28), **now partly superseded** by the
> Value-Investing Engine 2.0 redesign of the same date. **§0 below is the authoritative
> current state** of the valuation/quality/portfolio/recommendation engine; the companion
> **`VALUE_INVESTING_AUDIT.md`** is the authoritative methodology spec (every new formula,
> assumption, test, and per-fix rationale). §§1–32 remain the original forensic baseline of
> the **pre-redesign** implementation — accurate as history and for the parts untouched
> (portfolio/tax/counterfactual/XIRR/exports), but where §0 and §28's ✅ marks contradict a
> later section, **§0 wins**.
>
> **Method (baseline sections):** every formula, threshold, and issue was transcribed from
> the code with `file:line` references, tagged **[Technical]** vs **[Financial]** and
> prioritised **P0–P3** (P0 = can corrupt a headline / flip a conclusion … P3 = cosmetic).

---

## 0. Value-Investing Engine 2.0 — current state (authoritative)

The valuation, quality, portfolio-fit and recommendation engine was redesigned in six
test-driven phases (**82 pytest tests**, `backend/tests/`, run `cd backend && .venv/bin/python
-m pytest`). Full methodology, formulas and per-fix rationale: **`VALUE_INVESTING_AUDIT.md`**.
What changed vs the baseline below:

**Data integrity (Phase 1).** Debt-free now **passes** the leverage check (unknown debt =
n/a, excluded from the score); FX no longer silently returns 1.0 — `fx.resolve_fx()` reports
the resolution source and `get_fx_rate(strict=True)` returns None on an unresolvable pair;
EPS/currency minor-unit normalised by the snapshot's own currency; `dividendYield` always ÷100
(verified percent in yfinance 1.6.0); fair-value midpoint is the **true median**, not the
index-max.

**Valuation to a range (Phase 2).** The DCF is a two-stage taper (growth fades g₀→terminal,
finite for any g₀ — no more clipping high growers to r−0.001); reverse DCF returns "no
solution" outside a plausible bracket instead of saturating to 40%; a **cash lane** adds
FCF/share, median-normalised FCF, owner earnings (NI+D&A−capex) and an FCF-based DCF model;
**bear/base/bull scenarios** produce a `valuationRange` + `valuationUncertainty` (wide spread
lowers confidence); a **Sell now requires ≥ medium confidence AND ≥ 2 agreeing models**, else
it trims.

**Business quality & strength (Phase 3).** New `services/quality.py`: ROIC (NOPAT/invested
capital), FCF conversion, interest coverage, revenue/margin/FCF consistency, dilution, and a
**moat signal that is measurable-or-unknown** (never fabricated); a financial-strength module
with **distinct debt states** (debt-free / low / moderate / high / unknown). The provider now
also fetches the cash-flow and balance-sheet statements (+ income interest/pretax/tax), cached
7 days. Exposed as `qualityAssessment` + `financialStrength` on the valuation payload.

**Portfolio intelligence (Phase 4).** New `services/portfolio_intel.py`: through-ETF indirect
exposure (holding% × ETF weight), effective exposure, and a **fit decision kept distinct from
asset merit** (improves / neutral / concentrates / **prefer-etf**). Ownership is recognised by
**ISIN/economic entity** (`repo.owned_isin_set()` / `is_owned(symbol, isin)`), not just the
ticker string. Overlap stays honestly "top-holdings-only".

**Recommendation Engine 2.0 (Phase 5).** The single shared `verdict.resolve_verdict` now emits
a multi-dimensional `dimensions` block (valuation, quality, financial strength, expected
return, portfolio fit, opportunity cost, data confidence, risk) kept separate rather than
blended, plus two new ownership-aware outcomes: **PREFER ETF** (an attractive buy already held
heavily via ETFs) and **INSUFFICIENT DATA** (no reliable valuation). Canonical verdict key
stays {buy-more, hold, sell}.

**Discover (Phase 6).** Attractiveness now scales by **data confidence** and sinks
INSUFFICIENT-DATA names, so a shaky 50% margin of safety no longer outranks a robust 30%
(`screener.discover_attractiveness`). Ranking is ownership-independent — ownership only rewords
the action.

**Wired end-to-end (API + UI):** the Research and Position endpoints pass `fit` + ISIN
ownership into `resolve_verdict`, so **PREFER ETF** and the fit layer surface (dimensions /
INSUFFICIENT-DATA flow on every verdict, auto-pulled from the va payload). The frontend renders
the new outputs: the **bear/base/bull valuation range** + uncertainty, **owner earnings / FCF**,
a **business-quality & financial-strength panel** (ROIC, cash conversion, interest coverage,
moat, debt state) in `ValueAnalysis`, and the **fit decision** (incl. Prefer ETF) in
`PortfolioFit`; the verdict badge shows the new action labels automatically (`tsc` clean, build
passes). Follow-on backend fixes: `benchmark_cagr` is **total-return** (#10); Discover values at
the same resolved price as Decisions (#14); `reallocatableCHF` is **freed capital**, not gain
(#15); `prospective_projection` returns a bear/base/bull `holdRange` (#11).

**EPS currency — verified non-issue:** a live probe (NSRGY trades USD/reports CHF; BABA
USD/CNY) confirmed yfinance returns `trailingEps` in the **trading** currency (`trailingEps ==
price/PE` exactly), so the prior audit's feared "EPS reporting-ccy vs price" P0 (#5) needs **no
FX conversion** — minor-unit normalisation is the complete fix.

**Genuinely open (documented):** split adjustment (#4) — deferred as **data-dependent and
risky** (adjusting prices without the matching share-count convention from DEGIRO could corrupt
correct positions; the counterfactual's cash-mirroring is already split-agnostic); a real
**full-ETF-constituent source** (needs an external data feed — overlap stays honest top-10);
band-edge price hysteresis (minor). The §28 register is annotated below.

---

## 1. Executive Summary

DecisionGuru is a **local-first, single-user, Swiss-tax-aware investment decision-support app**. It ingests two DEGIRO CSV exports (trades + cash), values each holding after Swiss tax, and — for every holding or candidate — computes the **opportunity cost of holding it versus putting the same money in a benchmark ETF**. On top of that counterfactual it layers a value-investing valuation engine (Graham + a two-stage DCF + a Buffett-style quality scorecard), a single shared Buy-more/Hold/Sell verdict engine, portfolio exposure and ETF-overlap analysis, a global screener/"Discover" surface with an opportunity map, alerts, and export/share.

**The engine is internally coherent, honest about being an estimate, and defensive about data (stale-while-revalidate caching, an executed-price integrity guard, a curated ISIN→ticker seed).** Its architecture is unusually disciplined: one verdict engine, one tax model, one formatting module, consumed by every surface.

**However, the audit found a cluster of P0/P1 issues that can flip a Buy/Hold/Sell conclusion or corrupt a headline number** — chiefly around **currency/units** (pence-quoted instruments and cross-listed valuations), a **debt-free-company-fails-the-leverage-check inversion**, a **DCF growth cliff**, **no split adjustment**, and a systematic **price-return-as-forward-return** assumption. These are enumerated in §28 and §30–31 and should be addressed before the tool's conclusions are trusted for real capital.

**The single most important structural limitation:** all ETF exposure/overlap analysis is bounded by the data provider's **top-~10 holdings** — no full ETF constituent data exists anywhere in the system. "Indirect exposure unavailable" means "not in a top-10", **not** "no exposure." (§16.)

---

## 2. What DecisionGuru Actually Does

**[CURRENT]** For a Swiss private investor holding a DEGIRO portfolio, DecisionGuru answers:

1. **What do I own, and what is it worth after Swiss tax?** (Portfolio Overview, per-position P/L.)
2. **Am I better or worse off than if I'd bought a benchmark ETF instead?** (The signature *counterfactual*: azure = actual, gold-dashed = ETF, shaded gap = opportunity cost.)
3. **Given valuation + quality + that opportunity cost, should I Buy more / Hold / Sell?** (The shared verdict engine; ownership-aware wording: not-owned names read Buy/Watch/Avoid.)
4. **Are there attractive names I don't own, anywhere in the world?** (Discover screener + opportunity-density globe.)
5. **Does buying a candidate actually fit my portfolio?** (Portfolio-fit: direct + indirect ETF exposure, diversification.)
6. **What would switching / reallocating do?** (What-if sale, scenarios, plans, recovery-time.)
7. **Help me act and share.** (Alerts, exports, external research links.)

It is a **counterfactual-and-valuation engine with a portfolio-context layer**, not a live trading system and not a data terminal. Everything is derived offline from cached provider data; the request path never blocks on the network.

---

## 3. Application Architecture

```
DEGIRO CSVs ─▶ Importer ─▶ SQLite (instruments, transactions, account_events, caches)
                                    │
        ┌───────────────────────────┼───────────────────────────────┐
        ▼                           ▼                                ▼
  Market data provider        Services layer                    FastAPI routers
  (yfinance, cached)     (finance, counterfactual, valuation,   (/api/analysis, /research,
  FX (frankfurter)        verdict, exposure, fit, screener,      /screener, /decisions,
        │                 scan, tax, projection, decision …)     /market, /export, …)
        └─────────────────────────┬─────────────────────────────────┘
                                   ▼
                     React + Vite + Tailwind frontend
             (Zustand store ⇄ URL hash, TanStack Query, Recharts, cobe)
```

- **Backend:** Python 3.12 / FastAPI, port 5178. Services in `backend/app/services/*` (44 modules); routers in `backend/app/routers/*`. Market data via `yfinance` behind a `MarketDataProvider` interface (`providers/yfinance_provider.py`), FX via `frankfurter.app`. Aggregation optionally via PySpark, degrading to an identical pandas reducer. Exports via `openpyxl`/`reportlab`/`python-docx`.
- **Storage:** one SQLite file; additive `CREATE TABLE IF NOT EXISTS` self-migration; no migration framework. "Deploy" = push to `origin/main`.
- **Frontend:** `frontend/src`. Zustand store (`store.ts`) is the source of truth, bound two-way to the URL hash by `lib/router.ts` (only `view`/`selectedInstrumentId`/`researchSymbol` are in the URL — **not** `benchmark`, `preTax`, or `modal`). Every screen uses TanStack Query (`staleTime 30s`, `retry 1`).
- **Constraints (intentional):** Tailwind only, **dark mode only**, **modals not page redirects**, no automated tests (the owner tests the running app).

---

## 4. Complete Feature Inventory

| # | Feature | Location | Purpose | Backend engine(s) | Key issues |
|---|---------|----------|---------|-------------------|-----------|
| 1 | Portfolio Overview | `views/Dashboard.tsx` | Cash, invested, today's P/L, total gain, sell signals, equity curve, exposure, timeline, holdings, dividends | `/analysis/portfolio`,`/portfolio/series`,`/timeline`,`/decisions/exposure` | "Today's P/L" tied to chart range (P2) |
| 2 | Position Detail | `views/PositionDetail.tsx` | Full one-holding workup: verdict, opportunity cost, alternatives, history, fundamentals, value, fit, projection, dividend-shock, what-if, transactions, allocation, news, notes | `/analysis/position\|counterfactual\|breakeven\|projection\|whatif\|dividend-shock\|fit`, `/market/*` | `cf.data!` non-null → page crash if counterfactual errors (P2) |
| 3 | Research | `views/Research.tsx` | Research any asset (owned or not); deep-linkable `#/research/<sym>` | `/research/asset\|fundamentals\|competitors\|valuation\|projection\|compare\|claim`, `/market/*` | hardcoded `VWRL.SW` third comparator (P3); blank on error |
| 4 | Discover / Screener | `views/Screener.tsx`,`DiscoverMap`,`DiscoverFilters` | Global value screen, attractiveness, opportunity map, "New opportunities", warmer | `/screener`,`/screener/refresh`,`/watchlist` | cached-only eligibility; possible perpetual "loading" tail (P2) |
| 5 | Decisions | `views/Decisions.tsx` | Every holding ranked Buy/Hold/Sell + CHF at stake + reinvest target + cash-deploy | `/decisions/recommendations`,`/analysis/counterfactual` | "why" chart ignores `preTax` (P3) |
| 6 | Advisory | `views/Advisory.tsx` | Holdings that materially lagged a reference ETF | `/analysis/advisory` | no error UI |
| 7 | Watchlist | `views/Watchlist.tsx` | Monitor unheld names; entry-target + rank-vs-portfolio; 1-click alert | `/watchlist`,`/watchlist/analysis`,`/research/compare`,`/alerts` | shared-mutation "alerted" tick (P2) |
| 8 | Alerts | `views/Alerts.tsx` | Notification feed + price alerts + scan status | `/alerts*` | server default target unverified |
| 9 | Scenarios | `views/Scenarios.tsx` | Baskets / sell-all→ETF after-tax delta | `/scenarios`,`/scenarios/run` | unhandled run error |
| 10 | Plans | `views/Plans.tsx`,`CreatePlanModal` | Named sell→reinvest plans tracked from creation | `/plans`,`/plans/{id}/compare` | allocation normalisation ambiguity |
| 11 | Compare | `modals/CompareModal.tsx` | N holdings × N ETFs | `/analysis/compare` | — |
| 12 | Opportunity | `modals/OpportunityModal.tsx` | Fair-value read from Discover + fit + listing | `/research/valuation`,`/analysis/fit`,`/screener/listings` | ext links use screened symbol, not recommended listing (P3) |
| 13 | Replay | `modals/ReplayModal.tsx` | "Was it cheap on date X?" | `/research/valuation?asOf=` | fundamentals are today's (caveated) |
| 14 | Recovery | `modals/RecoveryModal.tsx` | Recovery paths for a sale | `/decisions/recovery` | — |
| 15 | Share / Export | `modals/ShareModal.tsx`,`lib/exporters.ts`,`lib/shareImage.ts` | PDF/DOCX/XLSX/Image + Web Share + mailto | `/export/*`,`/analysis/*`,`/research/*` | drops active `benchmark`/`preTax` (P2); portfolio PDF omits chart (P2) |
| 16 | External links | `lib/externalLinks.ts` | Yahoo / Google Finance | — | Google URL wrong exchange for NYSE/`BRK.B` (P3) |
| 17 | Import | `modals/ImportModal.tsx` | DEGIRO trades + account ingestion | `/imports/upload\|preview\|commit` | non-DEGIRO needs manual mapping |
| 18 | Settings | `modals/SettingsModal.tsx` | Tax + valuation parameters | `/settings*`,`/instruments/reresolve-all`,`/data/reset` | broad `invalidateQueries()` on save |
| 19 | Alerts scan (background) | `services/scan.py`,`screener_warm.py` | 6-hourly universe warm + opportunity diff | — | inline warm under scan lock (P3) |

**Verified correction:** an earlier draft flagged "Research has no sidebar entry" — this is **false**; Research is in the sidebar nav (`Sidebar.tsx:27`).

---

## 5. Complete Use-Case Inventory

| Use case | User goal | Current workflow | Problems | Missing |
|---|---|---|---|---|
| Keep this stock or switch to an ETF? | Hold vs sell | Position → opportunity cost + verdict + catch-up | cf-error crash (P2) | no one-click execute |
| Where am I leaking vs the index? | Find laggards | Advisory / Decisions | Advisory no error UI | — |
| Is this new name cheap enough to buy? | Value entry | Discover row → Opportunity modal → Research | ext links use screened symbol | alerts-from-Opportunity |
| Which exchange should I buy on? | Right listing for CHF | Opportunity → ListingRecommendation | recommended listing not carried to ext links | — |
| Was it a buy a year ago? | Backtest a verdict | Replay modal | fundamentals are today's (caveated) | true as-of fundamentals |
| Track a plan I made | Accountability | CreatePlan → Plans compare | alloc normalisation ambiguity | edit-plan |
| Alert me at my price | Timed entry | Watchlist bell / Alerts | shared-mutation tick (P2) | per-alert custom price in UI |
| Share this analysis | Send to someone | Share modal (PDF/DOCX/XLSX/image/email) | export ignores active benchmark/preTax (P2) | — |
| Import broker data | Onboard | Import modal | only DEGIRO auto-detected | multi-broker mapping |
| Compose a what-if basket | Explore | Scenarios / Compare | unhandled run error | — |
| Do I already own this (directly/indirectly)? | Avoid overlap | Portfolio-fit panel | top-~10 only (P1) | full-constituent overlap |
| Discover globally | Find ideas worldwide | Discover + opportunity globe | cache-gated universe (P2) | broader coverage |

---

## 6. Data Sources

See §23 for the full Data-Source Catalog and §17 for the data model. Summary:

- **Market data:** `yfinance` (`providers/yfinance_provider.py`). Quotes via `fast_info` + `history_metadata` (never the heavy `.get_info()` — except `fund_summary`/`fundamentals`, which do use it, mitigated by a 7-day cache). Prices are daily closes fetched with **`auto_adjust=False`** (raw, not split-adjusted).
- **FX:** `frankfurter.app` (ECB reference rates), CHF base. Degrades to `1.0` on an unresolved pair (a real hazard — §17, §23).
- **Fundamentals:** `yfinance` `get_info()` + `income_stmt` (annual), cached 7 days.
- **ETF holdings:** `yfinance` `funds_data.top_holdings` — **top ~10 only**; no full constituent source exists.
- **Ownership / cash / dividends:** derived entirely from the two DEGIRO CSVs (`docs/DATA_MODEL.md`).
- **News:** Yahoo RSS, 30-min cache.

---

## 7. Financial Data Model

Fully documented in `docs/DATA_MODEL.md`. Essentials:

- **Two source files:** `Transactions.csv` (security trades; ISIN is the primary key; `Wert CHF`/`Gesamt CHF` are **already CHF** at trade-time FX, so trade cost basis is stored in CHF and FX is **never re-applied to a trade**) and `Account.csv` (cash movements; dividends are the **source of truth**, keyed on ISIN).
- **Cash (canonical):** `deposits + net dividends − fees + net FX`, **excluding `cash_sweep`** (an internal transfer between DEGIRO's settlement account and the flatex Geldkonto — both are the holder's cash).
- **Ownership:** net signed quantity of non-corporate trades.
- **Minor currency units:** Yahoo quotes UK lines in **GBp (pence)**; normalised ÷100 to GBP at the provider boundary — **but see §17 for paths where this normalisation is missing.**
- **Instrument `kind`** ∈ {stock, etf} from Yahoo `quoteType`. Delisted/unresolved (`symbol == isin`) instruments keep cost/realised history but are excluded from live valuation.

---

## 8. Financial Metrics (what is measured, and from where)

All metrics originate from the `yfinance` snapshot (`yfinance_provider.py:206-307`). Units as consumed:

| Metric | Unit | Source field | Notes |
|---|---|---|---|
| trailing/forward EPS | per-share, **reporting** ccy, annual | `trailingEps`,`forwardEps` | **not** minor-unit normalised (§17 DQ-2) |
| ROE, margins, payout, growth | decimal fraction | `returnOnEquity`,`profitMargins`,`payoutRatio`,`revenueGrowth`,`earningsGrowth` | `earningsGrowth` falls back to **quarterly** YoY |
| priceToBook | ratio | `priceToBook` | computed by provider vs its own (stale) price |
| dividendYield | **ambiguous** (fraction vs percent) | `dividendYield` | version-dependent; heuristic normalisation (§8, DQ-7) |
| totalDebt, ebitda, netIncome | absolute currency | `totalDebt`,`ebitda`,`netIncomeToCommon`,`income_stmt` | revenue/income in `financialCurrency`, marketCap in trading ccy (mixed) |

---

## 9. Formula Catalog

All formulas transcribed from code. `r` = discount rate, `g` = growth, `tg` = terminal growth.

### 9.1 Graham Number — `valuation.py:207-208`
`grahamNumber = round(sqrt(22.5 · eps · bvps), 2)` for `eps>0, bvps>0`, where `bvps = price / priceToBook`.
**Inputs:** trailing EPS (reporting ccy); bvps reconstructed from **live price ÷ stale priceToBook**. **[Technical P2]** bvps drifts with price (`valuation.py:203`). **[Financial P3]** 22.5 constant applied to all sectors.

### 9.2 Graham Growth (1974) — `valuation.py:209-210`
`grahamGrowth = round(eps · (8.5 + 2·min(max(g·100,0),15)), 2)` (multiple caps at 38.5× at g=15%). **[Financial P2]** omits Graham's `×4.4/Y` interest-rate normalisation → overstates value in high-rate regimes.

### 9.3 Two-stage owner-earnings DCF — `_dcf`, `valuation.py:94-107`
```
if cap: g = clamp(g, 0, 0.15)
if g >= r: g = r - 0.001            # ← growth cliff (P1)
pv = Σ_{yr=1..10} eps·(1+g)^yr / (1+r)^yr
terminal = eps10·(1+tg)/(r-tg)
dcf = pv + terminal/(1+r)^10
```
Defaults `r=0.09, tg=0.025, years=10` → terminal ≈ 15.8× year-10 EPS. `base_eps = trailing else forward`. "Owner earnings" ≈ accounting EPS (no capex/working-capital adjustment).

### 9.4 Intrinsic range, Fair Value, Margin of Safety — `valuation.py:215-221`
`vals = sorted(positive model values)`; `intrinsic.mid = vals[len(vals)//2]`; `fairValue = intrinsic.mid`; `marginOfSafety = fair/price − 1`.
**[Technical P1]** `mid` is **median by index** — with two surviving models it selects the **maximum**, biasing fair value up (and suppressing sell signals). **[Financial P3]** MoS denominator is **price**, not fair value (differs from the classical Graham MoS).

### 9.5 Fair-value bands / zones — `classify_band`, `valuation.py:38-73`
`entry = fair·(1−0.30)`, `overvalued ≥ fair·1.20`, `sellZone ≥ fair·1.40`. `premiumToFair = price/fair − 1`. Sell-zone upper chart edge `sig·1.6` is an arbitrary shading constant.

### 9.6 Growth estimate — `_pick_growth`/`_hist_income_cagr`, `valuation.py:84-127`
Candidates = [hist income CAGR (first vs last point only), revenueGrowth if |·|≤0.5, earningsGrowth if |·|≤0.5]; picks `candidates[len//2]` (**index-median → higher of two**). **[Financial P2]** revenue used as proxy for earnings; quarterly growth used as annual; endpoint-only CAGR.

### 9.7 Supportable return & dividend yield — `valuation.py:197-198,258`
`dy = (dy/100) if dy>1 else dy`; `supportableReturn = (g or 0) + (dy or 0)`. **[Technical/Financial P1]** the `dy>1` heuristic misclassifies sub-1% yields (0.9 → kept as 90%).

### 9.8 Implied growth (reverse DCF) — `_implied_growth`, `valuation.py:167-181`
Bisection on `[-0.10, 0.40]` solving `_dcf(eps, g, cap=False) = price`. **[Technical P1]** `_dcf` still applies `g≥r → r−0.001`, so above the discount rate every guess returns the same value → the search **saturates to ~0.40** for any richly-valued name.

### 9.9 Buffett quality scorecard (6 checks) — `valuation.py:229-241`
ROE≥15%, net margin≥10%, `g>0`, **Debt/EBITDA≤3**, 0≤payout≤70%, hist CAGR>0. Score/6.
**[Technical/Financial P0]** `de = debt/ebitda if (debt and ebitda…)` → a **debt-free company (`totalDebt==0`) yields `de=None` and FAILS** the leverage check. The safest balance sheets score 0 on leverage, depressing quality → verdict and attractiveness for the best names.

### 9.10 Counterfactual (opportunity cost) — `counterfactual.py:66-197`
Mirror each buy's CHF outflow into the benchmark ETF at the buy-date price; roll forward with distributions (taxed), accumulating-fund income drag, and wealth tax; `delta = actualValueCHF − counterfactualValueCHF`. Total-return basis.

### 9.11 XIRR — `finance_math.py:32-81`
Newton (100 iters, tol 1e-8) → bisection on `[-0.9999, 10]`; day-count **365**. `benchmarkXirr`/`actualXirr`; portfolio return = money-weighted XIRR over after-tax flows.

### 9.12 CAGR — `finance_math.py:84-87`
`(end/start)^(1/years) − 1`, `None` if any of start/end/years ≤ 0. **[Financial P3]** total-loss → `None`, then substituted downstream by *positive* fallbacks.

### 9.13 `benchmark_cagr` — `projection.py:12-20`
10-y trailing CAGR of **closes only** (price return). **[Financial P1]** dividend-blind, yet is the forward growth assumption for projection/decision/plans/whatif.

### 9.14 Forward projection — `projection.py:40-112`
Monthly compounding of hold vs ETF at fixed CAGR (defaults `stock 0.07`, `etf 0.05`), horizon 5y, first crossover month. **[Financial P1]** deterministic single-point extrapolation, no downside/scenario.

### 9.15 Portfolio exposure / concentration — `exposure.py`
Value-weighted geo/sector rollup; `HHI = Σ weightᵢ²` on **normalised bucket** weights; overlap = `Σ min(w_a,w_b)`.

### 9.16 Portfolio-fit indirect exposure — `fit.py:41-49`
`indirect = Σ_owned-ETFs (holdingPercent × etfPortfolioWeight)`; `effective = direct + indirect`. Bounded by top-~10 holdings.

### 9.17 Screener attractiveness (0–100) — `screener.py:55-62`
`val_score = clamp(mos,−0.5,0.5)+0.5` (else 0.3); `ret_score = clamp(supportable/0.15,0,1)`; `score = 0.45·val + 0.30·quality_frac + 0.20·ret + 0.05·fit`. **[Financial P2]** arbitrary weights/anchors; fit only 5%.

### 9.18 Opportunity-map density — `screener.py:209`
`density = attractiveCount · (1 + avgMarginOfSafety)`, attractive ≡ `verdict=="buy-more"`.

---

## 10. Valuation Engine

**[CURRENT]** `services/valuation.py` blends three models (Graham number, Graham growth, two-stage DCF) into an intrinsic **range**, takes the index-median as `fairValue`, classifies price into bands (undervalued / fair / overvalued / significantly-overvalued), and attaches a 6-check quality scorecard and a confidence read. All knobs (discount 0.09, terminal growth 0.025, DCF years 10, growth cap 0.15, MoS 0.30, overvalued 0.20, sell 0.40) are user-configurable (`reference/defaults.py`, `Settings` modal).

**Material issues (see §9 for formulas):** the debt-free-fails-leverage inversion (9.9, **P0**), the EPS-reporting-ccy vs price-trading-ccy mismatch with **no FX conversion** (§17, **P0** for cross-listed names), the DCF growth cliff (9.3, **P1**), the reverse-DCF saturation (9.8, **P1**), the index-median-picks-max bias (9.4, **P1**), and the dividend-yield unit heuristic (9.7, **P1**). Confidence is only *demoted*, never a floor — a single-model, low-confidence fair value still drives categorical bands and Sell verdicts. The reported `assumptions` block echoes the module constants and **ignores user overrides** (`valuation.py:260`, **P2**).

**[RECOMMENDED]** average/interquartile fair value instead of index-median; convert EPS↔price via FX; treat debt-free as passing (or n/a) on leverage; fix the DCF to represent g≥r via a two-stage taper; make reverse-DCF search meaningful only below r; verify the `dividendYield` unit against the pinned yfinance version; add a confidence floor on the Sell path; widen bands by confidence.

---

## 11. Value-Investing Methodology

**[CURRENT]** The value-investing lens is implemented as: intrinsic value (Graham + DCF), margin of safety (`fair/price − 1`), a 6-point quality gate (ROE, margin, earnings growth, leverage, payout, long-run trend), and a "supportable return" (growth + yield). Undervalued **and** quality-strong (≥3/6 checks and earnings not deteriorating) → Buy more; undervalued but weak → Hold with a value-trap caution; sell-zone → Sell. Benchmark underperformance **never** forces a Sell (verified: `verdict.py:145-149,181-184`).

**Weaknesses:** the "strong fundamentals" bar is **3/6 checks** (`STRONG_QUALITY_FRAC=0.5`, **P2**) — lenient; missing quality data is **mislabelled a value trap** (P2); the quality checks are equally-weighted binaries with no FCF, interest-coverage, moat, or consistency dimension; "owner earnings" is accounting EPS. It is a reasonable *lightweight* value screen, not a Buffett-grade business analysis.

---

## 12. Forecasting Engine

**[CURRENT]** Every forward-looking number is a **deterministic single point**. Growth inputs come from either a 10-year trailing **price-return** CAGR (`benchmark_cagr`) or fixed constants (`stock 0.07`, `etf 0.05`, `whatif 0.06`). Horizons: projection 5y, DCF 10y, period returns 1/2/3/5y + holding. There is **no uncertainty band, no bull/base/bear, no mean-reversion, no scenario analysis** anywhere.

**Material issues:** forward growth is **dividend-blind price-return** while the backward counterfactual is **total-return** — an apples-to-oranges seam (**P1**); past CAGR is extrapolated indefinitely (**P1**); `recoveryMonths` in the counterfactual fires only when the position is *already ahead* of the ETF — mislabelled/inverted semantics (**P2**); recovery/reinvest targets default to *nominal invested capital* so any winner "recovers instantly" (**P2**); reinvest combos pick the **highest-backtest-CAGR** alternatives and equal-weight them with no correlation/risk (**P2**).

**[RECOMMENDED]** use total-return CAGRs consistently; present ranges (e.g. ±1σ or explicit bear case); label every forecast's basis; fix `recoveryMonths` semantics.

---

## 13. Recommendation Engine (Decision Logic Catalog)

**[CURRENT]** One engine, `services/verdict.py::resolve_verdict`, consumed by every surface. Canonical key ∈ `{buy-more, hold, sell}`; ownership-aware label via `_action_for`.

| Verdict key | Condition (`verdict.py:157-178`) | Owned label | Not-owned label |
|---|---|---|---|
| `sell` | band = significantly-overvalued (price ≥ fair·1.40) | **Sell** | **Avoid** |
| `hold` + trimNote | band = overvalued (fair·1.20 ≤ price < fair·1.40) | **Reduce** | **Watch** |
| `buy-more` | band = undervalued **and** quality ≥ 3/6 & trend≠deteriorating | **Buy more** | **Buy** |
| `hold` (value-trap) | band = undervalued **and** weak/missing quality | **Hold** | **Watch** |
| `hold` | band = fair, or no band | **Hold** | **Watch** |

Thresholds: `STRONG_QUALITY_FRAC=0.5`, `PERF_BAND=±0.04`. Benchmark performance only tips `conflictNote`/confidence, never the key. After-tax framing computed only on Sell.

**Material issues:** low-confidence single-model fair value can still force a categorical **Sell** (no confidence floor, **P1**); hard band cliffs → a 0.01% price move flips Reduce↔Sell (**P2**); missing-quality → asserted value trap (**P2**); the concentration trim in `recommend.py:139` is added *after* the action label is fixed, so a concentrated Hold keeps the "Hold" label while carrying a trim note (**P2**); `earnings_trend` is coupled to valuation check labels by exact string match (**P2**).

---

## 14. Ownership Logic

**[CURRENT]** `repo.owned_symbol_set()` (`repo.py:47-59`):
```sql
SELECT i.symbol, SUM(CASE t.action WHEN 'buy' THEN t.quantity WHEN 'sell' THEN -t.quantity ELSE 0 END) AS net
FROM instruments i JOIN transactions t ON t.instrumentId=i.id WHERE i.symbol IS NOT NULL GROUP BY i.symbol
```
Owned ⇔ net > 1e-9. Offline, keyed on **symbol**. Correctly excludes fully-sold (net 0) and zero-qty. Consumers pass `held`: screener `sym in owned`; research `symbol in owned`; portfolio/position/decisions/advisory hardcode `held=True`; watchlist hardcodes `held=False`.

**Material issues:**
- **[Financial P1] Cross-listing blind spot.** Ownership is by exact symbol, not ISIN/company. If the user holds `NESN.SW` but the screener/research line is `NSRGY`, `held=False` → the app shows **"Buy"** for a company already owned — precisely the "don't treat an owned asset as un-owned" principle the ownership feature exists to enforce. Not ISIN-normalised.
- **[Financial P2]** Only `buy`/`sell` actions count; transfers/corporate-action deliveries contribute 0 → a position acquired via a non-buy action reads not-owned. (Which action strings the importer emits: **verify**.)
- **[Technical P2]** A watchlisted-and-owned symbol is mis-worded (`held=False`).
- **[Technical P3]** Unresolved rows (`symbol==isin`) with net>0 can enter the owned set under their ISIN-as-symbol.

---

## 15. Portfolio Analysis

**[CURRENT]** `exposure.py` value-weights each holding's allocation by current CHF market value into geo/sector rollups, with a Herfindahl concentration score and `topHoldingWeight`. `universal.py` computes money-weighted portfolio XIRR (the raw value series is contribution-inflated, used only for vol/drawdown), annualised volatility (monthly → ×√12, rf=0), Sharpe, and max drawdown.

**Issues:** HHI is computed on **normalised bucket** weights (0..1), so a diversified single-country book still reads country-HHI 1.0 — only `topHoldingWeight` reflects name concentration (**P2**); portfolio Sharpe divides a money-weighted return by a vol from the contribution-inflated path — mismatched concepts (**P2**); diversification is **sector-membership only** (no correlation/factor/size).

---

## 16. ETF Exposure & Overlap — the central limitation

**[CURRENT]** ETF composition comes **only** from the provider's `funds_data.top_holdings` (~top 10 names) plus fund-complete `sector_weightings` (`allocation.py:60-91`). There is **no full ETF constituent dataset anywhere in the codebase.** Consequences:

- **[Financial P1]** An ETF's **country** breakdown is rebuilt from ~10 holdings summing to well under 100%, then silently re-normalised by `exposure._merge` as if complete — it **understates geographic breadth**. (Sector weights are trustworthy; country weights are not — an inconsistency not surfaced.)
- **[Financial P1]** `fit.py` indirect exposure is `holdingPercent × etfWeight` over top-10 only. `indirect.available=false` means "not in any owned ETF's top-10" — **not** "no exposure." A name held at 0.5% inside a broad ETF is invisible here; a UI treating `available:false` as zero overlap would be wrong.

**[RECOMMENDED]** integrate a real constituent source (index-provider or fund-issuer holdings files) before trusting any overlap/indirect/effective-exposure number; until then, label these figures "top-holdings only" everywhere (the backend does; ensure the UI does too).

---

## 17. Data Quality (foundation)

Full catalog in §23. Highest-severity data issues (`file:line` in §28):

- **[Financial P0] Minor-unit normalisation missing on the history/fundamentals/fund paths.** `price_on`/`get_history` return **raw pence closes** (`marketdata.py:104-114`) while the currency multiplied against them is normalised to GBP — so GBp-listed instruments/benchmarks value **~100× too high** in counterfactual/whatif/plans (`counterfactual.py:36-40`, `whatif.py:87-95`, `plans.py:28-36`). The `fundamentals`/`fund_summary` price fields (marketCap, EPS, 52-wk, target) are likewise un-normalised (`yfinance_provider.py:185-193,233,240-262`). *Whether the specific `.L` benchmarks cache in pence: verify — the code path is unguarded either way.*
- **[Financial P0] FX degrades to 1.0** on any unresolved/uncovered pair (`fx.py:119`) — silent 1:1 conversion, ~100× when a raw minor-unit currency reaches it, with no distinct error signal.
- **[Financial P0] No split adjustment.** History is fetched `auto_adjust=False`; the `Stock Splits` column is fetched but never read (`yfinance_provider.py:83,106`). A raw close steps discontinuously across a split while quantity stays flat → corrupted value series/returns unless the user hand-adjusted quantity.
- **[Financial P1] `dividendYield` percent-vs-decimal ambiguity** (`yfinance_provider.py:242`) — version-dependent; feeds income/yield estimates and attractiveness. **Verify against the pinned yfinance version.**
- **[Financial P2] Wrong-share-class risk for non-curated ISINs** (`resolution.py`) — the curated seed prevents the known Swatch/UBS bearer-vs-registered bugs; any ISIN not in the seed can silently resolve to the wrong class (mitigated by the executed-price integrity guard, `price_integrity.py`, ratio > 2.0× → flagged).
- **[Financial P2] Currency defaults to USD** on quote failure (`yfinance_provider.py:119`) and manual-ticker resolution hardcodes USD/stock until a quote populates (`resolution.py:102-106`).

**Strong defences (for balance):** minor-unit normalisation *is* correct and idempotent on the core quote path; the executed-price integrity guard is a genuine ground-truth defence against wrong-instrument resolution; stale-while-revalidate + cooldowns keep the request path off the provider.

---

## 18. Discover

**[CURRENT]** `screener.py` screens `seed ∪ holdings ∪ watchlist` (**seed = 156 tickers** across CH/US/EU/Asia/ETFs, `reference/universe.py`), scoring **only names whose fundamentals are already cached**. Each row gets attractiveness (0–100, §9.17), the canonical verdict (ownership-aware), portfolio-fit status, and mover flags. No server-side attractiveness threshold — all scored rows returned; filtering is client-side.

**Issues:** cached-only scoring means the universe is **de-facto cache-gated** — a fresh install screens almost nothing until the warmer fills fundamentals (**P2**); attractiveness weights are arbitrary and fit is only 5% of rank (**P2**); the Discover globe recomputes density client-side (`verdict==='buy-more'`) and rebuilds on every filter drag (**P3**).

---

## 19. Opportunities (screener warmer + scan)

**[CURRENT]** A resumable, throttled background warmer (`screener_warm.py`, 3 workers, single-flight) fetches missing fundamentals; the 6-hourly scan (`scan.py`) warms 40 names/run and diffs against the previous snapshot to flag freshly-attractive not-owned names + price-drop movers, firing notifications. The seed fully warms in ~1 day.

**Issue — the "infinite loading" mechanism (P2):** un-fetchable symbols (delisted, permanently rate-limited, provider-rejected) stay permanently `missing`, retried every warm; `coverage.missing` never reaches 0, so a coverage-gated "N/M fundamentals loaded" UI can spin indefinitely for the un-fetchable tail. There is **no negative-cache/dead-letter** for repeatedly-failing fundamentals (contrast the quote path's `quote_cooldown_ms`). **[RECOMMENDED]** add a fetch-attempt cooldown for fundamentals.

---

## 20. Opportunity Map

**[CURRENT]** `_geo_density` (`screener.py:168-213`): per country, `attractiveCount` = names with `verdict=="buy-more"`, `density = attractiveCount·(1+avgMarginOfSafety)`; the frontend globe derives its own density from the returned rows (backend geo used only for centroids/names). Counts are derived from the live filtered dataset, not hard-coded.

**Issues:** density multiplicatively conflates breadth and discount (2 deeply-cheap names can outrank 5 modestly-cheap ones; 0 attractive → density 0 regardless of total) (**P3**); country attribution via symbol suffix/ISIN defaults suffixless ADRs to US (**P3**).

---

## 21. Decisions

**[CURRENT]** `recommend.py` ranks every held position Buy/Hold/Sell (via the shared engine, `held=True`) by CHF at stake, adds a reinvest target on Sell, a concentration trim over 25% weight, and an idle-cash Buy signal over CHF 1000. `decision.py` provides recovery-time and a sell→reinvest simulator.

**Issues:** `reallocatableCHF` sums the after-tax **gain**, not freed capital (~proceeds) — a mislabelled headline (**P1**); `totalOpportunityCostCHF` over sells is semantically inverted (overvalued winners usually beat the benchmark → negative) (**P2**); the concentration trim label/verdict disagree (**P2**); `CONCENTRATION_WEIGHT=0.25` and `CASH_DEPLOY_MIN_CHF=1000` are arbitrary and unconfigurable (**P3**).

---

## 22. Cross-Feature Consistency

| A | B | Conflict | Root cause | Impact | Priority |
|---|---|---|---|---|---|
| Discover verdict | Decisions verdict | Same owned symbol, different verdict | Discover values at cached historical close (`screener.py:92`); Decisions at live position price (`recommend.py:116`) — hard band cliffs straddle a boundary | Contradictory Buy/Hold/Sell on two screens | **P1** |
| Export/PDF | On-screen analysis | Different opportunity-cost number | `ShareModal` fetches with **no benchmark, no preTax** (`ShareModal.tsx:36-39`) while the page honours the store | Shared document contradicts the screen | **P2** |
| Decisions "why" chart | Position counterfactual | Different delta | "why" fetched after-tax always (`Decisions.tsx:20-22`) | Same pair, different numbers | P3 |
| Deep link `#/position/5` | Original view | Recipient sees different basis | Router encodes only view/id, not benchmark/preTax | Shared link renders at after-tax + default benchmark | P3 |
| Verdict badge | SellSignalPanel | "Hold" above "Overvalued — trim" | `SellSignalPanel` renders for overvalued (non-sell) too | Adjacent panels read differently (intended trim, but confusing) | P2 |
| Advisory reallocation figure | Advisory verdict | Big "would've made CHF X more" vs "Buy more" | Reallocation vs **worst** benchmark; verdict vs **default** benchmark (`advisory.py:62-90`) | Cognitive dissonance (documented as intentional) | P2 |
| `premiumToFairPct` | other percents | 100× trap for new consumers | This field is a 0–100 percent while nearly every other percent is a fraction (`format.ts fmtPct` assumes fractions) | Latent: any new consumer piping it through `fmtPct` is off 100× | P3 |

**Verdict key never diverges** (one engine); confidence, wording, and the underlying price/band **can**.

---

## 23. Data Source Catalog

| Provider | Purpose | Access | Fields | Update / TTL | Currency | Limitations |
|---|---|---|---|---|---|---|
| yfinance quote | last price | `fast_info`+`history_metadata` | price, currency, name | `quote_cache` 1h, stale-while-revalidate | trading (minor-unit normalised) | defaults USD on failure |
| yfinance history | daily closes + dividends | `Ticker.history(auto_adjust=False)` | Close, Dividends | `price_cache`/`dividend_cache` by date; backfill >3d | listing | **raw closes on read (not normalised on this path); no split adjust** |
| yfinance fundamentals | valuation inputs | `get_info()`+`income_stmt` (annual) | EPS, ROE, margins, debt, ebitda, growth, yield | `fundamentals_cache` 7d | mixed (trading + financialCurrency) | **price fields not minor-unit normalised**; dividendYield unit ambiguous |
| yfinance fund_summary | profile + ETF top-10 | `get_info()`+`funds_data` | topHoldings(~10), sectorWeightings, profile, price | `fund_cache` 7d | trading | **top-10 only; price not normalised** |
| frankfurter | FX→CHF | REST | ECB daily rates | `fx_cache` by date (never expires) | — | **degrades to 1.0 on unresolved pair** |
| Yahoo RSS | news | REST | headlines | `news_cache` 30min | — | never raises |
| DEGIRO CSVs | ownership/cash/dividends | file import | trades, account events | on import | CHF (broker-converted) | partial windows possible |
| curated ISIN seed | resolution | `reference/isin_map.py` | ISIN→ticker | static | — | non-seed ISINs risk wrong class |

Unused config surface: `core/cache.py` (TTLCache/Redis) is **not wired** into the market-data path; `cache_ttl_fx` is defined but unreferenced.

---

## 24. Mathematical Audit

- **Percent vs decimal:** margins/ROE/growth are fractions (correct); `dividendYield` is heuristically normalised and **breaks below 1%** (§9.7, P1); `premiumToFairPct` is a 0–100 percent (100× trap for new consumers, §22, P3); `fmtPct` assumes fractions.
- **CAGR:** `(end/start)^(1/years)−1` with positive-only guards → total losses become `None`, then replaced by *positive* fallbacks downstream (§9.12, P3).
- **XIRR:** 365-day count (vs 365.25 elsewhere); bisection bracket `hi=10` < clamp `100` (rates in (10,100] unreachable via bisection) (P3).
- **Median:** `vals[len//2]` is an **index-median**, not a midpoint/average — picks the **max** with two items (fair value & growth biased up) (§9.4/§9.6, P1).
- **Division by zero:** valuation/exposure/counterfactual guard denominators; the counterfactual silently drops a mirrored buy or zeroes terminal value when an ETF has no cached price that day (P3).
- **Rounding:** applied at output; no evidence of round-before-calculate errors.
- **Currency:** the dominant math risk — mixed reporting/trading currencies in valuation and un-normalised pence in the history path (§17, P0).
- **Annualisation:** vol = monthly σ × √12 with rf=0; Sharpe mixes a money-weighted numerator with a contribution-inflated-path vol (P2).

---

## 25. Financial Logic Audit

- Undervaluation drives Buy but the **quality gate is lenient (3/6)** and **debt-free fails leverage** (P0) — so the gate can both over-admit weak names and penalise the strongest.
- Fair value from three models is reasonable, but the **index-median-picks-max** bias and **no confidence floor** mean overvaluation under-fires and Sell can trigger on thin evidence.
- Forecasting is **deterministic and price-return-based** — no downside, no total return, no scenarios; combos "chase the best backtest."
- Portfolio construction sees **sector membership, not correlation**, and ETF overlap only to top-10.
- Opportunity cost (the app's core) is **methodologically the strongest part**: total-return, after-tax, same tax settings both sides — but inherits the currency/units P0s.

---

## 26. Hidden Assumptions (with locations)

| Assumption | Value | Location | Note |
|---|---|---|---|
| Discount rate | 0.09 | `valuation.py:14` / settings | user-editable; but `assumptions` output ignores overrides |
| Terminal growth | 0.025 | `valuation.py:15` | terminal ≈ 15.8× yr-10 EPS |
| DCF years / growth cap | 10 / 0.15 | `valuation.py:16-17` | growth cliff at g≥r |
| Margin of safety | 0.30 | `valuation.py:21` | undervalued = fair·0.70 |
| Overvalued / sell premium | 0.20 / 0.40 | `valuation.py:22-23` | hard band cliffs |
| Strong-quality fraction | 0.5 (3/6) | `verdict.py:30` | lenient buy gate |
| Perf band | ±0.04 | `verdict.py:32` | inline vs out/under-perform |
| Attractiveness weights | 0.45/0.30/0.20/0.05 | `screener.py:61` | arbitrary; fit only 5% |
| MoS clamp / return ceiling | ±0.5 / 0.15 | `screener.py:59-60` | tails hidden |
| Concentration / cash-deploy | 0.25 / CHF 1000 | `recommend.py:37,39` | unconfigurable |
| Forward stock/etf/whatif CAGR | 0.07 / 0.05 / 0.06 | `projection.py:56-57`,`whatif.py:162` | fixed fallbacks |
| Default ETF income yield | 0.018 | `defaults.py:11` | tax drag |
| Marginal income / wealth / withholding | 0.30 / 0.003 / 0.35 / US 0.15 | `defaults.py` | Swiss defaults (see `docs/TAX-MODEL.md`) |
| Capital gains taxable | false | `defaults.py:6` | flips the whole thesis if true |
| Integrity ratio tolerance | 2.0× | `price_integrity.py:26` | wrong-instrument guard |

---

## 27. Known Limitations

1. **No full ETF constituent data** — overlap/indirect bounded by top-10 (§16).
2. **No split adjustment** on cached closes (§17).
3. **Deterministic forecasts** — no ranges/scenarios (§12).
4. **Cache-gated screener** — cached-only eligibility; ~1 day to warm the seed (§18–19).
5. **Single-provider (yfinance)** — rate-limited; degrades to stale; wrong-class risk for non-curated ISINs.
6. **Sector-only diversification** — no correlation/factor/size.
7. **Ownership by symbol, not ISIN/company** — cross-listing blind spot (§14).
8. **Tax model is a single-marginal-rate approximation** — no progressive brackets, canton detail, or reclaim time-value (`docs/TAX-MODEL.md` §9).
9. **Partial DEGIRO exports** can under-report cash/dividends (a data-window issue, not a code bug).

---

## 28. Potential Logical / Mathematical Errors (consolidated register)

Deduplicated across all subsystems, most severe first. Tags: **[T]** technical, **[F]** financial.

| # | Sev | Tag | Issue | Location |
|---|---|---|---|---|
| 1 | **P0** | F/T | Debt-free company **fails** Debt/EBITDA quality check → best balance sheets score 0 on leverage → depresses verdict/attractiveness for the safest names | `valuation.py:232,238` |
| 2 | **P0** | F/T | Un-normalised pence closes on `price_on`/`get_history` × normalised FX → ~100× inflation in counterfactual/whatif/plans; fundamentals/fund price fields un-normalised | `marketdata.py:104-114`; `counterfactual.py:36-40`; `whatif.py:87-95`; `plans.py:28-36`; `yfinance_provider.py:185-193,233-262` |
| 3 | **P0** | F | FX degrades to `1.0` on unresolved pair — silent 1:1 (~100× with minor units) | `fx.py:119` |
| 4 | **P0** | F | No split adjustment (`auto_adjust=False`, splits fetched but discarded) → corrupted price series/returns across splits | `yfinance_provider.py:83,106` |
| 5 | **P0** | F/T | EPS (reporting ccy) valued against price (trading ccy) with **no FX** → cross-listed/ADR fair value, bands, MoS, sell signals wrong by the FX rate | `valuation.py:184,203,211,227` |
| 6 | **P1** | T | `fairValue`/growth use **index-median → the max** with two models → fair value biased up, sell signals suppressed | `valuation.py:218,126` |
| 7 | **P1** | F/T | DCF growth cliff: every 9–15% grower modelled at 8.9% | `valuation.py:98-101` |
| 8 | **P1** | T | Reverse-DCF (`impliedGrowth`) saturates to ~0.40 above the discount rate | `valuation.py:167-181` |
| 9 | **P1** | T/F | `dividendYield` unit heuristic breaks sub-1% yields (0.9 → 90%) → feeds `supportableReturn`/attractiveness | `valuation.py:198` |
| 10 | **P1** | F | Forward growth = 10y **price-return** CAGR (dividend-blind) driving all projections; backward counterfactual is total-return (seam) | `projection.py:12-20` + consumers |
| 11 | **P1** | F | Forward projections extrapolate past CAGR deterministically; no downside/scenario | `projection.py:97-112`; `whatif.py:160-182` |
| 12 | **P1** | F | Cross-listing ownership blind spot → owned name reads "Buy" not "Buy more" | `repo.py:52,57`; `screener.py:111`; `research.py:76` |
| 13 | **P1** | F | Low-confidence single-model fair value forces categorical Sell (no confidence floor) | `verdict.py:157-159`; `valuation.py:215-221` |
| 14 | **P1** | T | Discover vs Decisions value same symbol at different prices → verdict flips at band cliffs | `screener.py:92` vs `recommend.py:116` |
| 15 | **P1** | F | `reallocatableCHF` sums after-tax **gain**, mislabelled freed capital | `recommend.py:160,207,215` |
| 16 | **P1** | F | ETF overlap/indirect exposure limited to top-~10; `available:false` ≠ zero exposure | `allocation.py:60-91`; `fit.py:47,76-83` |
| 17 | P2 | T | PositionDetail `cf.data!` non-null → page crash if counterfactual errors | `PositionDetail.tsx:138` |
| 18 | P2 | F/T | Share/Export drops active `benchmark`/`preTax` → document contradicts screen; portfolio PDF chart capture targets non-existent `export-chart` id → chart omitted | `ShareModal.tsx:36-39`; `exporters.ts:162` |
| 19 | P2 | F | Only buy/sell actions count toward ownership | `repo.py:53-54` |
| 20 | P2 | F | `STRONG_QUALITY_FRAC=0.5` (3/6) → auto Buy more; missing quality → mislabelled value trap | `verdict.py:30,142,172-174` |
| 21 | P2 | T | Possible dividend double-count (tx + account statement) | `counterfactual.py:237-268` |
| 22 | P2 | F | `recoveryMonths` fires only when already ahead of the ETF (inverted) | `counterfactual.py:175-182` |
| 23 | P2 | F | Recovery/reinvest target = nominal invested → winners "recover instantly"; combos chase highest backtest, equal-weight, no correlation | `decision.py:90,112-126,179` |
| 24 | P2 | T | Fundamentals never negative-cached → coverage may never hit 100% → perpetual "loading" tail | `screener_warm.py:100-104`; `scan.py:149` |
| 25 | P2 | T | Portfolio Sharpe = money-weighted return ÷ contribution-inflated-path vol | `universal.py:151` |
| 26 | P2 | F | HHI on normalised bucket weights (single-country diversified book reads HHI 1.0) | `exposure.py:44-46` |
| 27 | P2 | T | `assumptions` output ignores user overrides | `valuation.py:260` |
| 28 | P2 | T | "Today's P/L" coupled to selected chart range | `Dashboard.tsx:103-106` |
| 29 | P2 | T | Watchlist "alerted" tick shared-mutation (only last shows) | `Watchlist.tsx:137` |
| 30 | P2 | T | Manual ticker → hardcoded USD/stock; quote failure defaults USD | `resolution.py:102-106`; `yfinance_provider.py:119` |
| 31 | P2 | T | Plans reprice targets with hardcoded USD fallback | `plans.py:70,145` |
| 32 | P3 | — | Many: geo-density formula, sell-zone 1.6 constant, MoS denominator naming, day-count 365 vs 365.25, stamp duty absent from opportunity-cost paths, reclaim time-value unmodeled, Google URL exchange for NYSE/`BRK.B`, shareImage locale, dead modal kinds (`scenario`/`plan-compare`), listings TTL doc mismatch, `build_position` CAGR start = gross buys | see subsystem sections |

**Resolution status (Engine 2.0, 2026-08-28)** — see §0 and `VALUE_INVESTING_AUDIT.md`:
- ✅ **Resolved:** #1 (debt-free leverage), #3 (FX silent 1.0 → `resolve_fx`/`strict`),
  #6 (median-picks-max), #7 (DCF cliff), #8 (reverse-DCF saturation), #9 (dividend-yield unit,
  verified percent), #12 (cross-listing ownership → ISIN), #13 (low-confidence Sell floor).
- ◑ **Partially resolved:** #2 (history path already normalised; fundamentals **EPS** now
  minor-unit normalised — other display price fields still raw); #5 (minor-unit part done;
  reporting↔trading FX **deferred**, semantics unverified); #16 (indirect exposure now honest
  "top-holdings-only" + a distinct fit layer, but still bounded by top-10 — a real constituent
  source is still needed).
- ✅ **Also resolved:** #10 (total-return forward CAGR), #11 (`prospective_projection` now
  returns a bear/base/bull `holdRange`), #14 (Discover values at the same resolved price as
  Decisions), #15 (`reallocatableCHF` = freed capital, not gain), and #5 (**verified non-issue**
  — EPS is in trading currency; no FX needed).
- ○ **Still open:** #4 (split adjustment — deferred, data-dependent/risky), the full-ETF
  constituent source behind #16, band-edge hysteresis, and the P2/P3 tail.

**Items verified live during the redesign:** yfinance 1.6.0 `dividendYield` is a **percent**
(÷100); `funds_data` `holdingPercent` is a **fraction**; cash-flow/balance-sheet row labels
confirmed. Still requiring verification: whether `.L` fundamentals arrive in pence, and whether
the importer emits non-buy acquisition actions.

---

## 29. Missing Professional Capabilities

### Critical (could change conclusions)
- **Full ETF constituent data** for real overlap/indirect exposure (§16).
- **Split adjustment** and **currency-consistent valuation** (data-integrity prerequisites).
- **Downside / bear-case valuation** and forecast **ranges** (replace single-point determinism).
- **Total-return** forward assumptions (remove the price/total-return seam).

### High
- Correlation/factor-based diversification (beyond sector membership).
- Confidence-weighted verdicts (floor on Sell; band widening by confidence).
- FCF quality, interest coverage, dilution/buyback, and earnings-consistency in the quality scorecard.
- Historical valuation range / percentile (is today cheap *for this business*?).
- ISIN/company-normalised ownership across listings.

### Medium
- Scenario/sensitivity tables on discount rate & growth.
- Sector-specific valuation (financials/REITs/utilities are penalised structurally).
- Position sizing / rebalancing suggestions; risk-adjusted expected return in ranking.
- Analyst-estimate revisions, insider ownership/transactions.

### Nice to have
- Benchmark-relative valuation, factor exposure, country/rate/inflation sensitivity, dividend-sustainability scoring.

---

## 30. Professional Investment Assessment

### What DecisionGuru does well
- A **coherent, single-engine architecture** — one verdict, one tax model, one formatter, consumed everywhere; verdict keys never diverge across surfaces.
- The **after-tax opportunity-cost counterfactual** is genuinely well-constructed (total-return, same tax settings both sides, historical FX).
- **Honest data defences:** stale-while-revalidate, per-symbol cooldowns, a curated ISIN seed, and a **ground-truth executed-price integrity guard** that flags wrong-instrument resolution.
- **Ownership-aware wording** and an **honest "unavailable"** stance on ETF overlap (no fabricated numbers).
- A thoughtful, **explicitly-documented Swiss tax model** (`docs/TAX-MODEL.md`).

### What is financially sound
- The counterfactual/opportunity-cost methodology; the Swiss private-investor tax treatment (CGT-free, income-taxed dividends, accumulating-fund income drag); money-weighted portfolio XIRR; the "benchmark underperformance never forces a Sell" invariant.

### What is questionable
- Lenient 3/6 quality gate; arbitrary attractiveness weights and thresholds; sector-only diversification; single-marginal-rate tax approximation; deterministic forecasts.

### What is potentially wrong (concrete)
- Register §28 #1–16 (P0/P1): the debt-free-leverage inversion, the currency/units cluster, no split adjustment, the DCF cliff, reverse-DCF saturation, the median-picks-max bias, the dividend-yield unit bug, the price-return forward seam, cross-listing ownership, and low-confidence Sell.

### What is missing
- §29 — chiefly full ETF constituents, downside/ranges, total-return forwards, and correlation-based portfolio construction.

### Highest-risk issues (ranked)
1. **Currency & units** (§28 #2, #3, #5) — can 100× a value or mis-value a cross-listing.
2. **Debt-free fails leverage** (#1) — inverts quality for the best names.
3. **No split adjustment** (#4) — silent series corruption.
4. **Fair-value biases** (#6, #7, #8) — distort every band and Sell signal.
5. **Price-return forward assumptions** (#10, #11) — systematically wrong forecasts.
6. **Cross-listing ownership** (#12) — undermines the app's own core principle.

### Recommended next steps
See §31.

---

## 31. Prioritized Recommendations (roadmap)

**Phase 0 — data integrity (do first; everything rides on it)**
1. Normalise minor units on **every** read path (`price_on`/`get_history`/fundamentals/fund) and make FX **never silently return 1.0** — return `None`/flagged instead (§28 #2,#3). [P0]
2. Apply **split adjustment** (use `auto_adjust=True` for the value series, or apply the splits column) (§28 #4). [P0]
3. Convert **EPS↔price via FX** in `value_analysis`; carry a single valuation currency (§28 #5). [P0]
4. Verify yfinance `dividendYield`/`holdingPercent` units against the pinned version and remove the `>1` heuristic (§28 #9). [P0/P1]

**Phase 1 — valuation & verdict correctness**
5. Treat **debt-free as passing/n-a** on the leverage check (§28 #1). [P0]
6. Replace **index-median** fair value/growth with a mean or interquartile midpoint (§28 #6). [P1]
7. Fix the **DCF growth representation** for g≥r and make **reverse-DCF** meaningful only below r (§28 #7,#8). [P1]
8. Add a **confidence floor on the Sell path**; widen bands by confidence; add hysteresis at band edges (§28 #13). [P1]
9. Make Discover and Decisions value a symbol at the **same price** (§28 #14). [P1]

**Phase 2 — portfolio & forecasting**
10. Integrate a **real ETF constituent source**; until then label all overlap/indirect "top-holdings only" in the UI (§16). [P1]
11. Use **total-return** forward CAGRs; present **ranges / a bear case** (§28 #10,#11). [P1]
12. **ISIN/company-normalise ownership** across listings (§28 #12). [P1]
13. Fix `reallocatableCHF` to freed capital; fix `recoveryMonths` semantics (§28 #15,#22). [P1/P2]

**Phase 3 — UX/consistency & robustness**
14. Guard the PositionDetail counterfactual (no `cf.data!`); make Share/Export honour the active `benchmark`/`preTax`; fix the portfolio PDF `export-chart` id (§28 #17,#18). [P2]
15. Add a **fundamentals negative-cache** to end the "loading" tail (§28 #24). [P2]
16. Decouple "Today's P/L" from the chart range; fix the Watchlist alerted-tick (§28 #28,#29). [P2]
17. Sweep the P3 register (§28 #32).

---

## 32. Appendix — Technical References

**Backend services (`backend/app/services/`)**
`valuation.py` (valuation engine), `verdict.py` (recommendation engine), `counterfactual.py` (opportunity cost), `projection.py` (forecasting), `decision.py`/`recommend.py`/`advisory.py`/`watchlist.py` (decision surfaces), `exposure.py`/`allocation.py`/`fit.py` (portfolio & overlap), `screener.py`/`screener_warm.py`/`scan.py` (Discover), `finance.py`/`finance_math.py` (P/L, XIRR, CAGR), `tax.py` (Swiss tax), `fx.py` (FX), `marketdata.py`/`history.py`/`resolution.py`/`price_integrity.py` (data), `signals.py` (sell signals), `universal.py` (risk/return), `listings.py` (cross-listing), `repo.py` (data access + ownership).

**Providers / reference / core**
`providers/yfinance_provider.py`, `providers/base.py` (minor-unit normalisation), `reference/{defaults,universe,geo,themes,isin_map}.py`, `core/{db,config,cache}.py`.

**Frontend (`frontend/src/`)**
`views/*` (10 pages), `components/{Verdict,ValueAnalysis,ValuationBand,PortfolioFit,DiscoverMap,ExposureBars,DeltaChart,ProjectionChart,PeriodReturns,ListingRecommendation,SellSignalPanel,Fundamentals}.tsx`, `modals/*` (14 modals), `lib/{api,exporters,shareImage,externalLinks,format,router}.ts`, `store.ts`.

**Existing docs (cross-references)**
`docs/DATA_MODEL.md` (source files, cost basis, minor units), `docs/TAX-MODEL.md` (Swiss tax rules & defaults), `docs/DATA_AUDIT.md` (the Swatch wrong-share-class case & the integrity guard), `docs/API_CONTRACT.md`, `docs/STYLEGUIDE.md`.

**Verification method for this document:** six parallel subsystem audits reading the source directly, each returning verbatim formulas with `file:line`, reconciled against the existing docs and spot-checked for agent error (e.g. the "Research not in sidebar" claim was found false and dropped; the `export-chart` omission and dead modal kinds were confirmed).

---

*End of overview. This is a current-state audit baseline. Where a fix is described it is marked [RECOMMENDED] and has not been applied.*

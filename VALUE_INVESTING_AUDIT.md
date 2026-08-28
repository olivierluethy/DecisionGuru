# DecisionGuru — Value-Investing Methodology Audit (Phase 0)

> **Status:** methodology audit, 2026-08-28. Companion to `overview.md` (the technical
> forensic baseline). This document does **not** repeat every `file:line` bug; it asks a
> different question: **is DecisionGuru's valuation and decision methodology actually sound
> Value Investing in the Graham/Buffett sense, and where does it deviate?** It then defines
> the target methodology and a prioritized redesign.
>
> **Method:** every claim here was re-verified by reading the source directly (not trusted
> from `overview.md`). Where the prior audit is now stale, this document says so explicitly.
> No behaviour was modified in producing it (Phase 0 is read-only).

---

## 0. Corrections to the prior audit (`overview.md`)

The task requires auditing *both* the implementation and the prior audit. Re-reading the
source found the following material corrections:

| overview.md claim | Reality in current source | Impact |
|---|---|---|
| **P0 #2** — "`price_on`/`get_history` return **raw pence closes**" → ~100× inflation in counterfactual/whatif/plans | **Stale.** `yfinance_provider.chart()` now normalizes every close *and* dividend via `normalize_minor_currency` at write time (`:97-109`); `marketdata.repair_minor_units()` (`:231-256`) back-fixes legacy rows. `price_cache` holds **major-unit (GBP)** closes. `counterfactual._Lookup.price_chf_on` = normalized close × FX(GBP→CHF) is **correct**. | The headline 100× counterfactual risk is **resolved on the history path**. Residual is narrower (below). |
| P0 #2 also — "fundamentals/fund price fields un-normalised" | **Confirmed.** `fundamentals()`/`fund_summary()` never call `normalize_minor_currency` on `marketCap`, `trailingEps`, `fiftyTwoWeek*`, `targetMeanPrice`, `regularMarketPrice` (`:226-262`,`:185-193`). | Real but narrower: affects display marketCap/target and — critically — **EPS used in valuation** for pence-quoted names (see F-1). |
| Quote path minor-unit normalization | **Confirmed present & idempotent** (`quote()` `:141`; `get_quote()` defensive re-normalize `:151-152`). | Core quote path is sound. |

**Net:** the single scariest technical claim in the prior audit (100× counterfactuals) is
mostly fixed. The *methodology* problems below are now the dominant risk, not raw units.

---

## 1. What "Value Investing" must mean for DecisionGuru

Before changing any formula, here is the methodology the engine will be held to. Each
principle is translated into a **measurable or explicitly-qualitative** component.

### Graham (price vs value, safety, strength)
| Principle | Operationalization in DecisionGuru |
|---|---|
| Intrinsic value is estimated, not known | Report a **range** (bear/base/bull), never a single "magic" fair value. |
| Margin of safety | Discount of price to a **conservative** point in the range; large model disagreement *shrinks* usable MoS. |
| Financial strength | Debt/EBITDA, net-debt/EBITDA, **interest coverage**, debt/FCF, current ratio — with **zero ≠ unknown ≠ high** treated distinctly. |
| Earnings stability | Multi-year revenue/EPS/FCF **consistency** (variance & drawdowns), not a single YoY number. |
| Reasonable valuation | Relative multiples (P/E, EV/EBIT, EV/FCF, P/B) as **context**, never as intrinsic value themselves. |
| Avoid speculation | When earnings are negative/erratic or models disagree wildly → **INSUFFICIENT DATA / NO RELIABLE VALUATION**, not a guess. |

### Buffett (wonderful business at a sensible price)
| Principle | Operationalization |
|---|---|
| Understand the business | Sector-aware valuation module selection; qualitative moat left **"Unknown — requires research"** when not measurable. |
| Durable competitive advantage | **Measurable proxies only:** stable/high ROIC, stable gross/operating margins, high FCF conversion, low capital intensity. No fabricated "moat score." |
| Predictable economics | Consistency scores on revenue/margins/FCF over the available history. |
| High return on capital | **ROIC** (not just ROE) vs an economic hurdle; ROE decomposed to flag leverage-driven ROE. |
| Strong, sustainable FCF | **Owner earnings** and **FCF** as first-class valuation inputs — *not* accounting EPS relabeled "owner earnings." |
| Sensible capital allocation | Dilution/buyback trend, dividend sustainability, debt trajectory, reinvestment vs payout. |
| Low/manageable leverage | Financial-strength module (above); debt-free is a **strength**, never a penalty. |
| Long-term value ≠ price momentum | **Never** use historical *price* CAGR as the forward *business* growth assumption. |
| Good company ≠ good investment | Quality, valuation, and portfolio-fit are **separate scores**, combined last. |

---

## 2. Current methodology, as built (concise)

DecisionGuru's value lens today = **three valuation models** (Graham Number, Graham 1974
growth, a two-stage "owner-earnings" DCF where owner earnings ≈ accounting EPS) → **index-
median** collapsed to one `fairValue` → **hard bands** (undervalued ≤ fair·0.70, overvalued
≥ fair·1.20, sell ≥ fair·1.40) → a **6-check equal-weight quality gate** (ROE≥15, net
margin≥10, growth>0, Debt/EBITDA≤3, payout≤70, long-run CAGR>0) → one shared **verdict
engine** (ownership-aware Buy more/Hold/Sell) → a **screener attractiveness** (0.45·val +
0.30·quality + 0.20·return + 0.05·fit) and a **portfolio-fit** panel (direct + top-10 ETF
indirect). Forecasts are **deterministic single points**; growth for projections is a 10y
**price-return** CAGR. Verified against source; consistent with `overview.md` §9–§18.

---

## 3. Findings — Value-Investing deviations (re-verified, re-prioritized)

Tags: **[T]** technical/mathematical · **[F]** financial/methodological. Severity as in
`overview.md` (P0 = can flip a conclusion or corrupt a headline).

### P0 — corrupts a conclusion or a headline number

- **F-1 [F/T] EPS↔price currency mismatch, no FX.** `value_analysis` values `eps`
  (reporting/`financialCurrency`) against `price` (trading currency, from `resolve_price`)
  with **no conversion** (`valuation.py:203-211,221`). For any ADR/cross-listing where
  reporting ≠ trading currency, **every** model, band, MoS and Sell signal is wrong by the
  FX rate. Compounded for pence-quoted names because `trailingEps` itself is un-normalized
  (§0). *Fix:* carry one explicit valuation currency; convert EPS and BVPS to the price
  currency (or vice-versa) before any model runs.

- **F-2 [F/T] Debt-free company FAILS the leverage check.**
  `de = debt/ebitda if (debt and ebitda and ebitda>0) else None` (`valuation.py:232`);
  `None` → the "Debt/EBITDA ≤ 3" check returns **False** (`:238`). A pristine balance sheet
  (`totalDebt==0`) scores **0/1 on leverage**, depressing quality, verdict, and
  attractiveness for the *safest* names — an inversion of the principle. *Fix:* distinguish
  `debt==0` (**pass**), `debt` unknown (**n/a, not counted**), `debt` high (**fail**).

- **F-3 [F] FX degrades silently to `1.0`.** `get_fx_rate` returns `1.0` on any unresolved
  pair (`fx.py:119`), indistinguishable from a real 1:1. Now that minor units are
  normalized upstream the 100× tail is smaller, but a missing pair still silently mis-values
  a position with **no error signal**. *Fix:* return `None`/flagged; propagate a data-quality
  flag; never fabricate a rate.

- **T-4 [T] Fair value = index-median → the *maximum* of two models.**
  `intrinsic.mid = vals[len(vals)//2]` with two surviving models selects `vals[1]` = the
  **higher** (`valuation.py:218`; same bug in `_pick_growth` `:126`). Systematically biases
  fair value **up** and suppresses Sell/overvalued signals. *Fix:* use the mean or the
  interquartile midpoint; and prefer a **conservative** point for the MoS test.

### P1 — wrong under common conditions / systematic bias

- **F-5 [F/T] DCF growth cliff.** `if g >= r: g = r - 0.001` (`valuation.py:100-101`) models
  *every* 9–15% grower at 8.9%, collapsing exactly the high-quality compounders Buffett
  cares about. *Fix:* a two-stage taper (high growth fading to terminal), which is finite
  without clipping.

- **T-6 [T] Reverse DCF saturates.** `_implied_growth` bisects with `cap=False` but `_dcf`
  still applies the `g≥r` cliff, so above `r` every guess returns the same value → the
  search runs to **~0.40** for any richly-valued name (`valuation.py:167-181`). The
  market-implied-growth feature — potentially the strongest analytic — is unusable above the
  discount rate. *Fix:* multi-stage DCF with no cliff; report "no economic solution" instead
  of a fake bound.

- **F-7 [F/T] Dividend-yield unit heuristic breaks sub-1% yields.**
  `dy = dy/100 if dy>1 else dy` (`valuation.py:198`) treats a genuine 0.9% (0.9) as 90%.
  Feeds `supportableReturn` and attractiveness. *Fix:* verify the pinned yfinance unit once;
  remove the heuristic.

- **F-8 [F] "Owner earnings" ≡ accounting EPS.** The DCF's `base_eps` is `trailingEps`/
  `forwardEps` (`valuation.py:204`) — **no** D&A, maintenance capex, or working-capital
  adjustment, and **no FCF path at all**. This is the central Buffett gap: the app measures
  accounting earnings, not the cash a long-term owner receives. *Fix:* add an owner-earnings
  / FCF valuation lane from the cash-flow statement; keep EPS-DCF only where earnings ≈ cash.

- **F-9 [F] Historical *price* CAGR used as forward *business* growth.**
  `projection.benchmark_cagr` is a 10y CAGR of **closes only** (`projection.py:12-20`),
  dividend-blind, and it drives projection/whatif/plans while the backward counterfactual is
  **total-return** — an apples-to-oranges seam, and a direct violation of "price performance
  ≠ business value." *Fix:* use total-return CAGRs, and prefer fundamentals-based growth for
  business projections; label every forecast's basis.

- **F-10 [F] Single deterministic "magic" fair value; no bear/base/bull.** One point drives
  categorical bands; there is no scenario, no uncertainty band, no downside case anywhere
  (`valuation.py`, `projection.py`). *Fix:* bear/base/bull with explicit per-scenario
  assumptions → intrinsic **range** → MoS **range**; wide range ⇒ lower confidence.

- **F-11 [F] No confidence floor on Sell.** A single-model, low-confidence fair value can
  still force a categorical **Sell** (`verdict.py:157-159`; confidence only demotes, never
  gates). *Fix:* require ≥medium confidence (and ≥2 agreeing models) before Sell; widen
  bands and add hysteresis when confidence is low.

- **F-12 [F] Ownership by symbol, not company.** `repo.owned_symbol_set` keys on exact
  `symbol` (`repo.py:47-59`); a name held as `NESN.SW` but screened as `NSRGY` reads **Buy**,
  not **Buy more** — defeating the app's own anti-overlap purpose. *Fix:* normalize ownership
  and exposure on **ISIN/company identity** across listings.

- **F-13 [F] Portfolio fit is a 5% tie-breaker, not a decision layer.** Attractiveness =
  `…+0.05·fit` (`screener.py:61`); the NVIDIA-vs-NASDAQ decision the task centers on cannot
  emerge from a 5% nudge. *Fix:* make Asset Quality / Valuation / Ownership / Portfolio-Fit /
  Opportunity-Cost **separate outputs**, combined only at the final action.

- **F-14 [F] ETF overlap bounded by top-~10 holdings.** `fit.py` indirect exposure and
  `allocation` use `funds_data.top_holdings` only; `indirect.available=false` means "not in a
  top-10," **not** "no exposure" (`fit.py:31-49`, `allocation.py`). Backend is honest about
  this; the redesign must keep that honesty and, ideally, add a real constituent source.

### P2 and below
Equal-weight 3/6 quality gate is lenient; missing-quality mislabeled a value trap
(`verdict.py:142,172`); arbitrary attractiveness weights/anchors (`screener.py:55-62`); HHI
on normalized bucket weights (`exposure.py`); `assumptions` output ignores user overrides
(`valuation.py:260`); no split adjustment on `auto_adjust=False` history
(`yfinance_provider.py:83`) — real but only bites hand-adjusted-quantity edge cases. See
`overview.md` §28 for the full register; those findings stand.

---

## 4. Buffett / Graham alignment scorecard

| Dimension | Target (Graham/Buffett) | Current | Gap | Priority |
|---|---|---|---|---|
| Intrinsic value | Range, cash-based | Point, EPS-based, median-picks-max | Large | P0/P1 |
| Owner earnings / FCF | First-class | Absent (EPS relabeled) | Large | P1 |
| Margin of safety | Vs conservative case, confidence-aware | Vs median point, no floor | Medium | P0/P1 |
| Financial strength | 0≠unknown≠high, interest coverage | Debt-free **fails** | Inverted | **P0** |
| Business quality | ROIC, FCF conv., consistency, moat-or-unknown | 6 equal binaries, ROE-only | Medium | P1/P2 |
| Capital allocation | Dilution/buyback/dividend/debt | None | Large | P2 |
| Growth basis | Business fundamentals, total-return | Price-return CAGR | Wrong basis | P1 |
| Scenarios / uncertainty | Bear/base/bull, model disagreement visible | Deterministic point | Large | P1 |
| Reverse DCF | Robust market-implied growth | Saturates above r | Broken | P1 |
| Good co. ≠ good investment | Separate quality/value/fit layers | Blended, fit 5% | Medium | P1 |
| Portfolio intelligence | Direct + full indirect + concentration | Top-10 indirect, sector-only | Data-bounded | P1/P2 |
| Company identity | ISIN/issuer across listings | Symbol-only | Blind spot | P1 |
| Confidence / honesty | "I don't know" is valid | Only demotes, never abstains | Medium | P1 |

**One-line verdict:** DecisionGuru is a *coherent, honest lightweight value screen* with an
excellent after-tax opportunity-cost core — but it is **not yet Buffett-grade**: it measures
accounting earnings rather than owner cash, states a false-precision point value biased
upward, inverts the balance-sheet test for the safest companies, and treats portfolio fit as
a rounding error rather than a decision.

---

## 5. Target architecture (what Phase 1–6 builds)

```
                       ┌────────────────────────────────────────────┐
                       │ DATA INTEGRITY LAYER (single source)        │
                       │ • one valuation currency (FX EPS↔price)     │
                       │ • FX never silently 1.0 (flag instead)      │
                       │ • minor units on every price field          │
                       │ • missing ≠ zero (typed data-quality flags) │
                       │ • ISIN/company identity across listings     │
                       └───────────────┬────────────────────────────┘
             ┌──────────────────────────┼──────────────────────────────┐
             ▼                          ▼                              ▼
   ┌──────────────────┐      ┌────────────────────┐        ┌──────────────────────┐
   │ INTRINSIC VALUE  │      │ BUSINESS QUALITY   │        │ FINANCIAL STRENGTH   │
   │ (a RANGE)        │      │ ROIC, FCF conv.,   │        │ debt states, int.    │
   │ • owner earnings │      │ margin/rev/FCF     │        │ coverage, debt/FCF,  │
   │ • FCF valuation  │      │ consistency,       │        │ liquidity            │
   │ • Graham (cond.) │      │ dilution, moat-or- │        │ (0 ≠ unknown ≠ high) │
   │ • relative (ctx) │      │ unknown            │        └──────────┬───────────┘
   │ • bear/base/bull │      └─────────┬──────────┘                   │
   │ • reverse DCF    │                │                              │
   └────────┬─────────┘                │                              │
            │        model agreement → confidence                     │
            └───────────────┬──────────┴──────────────────────────────┘
                            ▼
              ┌───────────────────────────────┐     ┌────────────────────────────┐
              │ PORTFOLIO INTELLIGENCE (own    │     │ EXPECTED RETURN & RISK      │
              │ layer): direct + indirect ETF  │     │ range, not a point          │
              │ exposure, concentration,       │     └──────────────┬──────────────┘
              │ opportunity cost, alternative  │                    │
              └───────────────┬────────────────┘                    │
                              └─────────────┬──────────────────────┘
                                            ▼
                        ┌───────────────────────────────────────┐
                        │ RECOMMENDATION ENGINE 2.0             │
                        │ dimensions: quality · strength ·      │
                        │ valuation · exp.return · risk · fit · │
                        │ opp.cost · data-confidence            │
                        │ → BUY / BUY MORE / HOLD / WATCH /      │
                        │   REDUCE / SELL / AVOID / PREFER ETF / │
                        │   INSUFFICIENT DATA  (ownership-aware) │
                        └───────────────────────────────────────┘
```

**Design rules the redesign must honor**
1. **No magic fair value** — always a range; expose model disagreement; wide disagreement
   lowers confidence and can force INSUFFICIENT DATA.
2. **Separate scores** — quality, valuation, strength, fit, opportunity cost stay distinct;
   the engine, not a weighted average, resolves the action.
3. **Ownership-aware wording only at the end** — the same asset analysis yields BUY vs BUY
   MORE purely from ownership/ISIN; never "Buy more" for an unowned name.
4. **Missing ≠ zero ≠ bad** — every absent input is a typed flag that lowers confidence, not
   a silent 0 or an automatic fail.
5. **Do not optimize for more BUYs** — INSUFFICIENT DATA and PREFER ETF are first-class,
   valid outcomes.

---

## 6. Test scenarios (Section 28 of the brief → concrete regression tests)

The brief overrides the project's standing "no automated tests" norm **for the financial
engine specifically** (the owner still tests the running UI by hand). Phase 1+ adds a
`pytest` suite under `backend/tests/` covering, at minimum:

| ID | Scenario | Assertion |
|---|---|---|
| A | Debt = 0 | leverage check **passes** (or n/a), never fails |
| B | 500 GBp | normalizes to GBP 5.00 in every price field feeding valuation |
| C | 1:10 split | historical returns unchanged (split-adjusted series) |
| D | models {100, 200} | midpoint = 150 (mean), **not** 200 |
| E | growth > discount rate | two-stage taper, finite, **no** silent clip to r−0.001 |
| F | dividend yield 0.9% | stays 0.9%, never 90% |
| G | same ISIN, two tickers | one economic company; owned ⇒ Buy more on both |
| H | 20% ETF holding NVIDIA at 8% | indirect ≈ 1.6% |
| I | great asset, poor fit | "excellent asset / poor fit / prefer ETF" |
| J | cheap but low quality | not auto-BUY (value-trap Hold/Watch) |

---

## 7. Prioritized roadmap (per-fix: Problem → Root cause → Consequence → Fix → Validation)

Highest-risk, highest-confidence, lowest-blast-radius first. Each Phase-1 item is a
self-contained correction the brief explicitly endorses, so no methodology is changed
silently.

**Phase 1 — data integrity & unambiguous corrections — ✅ APPLIED (2026-08-28)**
Test-driven; suite in `backend/tests/` (16 tests, all green). Run: `uv run pytest` (or
`.venv/bin/python -m pytest`) from `backend/`.
1. ✅ **F-2 debt-free leverage** — debt-free now **passes**; unknown debt is **n/a** (excluded
   from score/max, not a silent fail); only genuine leverage fails. `valuation.py` leverage
   check + applicable-aware `quality.score/max`. Tests: Scenario A (`test_valuation_phase1.py`).
2. ✅ **F-3 FX never silent 1.0** — `fx.resolve_fx()` reports the resolution source; an
   unresolvable pair returns `(None,'unresolved')`; `get_fx_rate(..., strict=True)` returns
   None, non-strict **warns** (no longer silent) and degrades to 1.0. Back-compat preserved
   for all existing callers. Tests: `test_fx_phase1.py`.
3. ✅ **F-1 (minor-unit part)** — EPS/forward-EPS and the display currency normalised by the
   **snapshot's own** currency (GBp→GBP) in `value_analysis`. Test: Scenario B. *Deferred:*
   the reporting↔trading FX conversion of EPS — semantics unverified (see §9); not applied to
   avoid a double-conversion regression.
4. ✅ **F-7 dividend-yield unit** — verified live: yfinance 1.6.0 returns a **percent**; now
   always ÷100, `>1` heuristic removed. Test: Scenario F.
5. ✅ **T-4 median-picks-max** — `_median` (true statistical median) for fair-value midpoint
   and growth pick; `{100,200}`→150, not 200. Test: Scenario D.

**Phase 2 — valuation engine to a range — ✅ APPLIED (2026-08-28)**
Test-driven; +21 tests (37 total green).
6. ✅ **F-5/T-6 DCF cliff + reverse-DCF** — `_dcf` now fades growth g0→terminal over the
   horizon (finite for any g0, no cliff); `_implied_growth` returns None ("no economic
   solution") outside the plausible bracket instead of saturating to ~0.40. Guarded r>tg.
   Tests: `test_valuation_dcf_phase2.py` (Scenario E).
7. ✅ **F-8 owner earnings / FCF lane** — provider fetches the cash-flow statement
   (`yfinance_provider.fundamentals` → `cashflow` block, field names verified live);
   `value_analysis` computes FCF/share, **median-normalised** FCF/share, owner earnings
   (NI+D&A−capex), an FCF-based DCF model in the range, and FCF yield. Degrades gracefully.
   Tests: `test_valuation_fcf_phase2.py`.
8. ✅ **F-10 bear/base/bull** — three scenarios varying growth/discount/terminal →
   `scenarios`, `valuationRange {low,base,high,spread}`, per-scenario MoS, and a
   `valuationUncertainty` flag; a wide spread demotes confidence (AUDIT §6). Base scenario
   ≡ the earnings DCF. Tests: `test_valuation_scenarios_phase2.py`.
9. ✅ **F-11 confidence floor on Sell** — a categorical Sell now requires ≥ medium confidence
   AND ≥ 2 agreeing models; otherwise the sell-zone trims (Reduce/Watch), never a hard Sell.
   Tests: `test_verdict_phase2.py`. *Deferred:* band-edge price hysteresis (P2 refinement).

**Phase 3 — business quality & strength — ✅ APPLIED (2026-08-28)**
Test-driven; +15 tests (52 total green). New module `services/quality.py`; provider now also
fetches the income-statement extras (interest/pretax/tax) and the balance sheet (invested
capital, debt, cash, current assets/liabilities, shares) — field labels verified live.
10. ✅ **Quality** — `assess_quality`: ROIC (NOPAT/invested capital), FCF conversion
    (FCF/net income), interest coverage (EBIT/interest, n/a when debt-free), revenue/margin/
    FCF **consistency** (coefficient of variation), **dilution** (share-count trend →
    buyback/stable/dilutive), and a **moat** signal that is measurable-strong / -some /
    none-evident / **unknown** (never fabricated). KO live: ROIC 15.8%, moat measurable-strong.
11. ✅ **Financial strength** — `assess_financial_strength`: distinct debt states
    (debt-free / low / moderate / high / **unknown**), net-debt/EBITDA, debt/FCF, interest
    coverage, current ratio, cash position, and an overall rating. Wired into `value_analysis`
    as `qualityAssessment` + `financialStrength` (additive). Tests: `test_quality_phase3.py`.

**Phase 4 — portfolio intelligence — ✅ APPLIED (2026-08-28)**
Test-driven; +12 tests (64 total green). New pure module `services/portfolio_intel.py`.
12. ✅ **F-12 ISIN/company ownership** — `repo.owned_isin_set()` + `repo.is_owned(symbol,
    isin, …)`: ownership recognised by the economic entity, so a company held on one listing
    is 'owned' when met as another that resolves to the same ISIN. Wired into the screener.
    Tests: `test_ownership_isin_phase4.py` (Scenario G). (Schema enforces UNIQUE isin, so a
    cross-listing is a query symbol resolving to the held ISIN, not a duplicate instrument.)
13. ✅ **F-13 portfolio fit as its own layer** — `portfolio_intel.indirect_exposure`
    (holding% × ETF weight, Scenario H = 1.6%), `effective_exposure`, and `fit_decision`
    (improves / neutral / concentrates / **prefer-etf**) keep asset merit distinct from fit;
    an excellent asset already held heavily via ETFs → **prefer ETF** (Scenario I). Wired into
    `fit.py` (`fitDecision`). Tests: `test_portfolio_intel_phase4.py`.
14. ✅ **F-14** — indirect exposure stays honest: absence is `available:false` (weight None),
    labelled `top-holdings-only`, never zero-with-false-confidence. Real constituent source
    still [RECOMMENDED].

**Phase 5 — recommendation engine 2.0 — ✅ APPLIED (2026-08-28)**
Test-driven; +10 tests (74 total green). Extended the single shared `verdict.resolve_verdict`
(not forked — every surface keeps consuming it).
15. ✅ **Multi-dimensional decision** — a `dimensions` block (valuation, quality, financial
    strength, expected return, portfolio fit, opportunity cost, data confidence, risk), each
    with its own rating, kept DISTINCT rather than blended into one number. Auto-populated
    from the va payload's Phase-3 `qualityAssessment`/`financialStrength` everywhere.
16. ✅ **New ownership-aware outcomes** — `action.label` can become **PREFER ETF** (an
    attractive buy the book already owns heavily via ETFs — overrides only a buy, never a
    sell) and **INSUFFICIENT DATA** (no reliable valuation basis — honest abstention, brief
    §34). Canonical `verdict` key stays {buy-more, hold, sell} for back-compat; `dataSufficient`
    exposed. Tests: `test_recommend_v2_phase5.py`. *Remaining integration:* pass `fit` into
    `resolve_verdict` at the position/opportunity routers so PREFER ETF surfaces in that UI.

**Phase 6 — Discover — ✅ APPLIED (2026-08-28)**
Test-driven; +8 tests (82 total green). `screener.discover_attractiveness` ranks on
valuation + quality + expected return + fit, then **scales by data confidence** and sinks
INSUFFICIENT-DATA names, so a shaky 50% MoS no longer outranks a robust 30% (brief §22).
Ownership is not an input — it only rewords the action. Tests: `test_discover_phase6.py`.

**`overview.md` updated** — §0 is now the authoritative Engine-2.0 current state; the §28
register is annotated with ✅ resolved / ◑ partial / ○ open.

---

## 8. Decisions needing the owner (before Phase 1)

1. **Automated tests** — the brief mandates them; the project norm is "no tests." Confirm
   adding a backend `pytest` suite for the financial engine only.
2. **Scope of this session** — audit only, vs. audit + Phase 1 (the unambiguous P0/P1
   corrections + tests), vs. deeper.
3. **New data (Phase 2/3/4)** — owner earnings/FCF and financial strength need the
   **cash-flow and balance-sheet statements** (`Ticker.cashflow`/`balance_sheet`), and real
   ETF overlap needs a **constituent source**. Confirm we may add these provider fetches
   (rate-limited, cached like fundamentals) — otherwise those phases stay best-effort on the
   fields already cached.

## 9. Live-verification items (cannot be settled from code)
- yfinance pinned-version units for `dividendYield` and `holdingPercent` (fraction vs %).
- Whether `trailingEps`/`marketCap` for a pence-quoted (`.L`) name arrive in pence or the
  major unit (drives the size of F-1).
- Whether the importer emits non-buy acquisition actions (affects F-12 completeness).

---

**Follow-ups applied (same day):** #10 total-return forward CAGR; #11 bear/base/bull
`holdRange` in `prospective_projection`; #14 Discover values at the same resolved price as
Decisions; #15 `reallocatableCHF` = freed capital; **#5 verified a NON-issue** (live probe:
yfinance `trailingEps` is in the **trading** currency — `eps == price/PE` for NSRGY & BABA — so
no reporting↔trading FX is needed); `fit` wired into the Research **and** Position endpoints
(PREFER ETF surfaces); and the **frontend** renders the range, owner-earnings/FCF, quality &
financial-strength, and the fit decision (`tsc` clean, `vite build` passes). Backend **89 tests
green**.

*End of methodology audit. **Phases 0–6 applied + follow-ups**, test-driven, 2026-08-28.
`overview.md` §0 is the authoritative current-state spec. Genuinely open: split adjustment (#4,
deferred — data-dependent/risky), a real full-ETF-constituent source (needs an external feed),
and band-edge price hysteresis (minor).*

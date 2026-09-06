# Historical Price vs Fair Value Zones — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat "today's zones held across history" chart with a point-in-time reconstruction that shows how Fair Value and its Buy/Fair/Overvalued/Sell zones actually stepped over the last ~4 annual reports, with a scrub cursor and a per-transition Fundamentals → Models → Fair Value → Zones explanation.

**Architecture:** A new backend service reconstructs an annual valuation-snapshot series from the annual statement lanes already fetched by the provider (income/cashflow/balance), reusing the existing valuation engine (no duplicated formulas). A new endpoint serves the series. The frontend `PriceBandChart` merges the daily price series with the stepped snapshots and renders stepped zone bands + a stepped FV spine + the real daily price line, with a keyboard-accessible scrub cursor and clickable valuation-transition detail.

**Tech Stack:** Python 3.12 / FastAPI / SQLite (backend, `backend/.venv`), pytest. React 18 / TypeScript / Recharts / @tanstack/react-query / dayjs / clsx / Tailwind (frontend). Playwright for frontend/e2e verification (repo-root `playwright.config.ts`).

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-09-06-historical-price-fair-value-zones-design.md`). Every task's requirements implicitly include these.

- **Reuse the existing valuation engine — never duplicate formulas.** Reconstruction must call the same model / `_dcf` / `classify_band` code paths as `backend/app/services/valuation.py`; extract shared helpers rather than copying math.
- **Reuse `_pick_growth` semantics exactly** and **the exact existing normalized-FCF logic** (median of the per-share FCF series). Extract, don't re-derive.
- **Eligibility = information availability, not fiscal year.** A year yields a snapshot only when ≥1 valuation model is valid from data known at that year.
- **Share-count convention matches the current engine** (balance-sheet `Ordinary Shares Number`); **reconstructed per-share values are clearly distinguished from reported `trailingEps`** wherever surfaced.
- **`valid` (model computed a usable number) vs `contributed` (model was in the median set) are distinct** for every model.
- **No fabricated causal percentages** for the FV change — only the observable chain Fundamentals → Models → Fair Value → Zones.
- **No look-ahead is a HARD invariant**, proven by tests that intentionally mutate future/latest fundamentals and assert prior snapshots are unchanged.
- **Three dates never conflated:** fiscal period end / filing date / effective date. `effectiveDate = filingDate` when a real filing date exists, else `fiscalPeriodEnd + filingLag` (default **90 days**), tagged `effectiveDateSource: "assumed"`. *(Note: yfinance exposes no filing date today, so in practice the source is always `"assumed"`; the `"filing"` branch is retained for future providers.)*
- **Stepped only** — the FV spine and zone edges use Recharts `type="stepAfter"`; historical Fair Value is never smoothed/interpolated.
- **Honest unavailable states** for pre-coverage / insufficient-data / ETF — render **no zones**, **never** today's zones.
- **Historical states quieter than today, but never so faint as to be unreadable** (contrast floor).
- **Clicking a transition pins that historical state** and opens its full before/after explanation.
- **Playwright visual QA is part of "done."** Passing unit tests alone does not complete the task.
- **No scope creep** into quarterly/daily reconstruction or new persistence tables.
- Engine constants (do not change): `DEFAULT_MOS=0.30`, `OVERVALUED_PREMIUM=0.20`, `SIGNIFICANT_OVERVALUED_PREMIUM=0.40`, `DISCOUNT_RATE=0.09`, `TERMINAL_GROWTH=0.025`, `DCF_YEARS=10`, `GROWTH_CAP=0.15`.
- Recharts chart colors are hardcoded hex in the `C` object of `ValuationBand.tsx` (SVG presentation attributes don't resolve `var(--token)`); reuse `C` and `ZONE_STYLE`.

**Test commands:**
- Backend: `cd backend && .venv/bin/pytest tests/<file>::<test> -v`
- Frontend typecheck: `npm --prefix frontend run typecheck`
- Playwright: `npx playwright test e2e/<spec>` (from repo root)

**Branch:** work continues on `feat/historical-fair-value-zones` (already created; spec committed there).

---

## File Structure

**Backend**
- Modify `backend/app/services/valuation.py` — extract two pure helpers (`zone_edges`, `compute_models`) used by both the live engine and the reconstruction. No behavior change to `value_analysis`.
- Modify `backend/app/providers/yfinance_provider.py` — retain the fiscal-period-end **date** per statement year (currently only `int(year)` is kept); add a `_period_end(col)` helper.
- Create `backend/app/services/valuation_history.py` — the reconstruction service (the core of this feature).
- Modify `backend/app/routers/research.py` — add `GET /valuation/history/{symbol}`.
- Create `backend/tests/test_valuation_history.py` — reconstruction + no-look-ahead + stability + drivers tests.
- Create `backend/tests/test_valuation_helpers_refactor.py` — characterization tests proving the extraction didn't change engine output.

**Frontend**
- Modify `frontend/src/lib/api.ts` — add `ValuationHistory` / `ValuationSnapshot` types + `api.valuationHistory`.
- Create `frontend/src/lib/valuationHistory.ts` — pure helpers: `mergePriceWithSnapshots`, `snapshotAt`, `formatTransition`. Kept pure so they are trivial to reason about and assert via Playwright-visible output.
- Modify `frontend/src/components/ValuationBand.tsx` — rework `PriceBandChart` (stepped bands + FV spine + scrub + transitions + honest states).
- Create `e2e/valuation-zones.spec.ts` — Playwright coverage of the scenario matrix.

---

## Task 1: Extract `zone_edges` and `compute_models` helpers (no behavior change)

**Files:**
- Modify: `backend/app/services/valuation.py:45-80` (classify_band) and `:249-286` (inline model block)
- Test: `backend/tests/test_valuation_helpers_refactor.py`

**Interfaces:**
- Produces:
  - `zone_edges(fair_value: float, cfg: dict) -> dict` returning keys `entryTarget, overvaluedAt, sellZoneAt, zones` (same rounding/shape as classify_band's edges today).
  - `compute_models(eps: float | None, bvps: float | None, base_eps: float | None, g: float, normalized_fcf_ps: float | None, cfg: dict) -> dict[str, float]` returning a subset of keys `grahamNumber, grahamGrowth, dcf, fcf` (only those that produced a positive value), identical to today's inline logic.

- [ ] **Step 1: Write the failing characterization test**

```python
# backend/tests/test_valuation_helpers_refactor.py
import math
from app.services import valuation as v


def test_zone_edges_matches_classify_band():
    cfg = v._val_cfg(None)  # defaults: mos .30, ov .20, sig .40
    fv = 100.0
    edges = v.zone_edges(fv, cfg)
    assert edges["entryTarget"] == 70.0
    assert edges["overvaluedAt"] == 120.0
    assert edges["sellZoneAt"] == 140.0
    assert edges["zones"] == {
        "buy": [0.0, 70.0], "fair": [70.0, 120.0],
        "overvalued": [120.0, 140.0], "sell": [140.0, round(140.0 * 1.6, 2)],
    }
    band = v.classify_band(price=100.0, fair_value=fv, cfg=cfg)
    for k in ("entryTarget", "overvaluedAt", "sellZoneAt", "zones"):
        assert band[k] == edges[k]


def test_compute_models_matches_inline_formulas():
    cfg = v._val_cfg(None)
    m = v.compute_models(eps=5.0, bvps=20.0, base_eps=5.0, g=0.10,
                         normalized_fcf_ps=4.0, cfg=cfg)
    assert m["grahamNumber"] == round(math.sqrt(22.5 * 5.0 * 20.0), 2)
    assert m["grahamGrowth"] == round(5.0 * (8.5 + 2 * min(max(0.10 * 100, 0), 15)), 2)
    assert "dcf" in m and m["dcf"] > 0
    assert "fcf" in m and m["fcf"] > 0
    # Graham models require positive eps & bvps
    assert "grahamNumber" not in v.compute_models(-1.0, 20.0, None, 0.1, None, cfg)
    assert "grahamGrowth" not in v.compute_models(-1.0, 20.0, None, 0.1, None, cfg)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_helpers_refactor.py -v`
Expected: FAIL — `AttributeError: module 'app.services.valuation' has no attribute 'zone_edges'`.

- [ ] **Step 3: Add the helpers and refactor callers**

Add near `classify_band` in `valuation.py`:

```python
def zone_edges(fair_value: float, cfg: dict) -> dict:
    """Buy/fair/overvalued/sell edges from a fair value + user cfg. Single source of the
    zone geometry, shared by classify_band and the historical reconstruction."""
    entry = fair_value * (1 - cfg["mos"])
    over = fair_value * (1 + cfg["ov"])
    sig = fair_value * (1 + cfg["sig"])
    return {
        "entryTarget": round(entry, 2),
        "overvaluedAt": round(over, 2),
        "sellZoneAt": round(sig, 2),
        "zones": {
            "buy": [0.0, round(entry, 2)],
            "fair": [round(entry, 2), round(over, 2)],
            "overvalued": [round(over, 2), round(sig, 2)],
            "sell": [round(sig, 2), round(sig * 1.6, 2)],
        },
    }


def compute_models(eps: float | None, bvps: float | None, base_eps: float | None,
                   g: float, normalized_fcf_ps: float | None, cfg: dict) -> dict[str, float]:
    """The four intrinsic-value models, returning only those that produced a positive
    value. Identical to the inline block in value_analysis (single source of the formulas)."""
    m: dict[str, float] = {}
    if eps and eps > 0 and bvps and bvps > 0:
        m["grahamNumber"] = round(math.sqrt(22.5 * eps * bvps), 2)
    if eps and eps > 0:
        m["grahamGrowth"] = round(eps * (8.5 + 2 * min(max(g * 100, 0), 15)), 2)
    dcf = _dcf(base_eps, g, r=cfg["disc"], tg=cfg["tg"])
    if dcf:
        m["dcf"] = round(dcf, 2)
    fcf_dcf = _dcf(normalized_fcf_ps, g, r=cfg["disc"], tg=cfg["tg"])
    if fcf_dcf:
        m["fcf"] = round(fcf_dcf, 2)
    return m
```

Refactor `classify_band` (lines 51-53, 63-80) to compute its edges via `zone_edges`:

```python
    edges = zone_edges(fair_value, cfg)
    entry = edges["entryTarget"]
    over = edges["overvaluedAt"]
    sig = edges["sellZoneAt"]
    if price <= entry:
        band, label = "undervalued", "Undervalued"
    elif price >= sig:
        band, label = "significantly-overvalued", "Significantly overvalued"
    elif price >= over:
        band, label = "overvalued", "Overvalued"
    else:
        band, label = "fair", "Fairly valued"
    premium = round(price / fair_value - 1, 4)
    return {
        "band": band, "label": label, "premiumToFair": premium,
        "entryTarget": entry, "fairValue": round(fair_value, 2),
        "overvaluedAt": over, "sellZoneAt": sig,
        "zones": edges["zones"], "marginOfSafetyPct": cfg["mos"],
    }
```

Refactor the inline model block in `value_analysis` (lines 249-286) to call `compute_models`, keeping the surrounding cash-flow derivation (`normalized_fcf_ps`, `owner_earnings_ps`, `fcf_per_share`, `fcf_yield`) unchanged:

```python
    # cash-lane derivations (unchanged): shares, cf_years, _per_share,
    # fcf_ps_series, fcf_per_share, normalized_fcf_ps, owner_earnings_ps ...
    models = compute_models(eps, bvps, base_eps, g, normalized_fcf_ps, cfg)
    fcf_yield = round(fcf_per_share / price, 4) if (fcf_per_share and price and price > 0) else None
```

(Move the `normalized_fcf_ps` computation above the `compute_models` call.)

- [ ] **Step 4: Run the refactor test + the full existing valuation suite**

Run:
```
cd backend && .venv/bin/pytest tests/test_valuation_helpers_refactor.py tests/test_valuation_phase1.py tests/test_valuation_dcf_phase2.py tests/test_valuation_fcf_phase2.py tests/test_valuation_scenarios_phase2.py -v
```
Expected: PASS (new tests pass; existing valuation tests still pass → extraction preserved behavior).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/valuation.py backend/tests/test_valuation_helpers_refactor.py
git commit -m "refactor(valuation): extract zone_edges + compute_models helpers"
```

---

## Task 2: Retain fiscal-period-end date per statement year in the provider

**Files:**
- Modify: `backend/app/providers/yfinance_provider.py:289-309` (income/history loop), `:337-350` (cashflow), `:378-390` (balance)
- Test: `backend/tests/test_valuation_history.py` (a focused test of the `_period_end` helper)

**Interfaces:**
- Produces: module-level `def _period_end(col) -> str | None` returning an ISO `YYYY-MM-DD` from a pandas Timestamp column label (or None). Each `history[]`, `cashflow.years[]`, `balance.years[]` entry gains a `periodEnd: str | None` field alongside `year`.

- [ ] **Step 1: Write the failing test for the date helper**

```python
# backend/tests/test_valuation_history.py  (create; more tests added in later tasks)
import pandas as pd
from app.providers import yfinance_provider as yp


def test_period_end_extracts_iso_date():
    assert yp._period_end(pd.Timestamp("2020-09-26")) == "2020-09-26"
    assert yp._period_end(None) is None
    assert yp._period_end("not-a-timestamp") is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py::test_period_end_extracts_iso_date -v`
Expected: FAIL — `AttributeError: module ... has no attribute '_period_end'`.

- [ ] **Step 3: Add `_period_end` and populate `periodEnd`**

Add at module scope in `yfinance_provider.py` (near the top of the class file, outside the class):

```python
def _period_end(col) -> str | None:
    """ISO date for a statement column label (a pandas period-end Timestamp)."""
    try:
        import pandas as _pd
        ts = _pd.Timestamp(col)
        if ts is _pd.NaT:
            return None
        return ts.strftime("%Y-%m-%d")
    except Exception:  # noqa: BLE001
        return None
```

In the income/history loop, add `"periodEnd": _period_end(col)` to both the `history.append({...})` and `income_years.append({...})` dicts. In the cashflow loop add `"periodEnd": _period_end(col)` to each `years_cf` entry. In the balance loop add `"periodEnd": _period_end(col)` to each `byears` entry. (All keep the existing `int(yr)` `year` field.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py::test_period_end_extracts_iso_date -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/providers/yfinance_provider.py backend/tests/test_valuation_history.py
git commit -m "feat(provider): retain fiscal period-end date per statement year"
```

---

## Task 3: Reconstruction — per-year as-of inputs + eligibility (no look-ahead)

**Files:**
- Create: `backend/app/services/valuation_history.py`
- Test: `backend/tests/test_valuation_history.py`

**Interfaces:**
- Consumes: `valuation.compute_models`, `valuation.zone_edges`, `valuation._pick_growth`, `valuation._clamp`, `valuation._median`, `valuation._val_cfg`, `valuation.GROWTH_CAP`; `providers.base.normalize_minor_currency`.
- Produces:
  - `def _year_inputs(year: int, history: list[dict], cashflow: dict, balance: dict, fin_ccy: str | None, cfg: dict) -> dict | None` — returns `{year, periodEnd, eps, bvps, fcfPerShare, growth, models, fairValue}` for a reconstructable year, else `None`. **Uses only statement rows with `year <= year`** (no look-ahead).
  - Helper `_norm(v, ccy)` applying `normalize_minor_currency`.

The DECISIVE no-look-ahead test lives here.

- [ ] **Step 1: Write the failing tests (fixtures + eligibility + no-look-ahead)**

```python
# append to backend/tests/test_valuation_history.py
from app.services import valuation_history as vh
from app.services import valuation as v

CFG = v._val_cfg(None)

def _fixture():
    # 3 fiscal years; net income & FCF grow, shares flat. USD (major unit).
    history = [
        {"year": 2020, "periodEnd": "2020-12-31", "revenue": 1000.0, "netIncome": 100.0},
        {"year": 2021, "periodEnd": "2021-12-31", "revenue": 1100.0, "netIncome": 120.0},
        {"year": 2022, "periodEnd": "2022-12-31", "revenue": 1210.0, "netIncome": 150.0},
    ]
    cashflow = {"sharesOutstanding": 100.0, "years": [
        {"year": 2020, "periodEnd": "2020-12-31", "freeCashFlow": 90.0, "netIncome": 100.0, "dna": 20.0, "capex": -30.0},
        {"year": 2021, "periodEnd": "2021-12-31", "freeCashFlow": 110.0, "netIncome": 120.0, "dna": 22.0, "capex": -32.0},
        {"year": 2022, "periodEnd": "2022-12-31", "freeCashFlow": 140.0, "netIncome": 150.0, "dna": 25.0, "capex": -35.0},
    ]}
    balance = {"years": [
        {"year": 2020, "periodEnd": "2020-12-31", "stockholdersEquity": 500.0, "sharesOutstanding": 100.0},
        {"year": 2021, "periodEnd": "2021-12-31", "stockholdersEquity": 560.0, "sharesOutstanding": 100.0},
        {"year": 2022, "periodEnd": "2022-12-31", "stockholdersEquity": 640.0, "sharesOutstanding": 100.0},
    ]}
    return history, cashflow, balance


def test_year_inputs_reconstructs_per_share_values():
    history, cashflow, balance = _fixture()
    out = vh._year_inputs(2022, history, cashflow, balance, "USD", CFG)
    assert out is not None
    assert out["eps"] == 1.5          # 150 / 100
    assert out["bvps"] == 6.4         # 640 / 100
    assert out["fairValue"] and out["fairValue"] > 0
    assert set(out["models"]).issubset({"grahamNumber", "grahamGrowth", "dcf", "fcf"})


def test_no_look_ahead_growth_uses_only_past_years():
    history, cashflow, balance = _fixture()
    # Growth at 2021 must derive ONLY from 2020..2021, ignoring 2022.
    g2021 = vh._year_inputs(2021, history, cashflow, balance, "USD", CFG)["growth"]
    expected = (120.0 / 100.0) ** (1 / 1) - 1  # CAGR 2020->2021
    assert abs(g2021 - v._clamp(expected, -0.05, v.GROWTH_CAP)) < 1e-9


def test_year_without_shares_is_not_reconstructable():
    history, cashflow, balance = _fixture()
    balance["years"][2]["sharesOutstanding"] = None
    # 2022 has no shares in balance and cashflow.sharesOutstanding is a *current* fallback we
    # must NOT use for a historical year -> not reconstructable from per-share inputs.
    out = vh._year_inputs(2022, history, cashflow, balance, "USD", CFG)
    assert out is None or "grahamNumber" not in out["models"]
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py -k "year_inputs or no_look_ahead or without_shares" -v`
Expected: FAIL — module `valuation_history` missing.

- [ ] **Step 3: Implement `_year_inputs`**

```python
# backend/app/services/valuation_history.py
"""Point-in-time reconstruction of Fair Value + zones from the annual statement lanes.

Each fiscal year becomes a valuation snapshot computed with ONLY the statement rows known
at that year (no look-ahead). It reuses the live valuation engine's model/zone helpers so
there is a single source of the financial formulas."""
from __future__ import annotations

from . import valuation as v
from ..providers.base import normalize_minor_currency


def _norm(value: float | None, ccy: str | None) -> float | None:
    if value is None:
        return None
    return normalize_minor_currency(value, ccy)[0]


def _by_year(rows: list[dict]) -> dict[int, dict]:
    return {r["year"]: r for r in rows if r.get("year") is not None}


def _year_inputs(year: int, history: list[dict], cashflow: dict, balance: dict,
                 fin_ccy: str | None, cfg: dict) -> dict | None:
    """Reconstructed as-of inputs + models + fair value for `year`, or None when not
    reconstructable (no valid model). Uses only statement rows with year <= `year`."""
    hist_upto = [h for h in history if h.get("year") is not None and h["year"] <= year]
    bal = _by_year(balance.get("years") or []).get(year)
    shares = (bal or {}).get("sharesOutstanding")
    if not shares or shares <= 0:
        return None  # per-share reconstruction impossible without that year's share count

    inc = _by_year(history).get(year) or {}
    ni = inc.get("netIncome")
    equity = (bal or {}).get("stockholdersEquity")
    eps = _norm(ni / shares, fin_ccy) if ni is not None else None
    bvps = _norm(equity / shares, fin_ccy) if equity is not None else None

    # normalized FCF/share = median of per-share FCF for years <= `year`, each divided by
    # THAT year's shares (point-in-time), mirroring the engine's median-of-series logic.
    bshares = {y: (r.get("sharesOutstanding")) for y, r in _by_year(balance.get("years") or []).items()}
    fcf_ps_series: list[float] = []
    for cf in (cashflow.get("years") or []):
        y = cf.get("year")
        if y is None or y > year:
            continue
        sh = bshares.get(y)
        fcf = cf.get("freeCashFlow")
        if sh and sh > 0 and fcf is not None:
            ps = _norm(fcf / sh, fin_ccy)
            if ps is not None:
                fcf_ps_series.append(ps)
    normalized_fcf_ps = round(v._median(fcf_ps_series), 2) if fcf_ps_series else None

    # Growth: reuse _pick_growth with an EMPTY snapshot so only the multi-year income CAGR
    # path fires (its exact semantics), then clamp exactly as the live engine does.
    g_used_raw, _ = v._pick_growth({}, hist_upto)
    g = v._clamp(g_used_raw, -0.05, v.GROWTH_CAP)

    base_eps = eps if (eps and eps > 0) else None
    models = v.compute_models(eps, bvps, base_eps, g, normalized_fcf_ps, cfg)
    if not models:
        return None  # eligibility: at least one valid model required

    vals = sorted(x for x in models.values() if x and x > 0)
    fair_value = round(v._median(vals), 2) if vals else None
    if not fair_value or fair_value <= 0:
        return None

    return {
        "year": year,
        "periodEnd": (bal or {}).get("periodEnd") or inc.get("periodEnd"),
        "eps": round(eps, 2) if eps is not None else None,          # RECONSTRUCTED (≠ trailingEps)
        "bvps": round(bvps, 2) if bvps is not None else None,
        "fcfPerShare": normalized_fcf_ps,
        "growth": round(g, 4),
        "models": models,
        "fairValue": fair_value,
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py -k "year_inputs or no_look_ahead or without_shares" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/valuation_history.py backend/tests/test_valuation_history.py
git commit -m "feat(valuation-history): per-year as-of input reconstruction (no look-ahead)"
```

---

## Task 4: Reconstruction — assemble the snapshot series + effective dates + stability

**Files:**
- Modify: `backend/app/services/valuation_history.py`
- Test: `backend/tests/test_valuation_history.py`

**Interfaces:**
- Consumes: `_year_inputs`, `valuation.zone_edges`, `valuation._val_cfg`, `fundamentals.get_fundamentals`.
- Produces:
  - `FILING_LAG_DAYS = 90`
  - `def _effective_date(period_end: str | None, filing_date: str | None, year: int) -> tuple[str, str]` → `(iso_date, source)` where source is `"filing"` or `"assumed"`.
  - `def build_snapshots(data: dict, cfg: dict) -> list[dict]` → sorted list of snapshot dicts: `{asOf, effectiveDateSource, fiscalPeriodEnd, filingDate, fiscalYear, fairValue, entryTarget, overvaluedAt, sellZoneAt, inputs:{eps,bvps,fcfPerShare,growth}, models:{...}}`. `drivers` added in Task 5.

- [ ] **Step 1: Write failing tests (effective date, ordering, stability)**

```python
# append to backend/tests/test_valuation_history.py
import copy

def test_effective_date_uses_lag_when_no_filing_date():
    d, src = vh._effective_date("2020-12-31", None, 2020)
    assert d == "2021-03-31"   # +90 days
    assert src == "assumed"

def test_effective_date_prefers_filing_date():
    d, src = vh._effective_date("2020-12-31", "2021-02-10", 2020)
    assert d == "2021-02-10"
    assert src == "filing"

def test_build_snapshots_sorted_and_shaped():
    history, cashflow, balance = _fixture()
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    snaps = vh.build_snapshots(data, CFG)
    assert [s["fiscalYear"] for s in snaps] == sorted(s["fiscalYear"] for s in snaps)
    s = snaps[-1]
    assert s["fairValue"] > 0
    assert s["entryTarget"] == round(s["fairValue"] * (1 - CFG["mos"]), 2)
    assert s["sellZoneAt"] == round(s["fairValue"] * (1 + CFG["sig"]), 2)
    assert s["inputs"]["eps"] == 1.5
    assert s["effectiveDateSource"] == "assumed"

def test_stability_mutating_latest_year_leaves_priors_unchanged():
    history, cashflow, balance = _fixture()
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    before = vh.build_snapshots(copy.deepcopy(data), CFG)
    # Mutate ONLY the latest (2022) fundamentals — a proxy for "today's data changed".
    data["history"][2]["netIncome"] = 999.0
    data["cashflow"]["years"][2]["freeCashFlow"] = 999.0
    data["balance"]["years"][2]["stockholdersEquity"] = 9990.0
    after = vh.build_snapshots(data, CFG)
    prior_before = [s for s in before if s["fiscalYear"] < 2022]
    prior_after = [s for s in after if s["fiscalYear"] < 2022]
    assert prior_before == prior_after   # no look-ahead: history is immutable to future data
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py -k "effective_date or build_snapshots or stability" -v`
Expected: FAIL.

- [ ] **Step 3: Implement `_effective_date` and `build_snapshots`**

```python
from datetime import date, timedelta

FILING_LAG_DAYS = 90


def _effective_date(period_end: str | None, filing_date: str | None, year: int) -> tuple[str, str]:
    if filing_date:
        return filing_date, "filing"
    if period_end:
        try:
            d = date.fromisoformat(period_end) + timedelta(days=FILING_LAG_DAYS)
            return d.isoformat(), "assumed"
        except ValueError:
            pass
    # Last resort: fiscal year-end + lag.
    return (date(year, 12, 31) + timedelta(days=FILING_LAG_DAYS)).isoformat(), "assumed"


def _years_present(data: dict) -> list[int]:
    ys: set[int] = set()
    for r in (data.get("history") or []):
        if r.get("year") is not None:
            ys.add(r["year"])
    return sorted(ys)


def build_snapshots(data: dict, cfg: dict) -> list[dict]:
    history = data.get("history") or []
    cashflow = data.get("cashflow") or {}
    balance = data.get("balance") or {}
    fin_ccy = data.get("financialCurrency")
    snaps: list[dict] = []
    for year in _years_present(data):
        inp = _year_inputs(year, history, cashflow, balance, fin_ccy, cfg)
        if inp is None:
            continue
        edges = v.zone_edges(inp["fairValue"], cfg)
        filing_date = (_by_year(balance.get("years") or []).get(year) or {}).get("filingDate")  # None today
        as_of, src = _effective_date(inp["periodEnd"], filing_date, year)
        snaps.append({
            "asOf": as_of,
            "effectiveDateSource": src,
            "fiscalPeriodEnd": inp["periodEnd"],
            "filingDate": filing_date,
            "fiscalYear": year,
            "fairValue": inp["fairValue"],
            "entryTarget": edges["entryTarget"],
            "overvaluedAt": edges["overvaluedAt"],
            "sellZoneAt": edges["sellZoneAt"],
            "inputs": {"eps": inp["eps"], "bvps": inp["bvps"],
                       "fcfPerShare": inp["fcfPerShare"], "growth": inp["growth"]},
            "models": inp["models"],
            "drivers": None,
        })
    snaps.sort(key=lambda s: (s["asOf"], s["fiscalYear"]))
    return snaps
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py -k "effective_date or build_snapshots or stability" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/valuation_history.py backend/tests/test_valuation_history.py
git commit -m "feat(valuation-history): assemble snapshot series with effective dates + stability"
```

---

## Task 5: Reconstruction — drivers (Fundamentals → Models → FV → Zones)

**Files:**
- Modify: `backend/app/services/valuation_history.py`
- Test: `backend/tests/test_valuation_history.py`

**Interfaces:**
- Produces:
  - `def _delta(before: float | None, after: float | None) -> dict` → `{before, after, deltaPct, dir}` (`deltaPct` None when `before` is falsy; `dir` in `"up"|"down"|"flat"`).
  - `def attach_drivers(snaps: list[dict]) -> None` — mutates each snapshot (except the first) to set `drivers` per the spec §5.2 shape (`inputs`, `models` with `valid`+`contributed`, `fairValue`, `zones`).

- [ ] **Step 1: Write failing tests**

```python
# append to backend/tests/test_valuation_history.py
def test_delta_shapes():
    d = vh._delta(100.0, 110.0)
    assert d["before"] == 100.0 and d["after"] == 110.0
    assert abs(d["deltaPct"] - 0.10) < 1e-9 and d["dir"] == "up"
    assert vh._delta(None, 110.0)["deltaPct"] is None
    assert vh._delta(100.0, 90.0)["dir"] == "down"

def test_drivers_first_none_rest_full_chain():
    history, cashflow, balance = _fixture()
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    snaps = vh.build_snapshots(data, CFG)
    vh.attach_drivers(snaps)
    assert snaps[0]["drivers"] is None
    dr = snaps[-1]["drivers"]
    assert set(dr) == {"inputs", "models", "fairValue", "zones"}
    assert set(dr["inputs"]) == {"eps", "fcfPerShare", "bvps", "growth"}
    for mk in ("grahamNumber", "grahamGrowth", "dcf", "fcf"):
        assert "valid" in dr["models"][mk] and "contributed" in dr["models"][mk]
    assert dr["fairValue"]["after"] == snaps[-1]["fairValue"]

def test_model_valid_vs_contributed_distinct_when_negative_eps():
    # Craft a year whose eps is negative in the LATER year so graham models drop out.
    history = [
        {"year": 2020, "periodEnd": "2020-12-31", "revenue": 1000.0, "netIncome": 100.0},
        {"year": 2021, "periodEnd": "2021-12-31", "revenue": 900.0, "netIncome": -50.0},
    ]
    cashflow = {"sharesOutstanding": 100.0, "years": [
        {"year": 2020, "periodEnd": "2020-12-31", "freeCashFlow": 90.0},
        {"year": 2021, "periodEnd": "2021-12-31", "freeCashFlow": 80.0},
    ]}
    balance = {"years": [
        {"year": 2020, "periodEnd": "2020-12-31", "stockholdersEquity": 500.0, "sharesOutstanding": 100.0},
        {"year": 2021, "periodEnd": "2021-12-31", "stockholdersEquity": 450.0, "sharesOutstanding": 100.0},
    ]}
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    snaps = vh.build_snapshots(data, CFG)
    vh.attach_drivers(snaps)
    dr = snaps[-1]["drivers"]
    # grahamGrowth needs eps>0 -> invalid in 2021, so not contributed either.
    assert dr["models"]["grahamGrowth"]["valid"] is False
    assert dr["models"]["grahamGrowth"]["contributed"] is False
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py -k "delta or drivers or valid_vs_contributed" -v`
Expected: FAIL.

- [ ] **Step 3: Implement `_delta` and `attach_drivers`**

```python
_MODEL_KEYS = ("grahamNumber", "grahamGrowth", "dcf", "fcf")


def _delta(before: float | None, after: float | None) -> dict:
    pct = None
    if before not in (None, 0) and after is not None:
        pct = round(after / before - 1, 4)
    if pct is None:
        direction = "flat"
    elif abs(pct) < 1e-9:
        direction = "flat"
    else:
        direction = "up" if pct > 0 else "down"
    return {"before": before, "after": after, "deltaPct": pct, "dir": direction}


def _model_delta(prev_models: dict, cur_models: dict, key: str) -> dict:
    b, a = prev_models.get(key), cur_models.get(key)
    d = _delta(b, a)
    # valid = produced a usable number this snapshot; contributed = positive (in the median set)
    d["valid"] = a is not None
    d["contributed"] = a is not None and a > 0
    return d


def attach_drivers(snaps: list[dict]) -> None:
    for i in range(1, len(snaps)):
        prev, cur = snaps[i - 1], snaps[i]
        pin, cin = prev["inputs"], cur["inputs"]
        cur["drivers"] = {
            "inputs": {
                "eps": _delta(pin["eps"], cin["eps"]),
                "fcfPerShare": _delta(pin["fcfPerShare"], cin["fcfPerShare"]),
                "bvps": _delta(pin["bvps"], cin["bvps"]),
                "growth": _delta(pin["growth"], cin["growth"]),
            },
            "models": {k: _model_delta(prev["models"], cur["models"], k) for k in _MODEL_KEYS},
            "fairValue": _delta(prev["fairValue"], cur["fairValue"]),
            "zones": {
                "entryTarget": {"before": prev["entryTarget"], "after": cur["entryTarget"]},
                "overvaluedAt": {"before": prev["overvaluedAt"], "after": cur["overvaluedAt"]},
                "sellZoneAt": {"before": prev["sellZoneAt"], "after": cur["sellZoneAt"]},
            },
        }
```

Note: the driver `inputs` key is `bvps` (matches the snapshot's `inputs.bvps`); the frontend labels it "Book value".

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py -k "delta or drivers or valid_vs_contributed" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/valuation_history.py backend/tests/test_valuation_history.py
git commit -m "feat(valuation-history): before/after driver chain with valid vs contributed"
```

---

## Task 6: Public service entry + endpoint `GET /research/valuation/history/{symbol}`

**Files:**
- Modify: `backend/app/services/valuation_history.py` (public `valuation_history(...)`)
- Modify: `backend/app/routers/research.py` (route)
- Test: `backend/tests/test_valuation_history.py`

**Interfaces:**
- Produces:
  - `def valuation_history(symbol: str, data: dict | None = None, settings: dict | None = None) -> dict` returning `{symbol, currency, coverageFrom, snapshots, note}`. When `data` is None it loads via `fundamentals.get_fundamentals(symbol)`. Empty/insufficient → `{symbol, currency, coverageFrom: None, snapshots: [], note}`.
  - Route `@router.get("/valuation/history/{symbol:path}")` → `valuation_history_route(symbol)`.

- [ ] **Step 1: Write failing tests**

```python
# append to backend/tests/test_valuation_history.py
def test_valuation_history_public_shape():
    history, cashflow, balance = _fixture()
    data = {"history": history, "cashflow": cashflow, "balance": balance, "financialCurrency": "USD"}
    out = vh.valuation_history("AAPL", data=data, settings=None)
    assert out["symbol"] == "AAPL"
    assert out["currency"] == "USD"
    assert out["coverageFrom"] == out["snapshots"][0]["asOf"]
    assert out["snapshots"][0]["drivers"] is None
    assert isinstance(out["note"], str) and out["note"]

def test_valuation_history_empty_when_no_statements():
    out = vh.valuation_history("XYZ", data={"history": [], "cashflow": {}, "balance": {}, "financialCurrency": None}, settings=None)
    assert out["snapshots"] == []
    assert out["coverageFrom"] is None
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py -k "public_shape or empty_when" -v`
Expected: FAIL — `valuation_history` not defined.

- [ ] **Step 3: Implement public entry + wire the route**

Append to `valuation_history.py`:

```python
from . import fundamentals as fund

_NOTE = (
    "Valuation zones are reconstructed from the annual statements known at each date "
    "(effective date = period-end + a 90-day filing-lag assumption; the provider exposes "
    "no exact filing date). Annual granularity, ~4 years of coverage."
)


def valuation_history(symbol: str, data: dict | None = None, settings: dict | None = None) -> dict:
    cfg = v._val_cfg(settings)
    data = data if data is not None else (fund.get_fundamentals(symbol) or {})
    snaps = build_snapshots(data, cfg)
    attach_drivers(snaps)
    return {
        "symbol": symbol,
        "currency": data.get("financialCurrency"),
        "coverageFrom": snaps[0]["asOf"] if snaps else None,
        "snapshots": snaps,
        "note": _NOTE,
    }
```

In `research.py`, add the import and route (place after the existing `valuation` route):

```python
from ..services.valuation_history import valuation_history as valuation_history_service

@router.get("/valuation/history/{symbol:path}")
async def valuation_history_route(symbol: str) -> dict:
    """Reconstructed point-in-time Fair Value + zone series (annual granularity) with a
    before/after driver chain per transition. No look-ahead — each snapshot uses only the
    statements known at that date."""
    settings = get_settings()
    return await run_in_threadpool(valuation_history_service, symbol, None, settings)
```

- [ ] **Step 4: Run to verify pass + full history suite**

Run: `cd backend && .venv/bin/pytest tests/test_valuation_history.py -v`
Expected: PASS (all reconstruction tests).

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/valuation_history.py backend/app/routers/research.py backend/tests/test_valuation_history.py
git commit -m "feat(research): GET /valuation/history/{symbol} reconstructed zone series"
```

---

## Task 7: Frontend types + `api.valuationHistory`

**Files:**
- Modify: `frontend/src/lib/api.ts:185-193` (near `marketHistory`) and the types block (after `ValuationBand`, ~`:536`)

**Interfaces:**
- Produces: `ValuationSnapshot`, `ValuationDriverDelta`, `ValuationHistory` interfaces; `api.valuationHistory(symbol: string) => Promise<ValuationHistory>`.

- [ ] **Step 1: Add the types**

After the `ValuationBand` interface (`api.ts:536`):

```ts
export interface ValuationDriverDelta {
  before: number | null;
  after: number | null;
  deltaPct: number | null;
  dir?: 'up' | 'down' | 'flat';
  valid?: boolean;        // models only
  contributed?: boolean;  // models only
}
export interface ValuationSnapshot {
  asOf: string;
  effectiveDateSource: 'filing' | 'assumed';
  fiscalPeriodEnd: string | null;
  filingDate: string | null;
  fiscalYear: number;
  fairValue: number;
  entryTarget: number;
  overvaluedAt: number;
  sellZoneAt: number;
  inputs: { eps: number | null; bvps: number | null; fcfPerShare: number | null; growth: number };
  models: Record<string, number>;
  drivers: null | {
    inputs: Record<'eps' | 'fcfPerShare' | 'bvps' | 'growth', ValuationDriverDelta>;
    models: Record<string, ValuationDriverDelta>;
    fairValue: ValuationDriverDelta;
    zones: Record<'entryTarget' | 'overvaluedAt' | 'sellZoneAt', { before: number; after: number }>;
  };
}
export interface ValuationHistory {
  symbol: string;
  currency: string | null;
  coverageFrom: string | null;
  snapshots: ValuationSnapshot[];
  note: string;
}
```

- [ ] **Step 2: Add the API method**

After `marketHistory` (`api.ts:193`):

```ts
  valuationHistory: (symbol: string) =>
    req<ValuationHistory>(`/research/valuation/history/${encodeURIComponent(symbol)}`),
```

Note: confirm the router prefix — existing calls use `api.valuation(...)` → `/research/valuation/...` (check the `req`/base path used by `api.valuation`, defined earlier in `api.ts`, and mirror it exactly).

- [ ] **Step 3: Typecheck**

Run: `npm --prefix frontend run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(api): valuationHistory client + types"
```

---

## Task 8: Pure merge/format helpers (`frontend/src/lib/valuationHistory.ts`)

**Files:**
- Create: `frontend/src/lib/valuationHistory.ts`

**Interfaces:**
- Consumes: `ValuationSnapshot`, `ValuationHistory` from `./api`.
- Produces:
  - `snapshotAt(snaps: ValuationSnapshot[], dateISO: string): ValuationSnapshot | null` — latest snapshot with `asOf <= dateISO` (binary/linear search; assumes sorted).
  - `type MergedRow = { date: string; close: number; fairValue: number | null; entryTarget: number | null; overvaluedAt: number | null; sellZoneAt: number | null }`
  - `mergePriceWithSnapshots(prices: {date:string; close:number}[], snaps: ValuationSnapshot[], k: number): MergedRow[]` — one forward pass; applies FX scalar `k` to all valuation figures; `null` valuation fields before `coverageFrom`.
  - `pctLabel(v: number | null | undefined): string` — e.g. `+15.9%` / `−4.2%` / `—`.

- [ ] **Step 1: Implement the helpers**

```ts
// frontend/src/lib/valuationHistory.ts
import type { ValuationSnapshot } from './api';

export type MergedRow = {
  date: string;
  close: number;
  fairValue: number | null;
  entryTarget: number | null;
  overvaluedAt: number | null;
  sellZoneAt: number | null;
};

/** Latest snapshot whose effective date is on/before `dateISO`, else null. Assumes `snaps`
 *  is sorted ascending by `asOf` (the backend guarantees this). */
export function snapshotAt(snaps: ValuationSnapshot[], dateISO: string): ValuationSnapshot | null {
  let found: ValuationSnapshot | null = null;
  for (const s of snaps) {
    if (s.asOf <= dateISO) found = s;
    else break;
  }
  return found;
}

/** Merge daily prices with the stepped snapshot series. Points before the first snapshot
 *  carry null valuation fields (the pre-coverage region). `k` is the FX scalar applied to
 *  every monetary valuation figure so the chart matches the CHF headline. */
export function mergePriceWithSnapshots(
  prices: { date: string; close: number }[],
  snaps: ValuationSnapshot[],
  k: number,
): MergedRow[] {
  let idx = -1; // index of the currently-applicable snapshot
  return prices.map((p) => {
    while (idx + 1 < snaps.length && snaps[idx + 1].asOf <= p.date) idx += 1;
    const s = idx >= 0 ? snaps[idx] : null;
    return {
      date: p.date,
      close: p.close,
      fairValue: s ? s.fairValue * k : null,
      entryTarget: s ? s.entryTarget * k : null,
      overvaluedAt: s ? s.overvaluedAt * k : null,
      sellZoneAt: s ? s.sellZoneAt * k : null,
    };
  });
}

export function pctLabel(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}
```

Assumes `mergePriceWithSnapshots` receives `prices` sorted ascending (the API returns them sorted).

- [ ] **Step 2: Typecheck**

Run: `npm --prefix frontend run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/valuationHistory.ts
git commit -m "feat(valuation-history): pure price<->snapshot merge helpers"
```

---

## Task 9: `PriceBandChart` — fetch history + stepped bands + FV spine + honest states

**Files:**
- Modify: `frontend/src/components/ValuationBand.tsx:112-392`

**Interfaces:**
- Consumes: `api.valuationHistory`, `mergePriceWithSnapshots`, `snapshotAt`, `pctLabel`.
- Produces: reworked `PriceBandChart` render (scrub cursor + transitions come in Tasks 10-11).

This task replaces the flat `ReferenceArea` zones with per-date stepped areas + a stepped FV spine, and adds the pre-coverage / unavailable states. Keep all existing toolbar controls, `k`/`ccy` FX handling, presets, Brush, rebase, and the price marks.

- [ ] **Step 1: Add the valuation-history query and merged series**

Inside `PriceBandChart`, after the existing `marketHistory` query:

```tsx
  const { data: valHistory } = useQuery({
    queryKey: ['valuationHistory', symbol],
    queryFn: () => api.valuationHistory(symbol),
    staleTime: 60 * 60_000,
    retry: 1,
  });
  const snapshots = valHistory?.snapshots ?? [];
  const hasHistory = snapshots.length >= 2;
```

Build the merged series (replaces the reliance on the single `band` for zones) with `useMemo`, reusing the existing `full` price array and FX scalar `k`:

```tsx
  const merged = useMemo(
    () => mergePriceWithSnapshots(full, snapshots, k),
    [full, snapshots, k],
  );
```

Import at top: `import { mergePriceWithSnapshots, snapshotAt, pctLabel, type MergedRow } from '../lib/valuationHistory';`

Change the chart data from `plot` to a merged plot that carries both the rebased/absolute price `value` and the stepped valuation fields. Extend the existing `plot` memo so each row also spreads the merged valuation fields:

```tsx
  const plot = useMemo(
    () => full.map((d, i) => ({
      date: d.date,
      value: rebase && base ? (d.close / base - 1) * 100 : d.close,
      fairValue: merged[i]?.fairValue ?? null,
      entryTarget: merged[i]?.entryTarget ?? null,
      overvaluedAt: merged[i]?.overvaluedAt ?? null,
      sellZoneAt: merged[i]?.sellZoneAt ?? null,
    })),
    [full, rebase, base, merged],
  );
```

- [ ] **Step 2: Replace flat zones with stepped areas + FV spine (not rebased, history present)**

Remove the four `zone(...)` `ReferenceArea` calls (lines 310-313) and the flat boundary `ReferenceLine`s at `entryTarget/overvaluedAt/sellZoneAt/fairValue` (329-332). Add stacked stepped areas + a stepped FV spine, rendered only when `!rebase && hasHistory`. Zone fills are stacked bottom→top using per-row values; use `stackId` so they layer:

```tsx
  {/* Stepped zone bands (per-date). Drawn only with real reconstructed history. */}
  {!rebase && hasHistory && (
    <>
      <Area type="stepAfter" dataKey="entryTarget" stackId="zones" stroke="none"
        fill={ZONE_STYLE.buy.color} fillOpacity={ZONE_STYLE.buy.fill} isAnimationActive={false} />
      {/* fair band = overvaluedAt - entryTarget ... use a computed field (Step 3) */}
    </>
  )}
```

Because Recharts stacks by summing dataKeys, add three *derived thickness* fields in the `plot` memo so each stacked layer is the gap between adjacent thresholds (a stacked area needs the band thickness, not the absolute edge):

```tsx
      buyBand: merged[i]?.entryTarget ?? null,
      fairBand: merged[i] && merged[i].entryTarget != null && merged[i].overvaluedAt != null
        ? merged[i].overvaluedAt! - merged[i].entryTarget! : null,
      overBand: merged[i] && merged[i].overvaluedAt != null && merged[i].sellZoneAt != null
        ? merged[i].sellZoneAt! - merged[i].overvaluedAt! : null,
      sellBand: merged[i]?.sellZoneAt != null ? merged[i].sellZoneAt! * 0.6 : null, // sell extends above
```

Then render four stacked stepped areas keyed on `buyBand/fairBand/overBand/sellBand` (stackId `"zones"`), each with its `ZONE_STYLE` color/opacity, plus the FV spine and the price mark on top:

```tsx
  {!rebase && hasHistory && (
    <>
      <Area type="stepAfter" dataKey="buyBand" stackId="zones" stroke="none"
        fill={ZONE_STYLE.buy.color} fillOpacity={ZONE_STYLE.buy.fill} isAnimationActive={false} />
      <Area type="stepAfter" dataKey="fairBand" stackId="zones" stroke="none"
        fill={ZONE_STYLE.fair.color} fillOpacity={ZONE_STYLE.fair.fill} isAnimationActive={false} />
      <Area type="stepAfter" dataKey="overBand" stackId="zones" stroke="none"
        fill={ZONE_STYLE.over.color} fillOpacity={ZONE_STYLE.over.fill} isAnimationActive={false} />
      <Area type="stepAfter" dataKey="sellBand" stackId="zones" stroke="none"
        fill={ZONE_STYLE.sell.color} fillOpacity={ZONE_STYLE.sell.fill} isAnimationActive={false} />
      <Line type="stepAfter" dataKey="fairValue" stroke={C.textFaint} strokeWidth={1.6}
        strokeDasharray="2 3" dot={false} isAnimationActive={false} />
    </>
  )}
```

Keep the existing price `Line/Area/dots` marks rendered AFTER these so price sits on top. (The Y-domain memo at lines 196-215 must switch to bracket the visible price against the *merged* thresholds — replace the constant `entryTarget/overvaluedAt/sellZoneAt` with the min/max of the visible merged rows' edges.)

- [ ] **Step 3: Pre-coverage region + honest unavailable state**

For the pre-coverage span (rows where `fairValue == null`), draw a single greyed `ReferenceArea` from the first date to `coverageFrom` with an inline label "insufficient fundamental history". Compute `coverageFrom = snapshots[0]?.asOf`.

When `!hasHistory` (fewer than 2 snapshots, or query failed): render the price line **with no zones**, plus a caption "Historical valuation unavailable — insufficient fundamental history." Do **not** fall back to the `band` zones. (The old `band`-driven flat zones are removed entirely; the `band` prop is still used only for the current-day right-edge labels/badge in Task 10.)

- [ ] **Step 4: Update the caption**

Replace the italic caption (lines 386-389) with:

```tsx
  <p className="mt-1.5 text-[10px] leading-snug text-text-faint/90 italic">
    {hasHistory
      ? "Valuation zones are reconstructed from the fundamentals reported at each date — they step when a new annual report lands. Scrub to any point to see the Fair Value and zones as they stood then."
      : "Historical valuation unavailable — insufficient fundamental history for this security."}
  </p>
```

- [ ] **Step 5: Typecheck + build**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ValuationBand.tsx
git commit -m "feat(chart): stepped reconstructed zone bands + FV spine + honest states"
```

---

## Task 10: Scrub cursor + snapshot card + keyboard navigation + current-day emphasis

**Files:**
- Modify: `frontend/src/components/ValuationBand.tsx`

**Interfaces:**
- Consumes: `snapshotAt`, `pctLabel`, the `merged`/`snapshots` from Task 9.
- Produces: a selected-date state + snapshot card; right-edge current-day labels/badge; keyboard nav.

- [ ] **Step 1: Selected-date state + custom Tooltip driving it**

```tsx
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const activeDate = selectedDate ?? (windowHasLatest ? lastDate : null);
  const activeSnap = activeDate ? snapshotAt(snapshots, activeDate) : null;
```

Use Recharts `Tooltip` with an `onMouseMove`/`activeLabel` handler on the `ComposedChart` (`onMouseMove={(st) => { if (!pinned && st?.activeLabel) setSelectedDate(String(st.activeLabel)); }}`). Draw a vertical `ReferenceLine x={activeDate}` when set.

- [ ] **Step 2: Snapshot card**

Render a card (beside the chart on wide screens, stacked below on narrow — use the existing Tailwind responsive classes) showing, for `activeDate` / `activeSnap`:
- date, market price on that date (`merged` close × nothing — already FX-applied? price uses `k`; reuse `plot` value in non-rebase), Fair Value (`activeSnap.fairValue * k`), discount to FV (`price/FV − 1` via `pctLabel`), zone verdict (compare price to `entryTarget/overvaluedAt/sellZoneAt`), and the zone edges Buy/Fair/Overvalued/Sell.
- When `activeSnap == null` (pre-coverage): show "No reconstructed valuation before {coverageFrom}."

- [ ] **Step 3: Keyboard navigation**

Make the chart wrapper `tabIndex={0}` with `role="application"` and an `aria-label`. On `ArrowLeft`/`ArrowRight`, move `selectedDate` to the previous/next date in `full` (clamp to ends); `Enter`/`Space` toggles `pinned`; `Escape` clears selection. Respect that this must work without hover.

- [ ] **Step 4: Current-day emphasis**

Keep the "today" divider + `ReferenceDot`. Add right-edge current-day zone labels driven by the LAST snapshot (`snapshots.at(-1)`), at full opacity, plus a small "Fair value {…} · MoS {…}" badge. Historical steps stay at the reduced `ZONE_STYLE` opacities from Task 9 — verify they remain legible (contrast floor) in Playwright (Task 12).

- [ ] **Step 5: Typecheck + build**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ValuationBand.tsx
git commit -m "feat(chart): scrub cursor, snapshot card, keyboard nav, current-day emphasis"
```

---

## Task 11: Valuation-transition markers + pinned transition detail view

**Files:**
- Modify: `frontend/src/components/ValuationBand.tsx`

**Interfaces:**
- Consumes: `snapshots` (each with `drivers`), `pctLabel`.
- Produces: clickable transition markers + a detail panel rendering the Fundamentals → Models → FV → Zones chain.

- [ ] **Step 1: Transition markers**

For each snapshot with `drivers != null` (i.e. every step after the first), render a small clickable `ReferenceDot`/tick at `x = snapshot.asOf` on the FV spine. `onClick` sets `selectedDate = snapshot.asOf` and `pinned = true`.

- [ ] **Step 2: Transition detail panel**

When `pinned` and `activeSnap?.drivers` exists, render a panel with three labeled groups (reuse the card styling):
- **Fundamentals:** EPS, FCF/share, Book value, Growth — each `before → after` with `pctLabel(deltaPct)` and a ↑/↓ from `dir`. Label EPS explicitly as "EPS (reconstructed)".
- **Model outputs:** Graham Number, Graham Growth, Earnings DCF, FCF DCF — each `before → after`; show a muted "n/a" when `valid === false`, and a subtle "in median" tag when `contributed`.
- **Result:** Fair Value `before → after` (`pctLabel`), then the three zone edges `before → after`.

Header copy: `Fair Value {pctLabel(drivers.fairValue.deltaPct)} · FY{prevYear} → FY{fiscalYear} report`.

- [ ] **Step 3: Close/unpin affordance**

A close button sets `pinned = false` and `selectedDate = null` (returns to live hover + current-day state).

- [ ] **Step 4: Typecheck + build**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/ValuationBand.tsx
git commit -m "feat(chart): clickable valuation transitions with before/after detail"
```

---

## Task 12: Playwright coverage + visual QA iteration

**Files:**
- Create: `e2e/valuation-zones.spec.ts`
- Reference: `e2e/market-analysis.spec.ts` (pattern for navigating to a research page), `playwright.config.ts`, `e2e/fixtures`, `e2e/screenshots`

**Interfaces:**
- Consumes: the running app (Playwright `webServer` from `playwright.config.ts`).

- [ ] **Step 1: Study the existing e2e pattern**

Read `e2e/market-analysis.spec.ts` and `e2e/fixtures` to learn how a research page for a symbol is opened and how the suite stubs/serves backend data. Mirror that setup (do not invent a new harness).

- [ ] **Step 2: Write the spec covering the scenario matrix**

Create `e2e/valuation-zones.spec.ts` asserting, for a stock with reconstructable history (e.g. AAPL via the fixture):
- the chart renders stepped zone areas and an FV spine (assert the presence of the stepAfter path elements / legend);
- switching timeframe to 5J / 3J / 1J keeps zones visible and stepped;
- hovering a mid-history point updates the snapshot card (price, Fair Value, discount, zone);
- keyboard: focus the chart, press ArrowLeft several times, assert the snapshot card date changes (hover-independent);
- clicking a transition marker pins it and opens the detail panel showing Fundamentals → Models → Fair Value → Zones with before→after values;
- a price-moved-while-FV-flat window shows the price line crossing zone bands that do NOT change over that span;
- **no-data**: a symbol without reconstructable history shows the "Historical valuation unavailable" caption and **no zone fills**;
- loading state renders the existing placeholder.
Capture screenshots into `e2e/screenshots/` for: today, 5J, 3J, 1J, a specific historical date, a large transition, price-moved-FV-flat, desktop width, narrow width (`page.setViewportSize`), hover, pinned transition, no-data.

- [ ] **Step 3: Run Playwright**

Run: `npx playwright test e2e/valuation-zones.spec.ts`
Expected: PASS.

- [ ] **Step 4: Visual QA iteration (REQUIRED — not done when tests pass)**

Open each screenshot and critique against the spec §41 checklist: Is the price line unmistakable? Are stepped zones visibly moving? Is today's state clearly the strongest? Are historical bands quieter **but readable** (contrast floor)? Is the transition detail legible? Does the narrow layout keep price + FV visible? Fix clutter/spacing/contrast/label issues in `ValuationBand.tsx`, rebuild, re-screenshot, and repeat until polished. Commit iteration fixes as you go:

```bash
git add frontend/src/components/ValuationBand.tsx e2e/valuation-zones.spec.ts e2e/screenshots
git commit -m "test(e2e): valuation-zones coverage + visual QA polish"
```

---

## Task 13: Regression + finalize

**Files:**
- No new code unless regressions surface.

- [ ] **Step 1: Backend regression**

Run: `cd backend && .venv/bin/pytest tests/ -q`
Expected: PASS except the known pre-existing failures — `test_market_analysis_bundle` (×3). Confirm no NEW failures. (Per project memory these 3 are pre-existing and not chased.)

- [ ] **Step 2: Frontend regression**

Run: `npm --prefix frontend run typecheck && npm --prefix frontend run build`
Expected: PASS.

- [ ] **Step 3: Existing e2e regression**

Run: `npx playwright test` (or at least `e2e/market-analysis.spec.ts` and `e2e/forecast.spec.ts`)
Expected: PASS except the known flaky `e2e/document-preview.spec.ts` (per project memory). Confirm the reworked chart didn't break `market-analysis`.

- [ ] **Step 4: Manual control regression check**

In the running app, confirm timeframe presets (Max/5J/3J/1J/6M/3M/1M), Linie/Fläche/Punkte, Linear/Log, % Rebase (zones hidden), and the Brush all still work on the reworked chart.

- [ ] **Step 5: Commit any regression fixes**

```bash
git add -A
git commit -m "fix: regressions from historical zones rework"
```

Then hand off to the `superpowers:finishing-a-development-branch` skill.

---

## Self-Review (completed during authoring)

**Spec coverage:** §4 point-in-time integrity → Tasks 3,4 (no-look-ahead + stability tests). §4.1 three dates → Task 4 (`_effective_date`, `effectiveDateSource`). §5.1 as-of inputs/eligibility → Task 3 (reuses `_pick_growth`, `compute_models`, per-year shares). §5.2 endpoint + drivers → Tasks 5,6. §6.1 API → Task 7. §6.2 merge → Task 8. §6.3 chart/spine/scrub/transitions/caption → Tasks 9,10,11. §7 states → Task 9 (pre-coverage/unavailable/no-zones). §8 testing → pytest Tasks 1-6 + Playwright Task 12 + regression Task 13. §10 guardrails → Global Constraints + mapped tasks. §9 non-goals honored (no quarterly/daily, no persistence).

**Refinement of spec §5.1 coverage wording:** eligibility is implemented as "≥1 valid model from data known at that year" (Task 3), with growth falling back to `0.0` when <2 income years — which is exactly `_pick_growth`'s own behavior with an empty snapshot. This is stricter-honest and matches guardrail #2/#4; `coverageFrom` = earliest such year.

**Reality note baked in:** yfinance exposes no filing date, so `effectiveDateSource` is `"assumed"` in practice; the `"filing"` branch and `filingDate` field are retained for future providers (Global Constraints + Task 4/6).

**Placeholder scan:** none — every code step carries real code; frontend uses `tsc`/build + Playwright (repo has no JS unit runner, by design — no new dependency introduced).

**Type consistency:** driver input key is `bvps` end-to-end (backend `inputs.bvps` + driver `inputs.bvps`; frontend labels it "Book value"). `models` keys `grahamNumber/grahamGrowth/dcf/fcf` consistent backend↔frontend. `snapshotAt`/`mergePriceWithSnapshots` signatures match their callers in Tasks 9-11.

# Slice A — Display-currency consistency (CHF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the valuation panel show Current Price, Fair Value, Graham Number, entry target and the intrinsic range in **one currency (CHF)** — matching the price the owner already sees in CHF — instead of a CHF price next to a native-currency (USD) fair value.

**Architecture:** The backend valuation engine stays entirely in the stock's native currency (Margin of Safety is a native/native ratio and is provably currency-invariant, so it is never touched). A new **additive** `displayCurrency` block is attached to the valuation payload at the single panel-facing route (`_valuation_now`), carrying the FX rate (via `fx.resolve_fx`, which never fabricates a rate) plus CHF-converted headline figures. The `ValueAnalysis` React component renders the display currency as the primary number with the native value as a faint secondary; when no FX rate resolves it falls back to native for **all** figures (never mixed) with a note.

**Tech Stack:** Python 3.12 / FastAPI, pytest (`backend/tests`), yfinance provider, frankfurter FX (`services/fx.py`); Vite + React + TypeScript + Tailwind (dark only), react-query, Recharts.

## Global Constraints

- Tailwind utility classes only; **dark mode only** (no `dark:` variants; use the semantic tokens `text`/`text-muted`/`text-faint`/`hairline`/`gain`/`loss`/`warn`).
- **Never fabricate financial data** — an unresolvable FX pair yields `fxRate: null` and **no** converted amounts; the UI shows "CHF conversion unavailable".
- Automated tests are **required for the financial engine only** (`backend/tests`, run `cd backend && .venv/bin/python -m pytest`). Frontend is hand-tested by the owner; its verification gate is `npm run build` (runs `tsc --noEmit && vite build`) from the repo root.
- **Margin of Safety is currency-invariant and must never be recomputed in a display currency** — it stays exactly as the backend already computes it (native/native).
- Additive only: do not change the existing native `currency`, `price`, `fairValue`, `intrinsic`, `marginOfSafety`, `entryTarget` fields or any existing consumer.
- Conventional Commits, many small commits. Backend restart is required for route changes (no DB migration — additive JSON only).
- Base currency is `"CHF"` (`reference/defaults.py:22`, `DEFAULT_TAX_SETTINGS["baseCurrency"]`).

---

### Task 1: `attach_display_currency` helper (backend, financial engine)

**Files:**
- Modify: `backend/app/services/valuation.py` (add a top-level function after `value_analysis`, ~line 415; add imports)
- Test: `backend/tests/test_display_currency.py` (create)

**Interfaces:**
- Consumes: `fx.resolve_fx(from_cur, to, date) -> FxResult(rate: float|None, source: str)` (`services/fx.py:90`); a `value_analysis` payload dict with keys `currency` (native code, e.g. `"USD"`), `price`, `fairValue`, `entryTarget`, `intrinsic{low,mid,high}`, `models{grahamNumber?, ...}`, `marginOfSafety`.
- Produces: `attach_display_currency(va: dict, base: str = "CHF", as_of: str | None = None) -> dict` — the same dict, mutated in place and returned, with an added `va["displayCurrency"]` block:
  - resolvable: `{code, fxRate, fxAsOf, fxSource, price, fairValue, grahamNumber, entryTarget, intrinsicLow, intrinsicMid, intrinsicHigh}` (converted amounts rounded to 2dp; `fxRate` rounded to 6dp).
  - unresolvable or no native currency: `{code, fxRate: null, fxAsOf, fxSource}` with **no** converted amounts.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_display_currency.py`:

```python
"""Slice A — display-currency block on the valuation payload.

The valuation engine stays native; this block lets the UI render every figure in one
currency (CHF) beside the native one. Margin of safety is currency-invariant and must be
unaffected. An unresolvable FX pair must NOT fabricate a rate.
"""
from __future__ import annotations

import pytest

from app.services import valuation, fx
from app.services.fx import FxResult


def _sample_va() -> dict:
    # A native-USD valuation payload shaped like value_analysis() output.
    return {
        "symbol": "UNH",
        "currency": "USD",
        "price": 300.0,
        "fairValue": 360.0,
        "entryTarget": 252.0,
        "intrinsic": {"low": 320.0, "mid": 360.0, "high": 400.0},
        "models": {"grahamNumber": 280.0, "dcf": 360.0},
        "marginOfSafety": round(360.0 / 300.0 - 1, 4),  # native/native = +0.20
    }


def test_block_converts_headline_figures_at_the_rate(monkeypatch):
    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(0.88, "cache"))
    out = valuation.attach_display_currency(_sample_va(), base="CHF", as_of="2026-08-28")
    dc = out["displayCurrency"]
    assert dc["code"] == "CHF"
    assert dc["fxRate"] == 0.88
    assert dc["fxSource"] == "cache"
    assert dc["price"] == pytest.approx(264.0, abs=0.01)       # 300 × 0.88
    assert dc["fairValue"] == pytest.approx(316.8, abs=0.01)   # 360 × 0.88
    assert dc["grahamNumber"] == pytest.approx(246.4, abs=0.01)  # 280 × 0.88
    assert dc["entryTarget"] == pytest.approx(221.76, abs=0.01)  # 252 × 0.88
    assert dc["intrinsicMid"] == pytest.approx(316.8, abs=0.01)


def test_margin_of_safety_is_currency_invariant(monkeypatch):
    """The whole point (spec §15): MoS in native == MoS after converting both to CHF."""
    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(0.88, "cache"))
    va = _sample_va()
    native_mos = va["marginOfSafety"]
    out = valuation.attach_display_currency(va, base="CHF")
    dc = out["displayCurrency"]
    chf_mos = round(dc["fairValue"] / dc["price"] - 1, 4)
    assert chf_mos == pytest.approx(native_mos, abs=1e-4)
    # The engine's own native MoS is untouched.
    assert out["marginOfSafety"] == native_mos


def test_unresolvable_fx_never_fabricates(monkeypatch):
    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(None, "unresolved"))
    out = valuation.attach_display_currency(_sample_va(), base="CHF")
    dc = out["displayCurrency"]
    assert dc["fxRate"] is None
    assert dc["fxSource"] == "unresolved"
    assert "price" not in dc and "fairValue" not in dc


def test_same_currency_is_identity(monkeypatch):
    # A CHF-native stock: rate 1.0, converted == native.
    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(1.0, "same"))
    va = _sample_va()
    va["currency"] = "CHF"
    out = valuation.attach_display_currency(va, base="CHF")
    dc = out["displayCurrency"]
    assert dc["fxRate"] == 1.0
    assert dc["price"] == pytest.approx(va["price"], abs=0.01)


def test_missing_native_currency_yields_null_block(monkeypatch):
    va = _sample_va()
    va["currency"] = None
    out = valuation.attach_display_currency(va, base="CHF")
    assert out["displayCurrency"]["fxRate"] is None
    assert "price" not in out["displayCurrency"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && .venv/bin/python -m pytest tests/test_display_currency.py -q`
Expected: FAIL — `AttributeError: module 'app.services.valuation' has no attribute 'attach_display_currency'`.

- [ ] **Step 3: Implement the helper**

In `backend/app/services/valuation.py`, add near the top with the other imports (the module already imports `math`; add these):

```python
from datetime import date as _date
from . import fx
```

Then add this top-level function immediately after the `value_analysis` function (after its closing `}` return, ~line 415):

```python
def attach_display_currency(va: dict, base: str = "CHF", as_of: str | None = None) -> dict:
    """Attach a `displayCurrency` block so the UI can render every valuation figure in ONE
    currency (`base`, e.g. CHF) beside the native one — instead of a CHF price next to a
    USD fair value. Purely additive: the native fields and the currency-invariant
    `marginOfSafety` are untouched. Never fabricates a rate — an unresolvable pair (or a
    payload with no native currency) yields {code, fxRate: None} and no converted amounts.
    """
    native = va.get("currency")
    as_of = as_of or _date.today().isoformat()
    if not native:
        va["displayCurrency"] = {"code": base, "fxRate": None, "fxAsOf": as_of, "fxSource": "unresolved"}
        return va

    r = fx.resolve_fx(native, base, as_of)
    if r.rate is None:
        va["displayCurrency"] = {"code": base, "fxRate": None, "fxAsOf": as_of, "fxSource": r.source}
        return va

    k = r.rate

    def cv(v):
        return round(v * k, 2) if isinstance(v, (int, float)) else None

    intrinsic = va.get("intrinsic") or {}
    models = va.get("models") or {}
    va["displayCurrency"] = {
        "code": base,
        "fxRate": round(k, 6),
        "fxAsOf": as_of,
        "fxSource": r.source,
        "price": cv(va.get("price")),
        "fairValue": cv(va.get("fairValue")),
        "grahamNumber": cv(models.get("grahamNumber")),
        "entryTarget": cv(va.get("entryTarget")),
        "intrinsicLow": cv(intrinsic.get("low")),
        "intrinsicMid": cv(intrinsic.get("mid")),
        "intrinsicHigh": cv(intrinsic.get("high")),
    }
    return va
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && .venv/bin/python -m pytest tests/test_display_currency.py -q`
Expected: PASS (5 passed).

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS — 94 passed (89 existing + 5 new).

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/valuation.py backend/tests/test_display_currency.py
git commit -m "feat(valuation): additive displayCurrency block (CHF) with currency-invariant MoS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

### Task 2: Wire the block into the valuation route

**Files:**
- Modify: `backend/app/routers/research.py` (`_valuation_now`, ~line 69)
- Test: `backend/tests/test_display_currency.py` (append one route-level test)

**Interfaces:**
- Consumes: `valuation.attach_display_currency` (Task 1); `value_analysis(symbol, price, currency, None, settings)` already called at `research.py:69`.
- Produces: the `/research/valuation/{symbol}` response now carries `displayCurrency` (the endpoint `api.valuation` hits — the single fetch behind the `ValueAnalysis` component, so PositionDetail, Research and OpportunityModal all receive it).

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_display_currency.py`:

```python
def test_valuation_now_attaches_display_currency(monkeypatch):
    """The panel route must carry displayCurrency so the component can render CHF."""
    from app.routers import research as research_router
    from app.services import fx
    from app.services.fx import FxResult

    monkeypatch.setattr(fx, "resolve_fx", lambda *a, **k: FxResult(0.9, "cache"))
    # Stub the engine so the test needs no provider/network.
    monkeypatch.setattr(
        research_router, "value_analysis",
        lambda *a, **k: {"symbol": "AAA", "currency": "USD", "price": 100.0,
                         "fairValue": 120.0, "entryTarget": 84.0,
                         "intrinsic": {"low": 110.0, "mid": 120.0, "high": 130.0},
                         "models": {"grahamNumber": 90.0}, "marginOfSafety": 0.2,
                         "hasData": True},
    )
    monkeypatch.setattr(research_router, "resolve_verdict", lambda *a, **k: {"verdict": "hold"})
    # portfolio_fit / repo lookups are best-effort and already wrapped in try/except.
    va = research_router._valuation_now("AAA", 100.0, "USD", settings={})
    assert va["displayCurrency"]["code"] == "CHF"
    assert va["displayCurrency"]["fairValue"] == pytest.approx(108.0, abs=0.01)  # 120 × 0.9
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && .venv/bin/python -m pytest tests/test_display_currency.py::test_valuation_now_attaches_display_currency -q`
Expected: FAIL — `KeyError: 'displayCurrency'`.

- [ ] **Step 3: Wire the helper into `_valuation_now`**

In `backend/app/routers/research.py`, `_valuation_now`, immediately after line 69 (`va = value_analysis(symbol, price, currency, None, settings)`) add:

```python
    from ..services.valuation import attach_display_currency
    attach_display_currency(va, base="CHF")
```

(Place it right after the `value_analysis(...)` call and before the `if freshness is not None:` block. It mutates `va` in place.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && .venv/bin/python -m pytest tests/test_display_currency.py::test_valuation_now_attaches_display_currency -q`
Expected: PASS.

- [ ] **Step 5: Full suite**

Run: `cd backend && .venv/bin/python -m pytest -q`
Expected: PASS — 95 passed.

- [ ] **Step 6: Commit**

```bash
git add backend/app/routers/research.py backend/tests/test_display_currency.py
git commit -m "feat(research): attach CHF displayCurrency to the valuation route

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

### Task 3: Render CHF primary + native secondary in `ValueAnalysis`

**Files:**
- Modify: `frontend/src/lib/api.ts` (`ValuationResult` interface, ~line 548-569)
- Modify: `frontend/src/components/ValueAnalysis.tsx` (~lines 79-188)

**Interfaces:**
- Consumes: `ValuationResult.displayCurrency` (new field, from Task 2); existing `fmtMoney(v: number, currency: string, decimals?)` (`lib/format.ts:54`).
- Produces: no new exported symbols — a rendering change only.

- [ ] **Step 1: Add the `displayCurrency` type**

In `frontend/src/lib/api.ts`, inside `export interface ValuationResult { ... }` (after `entryTarget: number | null;` at line 558), add:

```typescript
  /** One-currency display block (CHF): fxRate null = conversion unavailable. Additive;
   *  the native `currency`/`price`/`fairValue` fields are unchanged and MoS is invariant. */
  displayCurrency?: {
    code: string;
    fxRate: number | null;
    fxAsOf?: string;
    fxSource?: string;
    price?: number;
    fairValue?: number;
    grahamNumber?: number;
    entryTarget?: number;
    intrinsicLow?: number;
    intrinsicMid?: number;
    intrinsicHigh?: number;
  } | null;
```

- [ ] **Step 2: Add display-currency formatters in the component body**

In `frontend/src/components/ValueAnalysis.tsx`, replace the single line at 79:

```typescript
  const ccy = data.currency || currency || '';
```

with:

```typescript
  const ccy = data.currency || currency || '';
  // Display currency (CHF): when an FX rate resolved, render every figure converted to the
  // base currency as the PRIMARY number, with the native value as a faint secondary — so
  // the price and the fair value are never shown in different currencies. When no rate
  // resolved, fall back to native for everything (never mixed). MoS is currency-invariant,
  // so multiplying every figure by the same rate preserves all relationships.
  const dc = data.displayCurrency ?? null;
  const fxRate = dc && dc.fxRate != null ? dc.fxRate : null;
  const dispCcy = fxRate != null ? dc!.code : ccy;
  const money = (v: number | null | undefined) =>
    v == null ? '—' : fmtMoney(fxRate != null ? v * fxRate : v, dispCcy);
  const nativeSub = (v: number | null | undefined) =>
    fxRate != null && v != null ? fmtMoney(v, ccy) : null;
```

- [ ] **Step 3: Use `money()` for every figure and add native secondaries**

In the same file, make these exact replacements (all within the "Verdict headline" card and the models block, lines ~141-181):

Replace the fair-value figure (line 141):
```jsx
            {mid != null ? fmtMoney(mid, ccy) : '—'}
```
with:
```jsx
            {money(mid)}
            {nativeSub(mid) && <span className="ml-2 text-sm font-normal text-text-faint">{nativeSub(mid)}</span>}
```

Replace the range line (line 145):
```jsx
              range {fmtMoney(data.intrinsic.low, ccy)} – {fmtMoney(data.intrinsic.high, ccy)}
```
with:
```jsx
              range {money(data.intrinsic.low)} – {money(data.intrinsic.high)}
```

Replace the "at … today" price (line 159):
```jsx
            at {px != null ? fmtMoney(px, ccy) : '—'} today
```
with:
```jsx
            at {money(px)} today
            {nativeSub(px) && <span className="ml-1 text-text-faint">({nativeSub(px)})</span>}
```

Replace the entry-target figure (line 165):
```jsx
              <span className="font-mono text-gain tnum">{fmtMoney(data.entryTarget, ccy)}</span>
```
with:
```jsx
              <span className="font-mono text-gain tnum">{money(data.entryTarget)}</span>
```

Replace the model chips value (line 176):
```jsx
                <div className="font-mono text-text tnum">{fmtMoney(v, ccy)}</div>
```
with:
```jsx
                <div className="font-mono text-text tnum">{money(v)}</div>
```

Replace the prose price (line 181):
```jsx
            At {px != null ? fmtMoney(px, ccy) : 'today’s price'} the market is pricing in about{' '}
```
with:
```jsx
            At {px != null ? money(px) : 'today’s price'} the market is pricing in about{' '}
```

- [ ] **Step 4: Add the FX footer / unavailable note**

In `frontend/src/components/ValueAnalysis.tsx`, immediately after the entry-target `</div>` block that closes at line 168 (inside the fair-value card, right before its closing `</div>` at line 169), add:

```jsx
          {dc && fxRate != null && (
            <div className="text-[10px] text-text-faint mt-1">
              FX {ccy}→{dc.code} {fxRate.toFixed(4)}{dc.fxAsOf ? ` · ${dc.fxAsOf}` : ''}
            </div>
          )}
          {dc && dc.fxRate == null && ccy !== 'CHF' && (
            <div className="text-[10px] text-warn mt-1">CHF conversion unavailable — shown in {ccy}</div>
          )}
```

- [ ] **Step 5: Verify the frontend builds**

Run: `npm run build`
Expected: `tsc --noEmit` clean and `vite build` succeeds (no type errors on `displayCurrency`).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/ValueAnalysis.tsx
git commit -m "feat(value-analysis): render CHF as primary with native secondary; FX footer

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

### Task 4: Fix the native-price-labelled-as-CHF bug on closed positions

**Files:**
- Modify: `frontend/src/views/PositionDetail.tsx:335`

**Interfaces:**
- Consumes: existing `fmtCHF` / `fmtMoney` from `lib/format.ts`; `p.currentPrice` (native), `p.currentValueCHF` (CHF), `inst.currency`.
- Produces: rendering change only.

**Context:** On the position header (line 220) a held position already shows the per-share price in CHF (`currentValueCHF / openQuantity`) with the native value as a secondary — that is correct and matches the panel after Task 3. The defect is the "Current price" Stat at line 335: for a **closed** position (`openQuantity == 0`) it calls `fmtCHF(p.currentPrice, true)`, formatting a **native** price with a CHF symbol. Fix it to label the native price in its native currency.

- [ ] **Step 1: Make the closed-position branch currency-correct**

In `frontend/src/views/PositionDetail.tsx`, replace line 335:

```jsx
                value={p.openQuantity > 0 && p.currentValueCHF != null ? fmtCHF(p.currentValueCHF / p.openQuantity, true) : fmtCHF(p.currentPrice, true)}
```

with:

```jsx
                value={p.openQuantity > 0 && p.currentValueCHF != null ? fmtCHF(p.currentValueCHF / p.openQuantity, true) : fmtMoney(p.currentPrice ?? null, inst.currency, true)}
```

(`fmtMoney` is already imported in this file — confirm the import line near the top includes `fmtMoney`; it is used at line 225.)

- [ ] **Step 2: Verify the frontend builds**

Run: `npm run build`
Expected: `tsc --noEmit` clean and `vite build` succeeds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/views/PositionDetail.tsx
git commit -m "fix(position): show closed-position price in its native currency, not mislabelled CHF

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

## Owner verification (hand-tested running app)

After a **backend restart** (to pick up the route change):
1. Open a USD stock you hold (e.g. UnitedHealth) via Decisions → the position detail.
2. The header price and the Value-analysis panel's Fair Value / Graham / entry target are now **all in CHF**, with a faint native `(USD …)` secondary and an `FX USD→CHF …` footer line.
3. Margin of Safety percentage is unchanged from before.
4. If FX is unavailable for a currency, the panel shows everything in the native currency with a "CHF conversion unavailable" note — never one CHF figure beside one USD figure.

## Self-review notes

- **Spec coverage (§11–16, §23 currency block):** §11/§12 consistent display currency — Tasks 1–3. §13 preserve original currency — native fields untouched, native shown as secondary. §14 Fair Value/Graham conversion — Task 1 `cv()`. §15 MoS currency-neutral — `test_margin_of_safety_is_currency_invariant` + MoS never recomputed. §16 reuse existing FX, safe on missing rate — uses `fx.resolve_fx`, null block on unresolved. §23 "MoS in USD == MoS after converting both to CHF" — asserted.
- **No forced Sell / no fabrication:** no verdict logic touched; unresolved FX never fabricates.
- **Type consistency:** `attach_display_currency` block keys match the `ValuationResult.displayCurrency` TS type exactly (`code`, `fxRate`, `fxAsOf`, `fxSource`, `price`, `fairValue`, `grahamNumber`, `entryTarget`, `intrinsicLow/Mid/High`).

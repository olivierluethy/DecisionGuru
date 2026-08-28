# Slice 1 — Correctness core (ownership-aware verdict, portfolio fit, external links)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make every recommendation ownership-aware (owned → Buy more/Hold/Reduce/Sell; not-owned → Buy/Watch/Avoid), add a Portfolio Fit panel (direct + indirect ETF exposure, honestly marked unavailable), and add external Yahoo/Google Finance links — all reusing the existing single verdict engine and exposure/allocation modules.

**Architecture:** The canonical verdict key (`buy-more | hold | sell`) is unchanged so no consumer breaks and the "one engine" invariant holds. `resolve_verdict` gains an additive `action: {key,label,owned}` derived from the `held` flag. "Owned" becomes a correct offline test (net open quantity > 0), and the two candidate paths (`screener.py`, research `valuation` endpoint) pass `held = owned`. A new read-only `/api/analysis/fit/{symbol}` reuses `exposure.py`/`allocation.py` for direct+indirect exposure. Frontend renders `action.label` and a `PortfolioFit` component, plus external links.

**Tech Stack:** Python 3.12 / FastAPI (backend, port 5178), React + Vite + Tailwind (frontend), SQLite. Package mgrs: `uv` (backend), `npm` (frontend).

## Global Constraints

- Tailwind only; **dark mode only**; **modals not page redirects**.
- Conventional Commits, many small commits. End commit messages with the two trailer lines used in this repo.
- **Implementation only — no automated tests / Playwright / verification agents.** The owner tests the running app. Verification per task = frontend `npm run build` clean, backend import/route smoke that does NOT call Yahoo.
- **Never fabricate financial data.** Unavailable exposure is `available: false` + a note, never a number.
- The canonical verdict key stays `buy-more | hold | sell`. `action` is additive; benchmark underperformance alone still never yields Sell.
- Backend restart is required after Task 1/Task 3 to pick up changes (owner does this).

---

## File structure

- `backend/app/services/repo.py` — add `owned_symbol_set()` (offline held test).
- `backend/app/services/verdict.py` — add `_action_for()` + `action` field in `resolve_verdict`.
- `backend/app/services/screener.py` — pass `held = sym in owned`; row `inPortfolio` reflects held.
- `backend/app/routers/research.py` — `_valuation_now` passes `held = owned`.
- `backend/app/services/fit.py` — **new** portfolio-fit service.
- `backend/app/routers/analysis.py` — **new** `GET /fit/{symbol}` route.
- `frontend/src/lib/api.ts` — `Verdict.action` type, `PortfolioFit` type, `api.fit()`.
- `frontend/src/components/Verdict.tsx` — `VerdictBadge` accepts optional `action`.
- `frontend/src/components/PortfolioFit.tsx` — **new** panel.
- `frontend/src/lib/externalLinks.ts` — **new** URL builders.
- `frontend/src/modals/OpportunityModal.tsx`, `frontend/src/views/PositionDetail.tsx` — wire fit + links.
- `frontend/src/views/Screener.tsx`, `frontend/src/components/ValueAnalysis.tsx` — pass `action` to the badge.

---

## Task 1: Ownership-aware verdict (backend)

**Files:**
- Modify: `backend/app/services/repo.py` (after `get_transactions`, ~line 45)
- Modify: `backend/app/services/verdict.py` (`resolve_verdict` return, and a new helper)
- Modify: `backend/app/services/screener.py:66-70,109,138`
- Modify: `backend/app/routers/research.py:54-76` (`_valuation_now`)

**Interfaces:**
- Produces: `repo.owned_symbol_set() -> set[str]`; `resolve_verdict(...)['action'] = {'key': str, 'label': str, 'owned': bool}`.

- [ ] **Step 1: Add the offline ownership helper to `repo.py`**

Append after `get_transactions` (line 45):

```python
def owned_symbol_set() -> set[str]:
    """Symbols currently held — net open quantity (buys − sells) > 0 — computed OFFLINE
    from transactions only, no provider calls. This is the canonical 'owned' test:
    a fully-sold instrument (net qty 0) is NOT owned, per the ownership model."""
    rows = db.q(
        """SELECT i.symbol AS symbol,
                  SUM(CASE t.action WHEN 'buy' THEN t.quantity
                                    WHEN 'sell' THEN -t.quantity ELSE 0 END) AS net
             FROM instruments i JOIN transactions t ON t.instrumentId = i.id
            WHERE i.symbol IS NOT NULL
            GROUP BY i.symbol"""
    ).all()
    return {r["symbol"] for r in rows if (r["net"] or 0) > 1e-9}
```

- [ ] **Step 2: Add the label mapper + `action` field to `verdict.py`**

Add this helper above `resolve_verdict` (e.g. after `LABELS` at line 36):

```python
# Ownership-aware action wording. The canonical key is unchanged; this only chooses the
# verb the user sees, so an un-owned name never reads "Buy more". `trim` = the overvalued
# (not sell-zone) Hold that carries a trim note.
def _action_for(verdict_key: str, *, held: bool, trim: bool) -> dict:
    if verdict_key == "buy-more":
        label = "Buy more" if held else "Buy"
    elif verdict_key == "sell":
        label = "Sell" if held else "Avoid"
    elif trim:
        label = "Reduce" if held else "Watch"
    else:  # plain hold / no valuation
        label = "Hold" if held else "Watch"
    return {"key": verdict_key, "label": label, "owned": held}
```

In `resolve_verdict`, add `action` to the returned dict (after `"label": LABELS[verdict],` at line 190 insert):

```python
        "action": _action_for(verdict, held=held, trim=bool(trim_note)),
```

- [ ] **Step 3: Screener passes `held = owned` and reports held-based `inPortfolio`**

In `screener.py`, import and compute the owned set. Replace line 66-67 region:

```python
    owned = repo.owned_symbol_set()
    holdings = {i["symbol"]: i for i in repo.list_instruments() if i.get("symbol")}
    watch = {w["symbol"]: w for w in list_watchlist() if w.get("symbol")}
```

Change the verdict call at line 109 from `rec = resolve_verdict(va, held=False)` to:

```python
        rec = resolve_verdict(va, held=(sym in owned))
```

Change the row flag at line 138 from `"inPortfolio": sym in holdings,` to:

```python
            "inPortfolio": sym in owned,
```

(`holdings` is still used for name/isin lookup at lines 113-114,127 — keep it.)

- [ ] **Step 4: Research valuation endpoint passes `held = owned`**

In `research.py` `_valuation_now` (line 74) replace `rec = resolve_verdict(va, held=False)` with:

```python
    from ..services import repo
    rec = resolve_verdict(va, held=(symbol in repo.owned_symbol_set()))
```

(Leave `_valuation_as_of` at line 87 as `held=False` — a historical replay is not an ownership statement.)

- [ ] **Step 5: Backend smoke (no Yahoo)**

Run:
```bash
cd backend && uv run python -c "from app.services.verdict import resolve_verdict; \
print(resolve_verdict({'band':{'band':'undervalued'},'marginOfSafety':0.3,'quality':{'score':6,'max':8}}, held=False)['action']); \
print(resolve_verdict({'band':{'band':'undervalued'},'marginOfSafety':0.3,'quality':{'score':6,'max':8}}, held=True)['action'])"
```
Expected: first prints `{'key': 'buy-more', 'label': 'Buy', 'owned': False}`, second `... 'label': 'Buy more', 'owned': True`.

- [ ] **Step 6: Commit**

```bash
git add backend/app/services/repo.py backend/app/services/verdict.py backend/app/services/screener.py backend/app/routers/research.py
git commit -m "feat(verdict): ownership-aware action wording driven by an offline held test"
```

---

## Task 2: Render ownership-aware labels (frontend)

**Files:**
- Modify: `frontend/src/lib/api.ts` (the `Verdict` type)
- Modify: `frontend/src/components/Verdict.tsx` (`VerdictBadge`)
- Modify: `frontend/src/views/Screener.tsx:548`
- Modify: `frontend/src/components/ValueAnalysis.tsx:91`

**Interfaces:**
- Consumes: backend `action` from Task 1.
- Produces: `VerdictBadge` optional `action?: { key: VerdictKey; label: string; owned: boolean } | null` prop.

- [ ] **Step 1: Add `action` to the `Verdict` type in `api.ts`**

Find the `Verdict` interface/type and add:

```ts
  action?: { key: VerdictKey; label: string; owned: boolean } | null;
```

- [ ] **Step 2: `VerdictBadge` renders the action label when present**

In `Verdict.tsx`, extend the prop list (line 22-28) with `action`, and derive the label:

```tsx
export function VerdictBadge({
  verdict,
  action,
  confidence,
  withIcon = false,
  title,
  className,
}: {
  verdict: VerdictKey;
  action?: { label: string } | null;
  confidence?: string | null;
  withIcon?: boolean;
  title?: string;
  className?: string;
}) {
  const m = VERDICT_META[verdict];
  const label = action?.label ?? m.label;
```

Then render `{label}` instead of `{m.label}` (line 34). Colour/icon still come from `m` (the key), so an owned "Reduce" keeps the neutral Hold colour and a not-owned "Buy" keeps the gain colour.

- [ ] **Step 3: Pass `action` from the Discover row**

`Screener.tsx:548` → `<td className="td"><VerdictBadge verdict={r.verdict} action={r.recommendation?.action} /></td>`. If the row type doesn't expose `recommendation`, add `recommendation?: Verdict` to the screener row type in `api.ts`.

- [ ] **Step 4: Pass `action` in `ValueAnalysis`**

`ValueAnalysis.tsx:91` → `<VerdictBadge verdict={rec.verdict} action={rec.action} confidence={rec.confidence} withIcon />`. This covers the OpportunityModal, Research, and the per-position ValueAnalysis. (Other standalone badges — Decisions, Advisory, PositionDetail header, Dashboard — are owned surfaces computed with `held=True`, so their default key labels already read correctly; pass `action={<obj>.action}` opportunistically where a full verdict object is in scope, but it is not required for correctness.)

- [ ] **Step 5: Build**

Run: `npm run build` (from repo root, or `npm run build --workspace frontend`). Expected: tsc + vite build clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/Verdict.tsx frontend/src/views/Screener.tsx frontend/src/components/ValueAnalysis.tsx
git commit -m "feat(verdict-ui): render the ownership-aware action label on the verdict badge"
```

---

## Task 3: Portfolio Fit service + endpoint (backend)

**Files:**
- Create: `backend/app/services/fit.py`
- Modify: `backend/app/routers/analysis.py` (add route; reuse existing `run_in_threadpool` + settings pattern already in the file)

**Interfaces:**
- Consumes: `exposure.portfolio_exposure(settings)`, `allocation.build_allocation(instrument)`, `repo.list_instruments/owned_symbol_set`, `fundamentals.get_cached_fundamentals`, `reference.geo`.
- Produces: `fit.portfolio_fit(symbol, settings) -> dict`; `GET /api/analysis/fit/{symbol}`.

- [ ] **Step 1: Write `fit.py`**

```python
"""Portfolio-fit read for a candidate symbol: does buying it actually improve THIS
portfolio? Reuses the existing exposure/allocation engines — no new data source, and it
never fabricates a percentage. Indirect exposure is limited to the provider's top-holdings
slice (all we have); a name outside every owned ETF's top holdings is reported as
'indirect unavailable', not zero-with-false-confidence.
"""
from __future__ import annotations

from . import repo
from .exposure import portfolio_exposure
from .allocation import build_allocation
from .fundamentals import get_cached_fundamentals
from ..reference import geo


def _sector_of(symbol: str) -> str | None:
    cached = get_cached_fundamentals(symbol)
    snap = (cached or {}).get("snapshot") or {}
    return snap.get("sector")


def portfolio_fit(symbol: str, settings: dict) -> dict:
    owned = repo.owned_symbol_set()
    exposure = portfolio_exposure(settings)            # value-weighted, held only
    holdings = exposure.get("holdings", [])            # [{instrumentId,symbol,name,weight,valueCHF}]
    weight_by_symbol = {h["symbol"]: h.get("weight", 0.0) for h in holdings}

    is_owned = symbol in owned
    direct_weight = weight_by_symbol.get(symbol, 0.0) if is_owned else 0.0

    # Indirect: for each owned ETF, does the candidate appear in its top holdings?
    instruments = {i["symbol"]: i for i in repo.list_instruments() if i.get("symbol")}
    contributors: list[dict] = []
    for h in holdings:
        inst = instruments.get(h["symbol"])
        if not inst or inst.get("kind") != "etf":
            continue
        alloc = build_allocation(inst)                 # cached fund summary → topHoldings
        for top in alloc.get("topHoldings", []):
            if top.get("symbol") and top["symbol"] == symbol:
                contrib = (top.get("weight") or 0.0) * (h.get("weight") or 0.0)
                if contrib > 0:
                    contributors.append({
                        "etfSymbol": h["symbol"], "etfName": h.get("name"),
                        "viaWeight": round(contrib, 4),
                    })
    indirect_available = bool(contributors)
    indirect_weight = round(sum(c["viaWeight"] for c in contributors), 4) if indirect_available else None
    effective = round(direct_weight + (indirect_weight or 0.0), 4) if indirect_available else direct_weight

    # Diversification: candidate sector vs the portfolio's sector rollup.
    cand_sector = _sector_of(symbol)
    pf_sectors = {s["label"].lower(): s["weight"] for s in exposure.get("sectors", []) if s.get("label")}
    sector_weight = pf_sectors.get(cand_sector.lower(), 0.0) if cand_sector else None
    if cand_sector is None:
        div_status, div_note = "unknown", "Sector unavailable — cannot assess diversification."
    elif sector_weight == 0.0:
        div_status, div_note = "diversifies", f"New sector for this portfolio ({cand_sector})."
    elif sector_weight < 0.25:
        div_status, div_note = "neutral", f"Adds to an existing {cand_sector} weight ({sector_weight*100:.0f}%)."
    else:
        div_status, div_note = "concentrates", f"Already heavy in {cand_sector} ({sector_weight*100:.0f}%)."

    high = effective is not None and effective >= 0.15
    concentration_note = (
        f"Effective exposure is already ~{effective*100:.0f}% — buying more raises concentration."
        if (high and (is_owned or indirect_available)) else None
    )

    return {
        "symbol": symbol,
        "owned": is_owned,
        "directWeight": round(direct_weight, 4),
        "country": geo.country_from_symbol(symbol),
        "sector": cand_sector,
        "indirect": (
            {"available": True, "weight": indirect_weight, "coverage": "top-holdings-only",
             "note": "From each owned ETF's top holdings only — may understate.",
             "contributors": contributors}
            if indirect_available else
            {"available": False,
             "note": "Not among any owned ETF's top holdings; broader constituents unavailable."}
        ),
        "effectiveExposure": effective,
        "diversification": {"status": div_status, "sectorWeight": sector_weight, "note": div_note},
        "concentrationNote": concentration_note,
    }
```

- [ ] **Step 2: Add the route to `analysis.py`**

Mirror the existing threadpool pattern in the file (see the `portfolio` route ~line 253). Add near the other GET routes:

```python
@router.get("/fit/{symbol:path}")
async def fit(symbol: str) -> dict:
    from ..services.fit import portfolio_fit
    from ..core.db import get_settings

    settings = get_settings()

    def _work() -> dict:
        return portfolio_fit(symbol, settings)

    return await run_in_threadpool(_work)
```

Match the file's actual settings accessor and `run_in_threadpool` import (both already used elsewhere in `analysis.py` — copy those exact call shapes rather than the illustrative names here).

- [ ] **Step 3: Backend route-registration smoke (no Yahoo)**

Run:
```bash
cd backend && uv run python -c "from app.main import app; print([r.path for r in app.routes if 'fit' in getattr(r,'path','')])"
```
Expected: prints a list containing `/api/analysis/fit/{symbol}`.

- [ ] **Step 4: Commit**

```bash
git add backend/app/services/fit.py backend/app/routers/analysis.py
git commit -m "feat(analysis): portfolio-fit endpoint (direct + indirect ETF exposure, no fabrication)"
```

---

## Task 4: Portfolio Fit panel (frontend)

**Files:**
- Modify: `frontend/src/lib/api.ts` (`PortfolioFit` type + `api.fit()`)
- Create: `frontend/src/components/PortfolioFit.tsx`
- Modify: `frontend/src/modals/OpportunityModal.tsx` (render panel)
- Modify: `frontend/src/views/PositionDetail.tsx` (render panel)

**Interfaces:**
- Consumes: `GET /api/analysis/fit/{symbol}` from Task 3.
- Produces: `<PortfolioFit symbol=... />`.

- [ ] **Step 1: Type + client in `api.ts`**

Add (match the file's existing fetch helper style — copy the shape of a neighbouring `api.valuation`):

```ts
export interface PortfolioFit {
  symbol: string;
  owned: boolean;
  directWeight: number;
  country: string | null;
  sector: string | null;
  indirect:
    | { available: true; weight: number; coverage: string; note: string;
        contributors: { etfSymbol: string; etfName: string | null; viaWeight: number }[] }
    | { available: false; note: string };
  effectiveExposure: number | null;
  diversification: { status: string; sectorWeight: number | null; note: string };
  concentrationNote: string | null;
}
```
```ts
  fit: (symbol: string) =>
    get<PortfolioFit>(`/api/analysis/fit/${encodeURIComponent(symbol)}`),
```
(Use whatever the file's internal GET helper is actually named.)

- [ ] **Step 2: Write `PortfolioFit.tsx`**

```tsx
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Spinner } from './ui';
import { fmtPct } from '../lib/format';

/** "Does buying this improve MY portfolio?" — ownership, direct + indirect ETF exposure,
 *  and a diversification read. Unavailable data is labelled, never fabricated. */
export function PortfolioFit({ symbol }: { symbol: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['fit', symbol],
    queryFn: () => api.fit(symbol),
    staleTime: 10 * 60_000,
    retry: 1,
  });

  if (isLoading) return <Spinner label="Checking portfolio fit…" />;
  if (isError || !data) return <p className="text-sm text-text-faint">Portfolio fit unavailable for {symbol}.</p>;

  const ind = data.indirect;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="eyebrow">Portfolio fit</span>
        <span className="chip !py-0 !px-2">{data.owned ? 'Owned' : 'Not owned'}</span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
        <dt className="text-text-faint">Direct exposure</dt>
        <dd className="tnum">{data.owned ? fmtPct(data.directWeight) : '0%'}</dd>
        <dt className="text-text-faint">Indirect (ETF)</dt>
        <dd className="tnum">{ind.available ? fmtPct(ind.weight) : 'unavailable'}</dd>
        <dt className="text-text-faint">Effective exposure</dt>
        <dd className="tnum">{data.effectiveExposure != null ? fmtPct(data.effectiveExposure) : '—'}</dd>
      </dl>
      {ind.available && (
        <p className="text-[12px] text-text-faint">
          via {ind.contributors.map((c) => `${c.etfSymbol} (${fmtPct(c.viaWeight)})`).join(', ')} · {ind.note}
        </p>
      )}
      {!ind.available && <p className="text-[12px] text-text-faint">{ind.note}</p>}
      <p className="text-[13px] text-text-muted">{data.diversification.note}</p>
      {data.concentrationNote && <p className="text-[12px] text-warn">{data.concentrationNote}</p>}
    </div>
  );
}
```
(If `fmtPct` expects a fraction, `directWeight`/`weight` are already fractions — confirm against `format.ts`; adjust the call if it expects percent points.)

- [ ] **Step 3: Render in `OpportunityModal.tsx`**

Import `PortfolioFit` and add a bordered section after the `ListingRecommendation` block (after line 52):

```tsx
      <div className="mt-6 pt-5 border-t border-hairline">
        <PortfolioFit symbol={symbol} />
      </div>
```

- [ ] **Step 4: Render in `PositionDetail.tsx`**

Import `PortfolioFit` and place it in the analysis column near the ValueAnalysis block (choose the existing card/grid slot; a `<PortfolioFit symbol={p.symbol} />` inside a `card` div consistent with neighbours).

- [ ] **Step 5: Build**

Run: `npm run build`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.ts frontend/src/components/PortfolioFit.tsx frontend/src/modals/OpportunityModal.tsx frontend/src/views/PositionDetail.tsx
git commit -m "feat(fit-ui): Portfolio Fit panel in the opportunity modal & position detail"
```

---

## Task 5: External research links (frontend)

**Files:**
- Create: `frontend/src/lib/externalLinks.ts`
- Modify: `frontend/src/modals/OpportunityModal.tsx` (a "Learn more" row)
- Modify: `frontend/src/views/PositionDetail.tsx` (header links)

**Interfaces:**
- Produces: `yahooUrl(symbol) -> string | null`, `googleUrl(symbol, exchange?) -> string | null`.

- [ ] **Step 1: Write `externalLinks.ts`**

```ts
/** Outbound research links. Returns null when a reliable URL can't be built, so the caller
 *  hides that destination rather than emit a broken link. */

// Yahoo uses the same suffixed symbol we already store (e.g. NESN.SW, SSAC.L).
export function yahooUrl(symbol?: string | null): string | null {
  if (!symbol) return null;
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
}

// Google Finance needs TICKER:EXCHANGE. Map the Yahoo suffix → Google exchange code; a
// plain (US) symbol defaults to NASDAQ. Unknown suffix → null (hide the button).
const GOOGLE_EXCHANGE: Record<string, string> = {
  SW: 'SWX', L: 'LON', DE: 'ETR', PA: 'EPA', MI: 'BIT', AS: 'AMS', MC: 'BME',
  TO: 'TSE', T: 'TYO', HK: 'HKG', AX: 'ASX', SS: 'SHA', SZ: 'SHE', KS: 'KRX',
};

export function googleUrl(symbol?: string | null, _exchange?: string | null): string | null {
  if (!symbol) return null;
  const dot = symbol.lastIndexOf('.');
  if (dot === -1) return `https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:NASDAQ`;
  const base = symbol.slice(0, dot);
  const suffix = symbol.slice(dot + 1).toUpperCase();
  const exch = GOOGLE_EXCHANGE[suffix];
  if (!base || !exch) return null;
  return `https://www.google.com/finance/quote/${encodeURIComponent(base)}:${exch}`;
}
```

- [ ] **Step 2: "Learn more" row in `OpportunityModal.tsx`**

Import the helpers and render, before the closing `</Modal>`:

```tsx
      {(() => {
        const y = yahooUrl(symbol); const g = googleUrl(symbol, currency);
        if (!y && !g) return null;
        return (
          <div className="mt-6 pt-5 border-t border-hairline">
            <p className="eyebrow mb-2">Want to learn more about this investment?</p>
            <div className="flex gap-2 flex-wrap">
              {g && <a className="btn-secondary" href={g} target="_blank" rel="noopener noreferrer">Open in Google Finance</a>}
              {y && <a className="btn-secondary" href={y} target="_blank" rel="noopener noreferrer">Open in Yahoo Finance</a>}
            </div>
          </div>
        );
      })()}
```

- [ ] **Step 3: Header links in `PositionDetail.tsx`**

Add the same two `<a target="_blank" rel="noopener noreferrer">` buttons (guarded by non-null URL) near the position header actions, using `p.symbol`.

- [ ] **Step 4: Build**

Run: `npm run build`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/externalLinks.ts frontend/src/modals/OpportunityModal.tsx frontend/src/views/PositionDetail.tsx
git commit -m "feat(links): Google/Yahoo Finance research links on opportunity & position views"
```

---

## Self-review notes
- **Spec coverage:** ownership-aware wording (§1,§33) = Task 1-2; portfolio fit / direct+indirect / overlap / concentration / diversification (§7-13,§37-39) = Task 3-4; external links (§16) = Task 5. Export/branding/responsive are Slices 2-3 (separate plans).
- **No fabrication:** indirect exposure returns `available:false` when no owned-ETF top-holding matches; sector "unknown" when cached fundamentals lack it.
- **Type consistency:** `action` shape identical in `verdict.py` (`{key,label,owned}`) and `api.ts`; `owned_symbol_set` used identically in screener + research + fit.
- **No regression:** verdict key unchanged; `action`/`VerdictBadge action` additive with fallback to `VERDICT_META[key].label`.
- **Manual verification only** (owner constraint): builds + no-Yahoo import smokes; owner restarts backend and checks Discover (Nvidia → "Buy"), an owned name (→ "Buy more"), the Fit panel, and the two external links.

# Slice B — Generalize CompareModal to any security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the VS comparison modal compare holdings against **any searched stock / ETF / index**, not just the five hardcoded benchmark ETFs — while keeping the existing ETF chips and all current behavior.

**Architecture:** Frontend-only. `POST /analysis/compare` already accepts an arbitrary `benchmarks: string[]` and the counterfactual engine already resolves any symbol via `_resolve_benchmark`, so no backend change is needed. `CompareModal` gains a `SymbolSearch` input that appends picked symbols to the existing `selected` list, and renders a removable chip for every selected symbol (the settings benchmarks plus any searched extras). User-facing "ETF" wording that no longer fits (a stock can now be a comparison target) is relabelled to the neutral "Alt." (the counterfactual/alternative), keeping the gold counterfactual colour.

**Tech Stack:** Vite + React + TypeScript + Tailwind (dark only), react-query.

## Global Constraints

- Tailwind utility classes only; **dark mode only**; use existing semantic tokens (`azure`/`gold`/`text`/`text-faint`/`hairline`). The counterfactual/alternative stays **gold** per the styleguide.
- **Modals not page redirects** — this is a change to the existing modal; do not add a route.
- **Existing ETF comparisons must keep working** — the five settings benchmark chips remain, `selected` still seeds from the default `benchmark`, and the `/analysis/compare` call is unchanged in shape.
- **Never fabricate data** — if a searched symbol has no cached history the backend returns an empty/degraded comparison; surface it, don't invent it.
- No automated frontend tests in this project (owner constraint) — the verification gate is `npm run build` (runs `tsc --noEmit && vite build`) from the repo root. A pre-existing ">500 kB chunk" warning is expected and fine.
- Conventional Commits.

---

### Task 1: Wire arbitrary-security search into CompareModal

**Files:**
- Modify: `frontend/src/modals/CompareModal.tsx`

**Interfaces:**
- Consumes: `SymbolSearch` (`frontend/src/components/SymbolSearch.tsx`) with prop `onPick: (p: SymbolPick) => void`, where `SymbolPick = { symbol: string; name: string; kind: string }` (exported from that file); existing `api.compare(basket, selected, preTax)`; existing `KindBadge` from `../components/ui`.
- Produces: no new exported symbols — a change to the modal only.

- [ ] **Step 1: Import SymbolSearch and its type**

In `frontend/src/modals/CompareModal.tsx`, add to the imports near the top (after the `ui` import at line 7):

```typescript
import { SymbolSearch, type SymbolPick } from '../components/SymbolSearch';
```

- [ ] **Step 2: Track searched picks and add an appender**

In the component body, right after the `const [selected, setSelected] = useState<string[]>([benchmark]);` line (line 44), add:

```typescript
  // Searched-in comparison targets (symbol → its display name/kind), so any stock/ETF/index
  // — not just the settings benchmark ETFs — can be compared against. `selected` remains the
  // single source of truth for which symbols /analysis/compare receives.
  const [picks, setPicks] = useState<Record<string, SymbolPick>>({});
  const addPick = (p: SymbolPick) =>
    setSelected((s) => {
      setPicks((m) => ({ ...m, [p.symbol]: p }));
      return s.includes(p.symbol) ? s : [...s, p.symbol];
    });
```

- [ ] **Step 3: Compute which selected symbols are searched extras**

Right after the `const benchmarks = settings?.benchmarks ?? [];` line (line 49), add:

```typescript
  const benchSymbols = new Set(benchmarks.map((b) => b.symbol));
  const extraSelected = selected.filter((s) => !benchSymbols.has(s));
```

- [ ] **Step 4: Relabel the section, render extra chips, and add the search box**

Replace the whole "Benchmark ETFs" block — from `<div className="label">Benchmark ETFs</div>` (line 110) through the closing `</div>` of the benchmark chip list (line 126) — with:

```jsx
            <div className="label">Compare against (stocks, ETFs, indices)</div>
            <div className="flex flex-wrap gap-2">
              {benchmarks.map((b) => {
                const on = selected.includes(b.symbol);
                return (
                  <button
                    key={b.symbol}
                    onClick={() => toggleBench(b.symbol)}
                    className={`chip cursor-pointer ${on ? '!border-gold/60 !text-gold' : ''}`}
                    title={b.name}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-gold' : 'bg-hairline-strong'}`} />
                    {b.symbol}
                  </button>
                );
              })}
              {extraSelected.map((sym) => {
                const p = picks[sym];
                return (
                  <button
                    key={sym}
                    onClick={() => toggleBench(sym)}
                    className="chip cursor-pointer !border-gold/60 !text-gold"
                    title={p ? `${p.name} — click to remove` : 'click to remove'}
                  >
                    {p && <KindBadge kind={p.kind} />}
                    {sym}
                    <span className="ml-1 text-text-faint">×</span>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 max-w-sm">
              <SymbolSearch onPick={addPick} />
            </div>
```

(Note: `toggleBench` already removes a symbol that is currently in `selected`, so clicking an extra chip removes it — the `×` signals this. Every extra chip is by definition selected, so it always renders gold.)

- [ ] **Step 5: Relabel remaining user-facing "ETF" wording to the neutral "Alt."**

A searched stock can now be the comparison target, so "ETF value"/"ETF XIRR" no longer always fit. Make these exact replacements (the gold colour and all logic stay):

1. Modal title (line 75): `title="Compare holdings vs ETFs"` → `title="Compare holdings vs securities"`.
2. Subtitle (line 76): change `benchmark${selected.length === 1 ? '' : 's'}` → `comparison${selected.length === 1 ? '' : 's'}`.
3. METRICS array (lines 17, 21): `{ key: 'etf', label: 'ETF value' }` → `{ key: 'etf', label: 'Alt. value' }`; `{ key: 'etfXirr', label: 'ETF XIRR' }` → `{ key: 'etfXirr', label: 'Alt. XIRR' }`.
4. Aggregate card label (line 189): `<div className="eyebrow mb-1">ETF value</div>` → `<div className="eyebrow mb-1">Alt. value</div>`.
5. Table headers (lines 206, 210): `<th className="th text-right">ETF value</th>` → `<th className="th text-right">Alt. value</th>`; `<th className="th text-right">ETF XIRR</th>` → `<th className="th text-right">Alt. XIRR</th>`.

Leave the `benchmark`/`benchmarkName`/`counterfactual` data field names and the `/analysis/compare` call untouched — these are only display-string changes.

- [ ] **Step 6: Verify the frontend builds**

Run from the repo root: `npm run build`
Expected: `tsc --noEmit` clean (no unused-import or type errors) and `vite build` succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/modals/CompareModal.tsx
git commit -m "feat(compare): compare holdings against any searched stock/ETF/index, not just the 5 ETFs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Bd8N6prahCfPhUrRh6Xo1X"
```

---

## Owner verification (hand-tested running app)

Open the Compare modal (sidebar). The five ETF chips are still there and still work. Below them a search box accepts any ticker/name/ISIN; picking one adds a gold chip with a `×` and immediately produces a "Basket vs <SYMBOL>" comparison card + chart. Clicking the chip removes it. Comparing against another **stock** works the same way (its column reads "Alt. value"/"Alt. XIRR").

## Self-review notes

- **Spec coverage (§1, §2, §24 VS):** stock-vs-stock / stock-vs-ETF / stock-vs-benchmark all become possible via `SymbolSearch`; multiple comparisons already supported (N×N); existing ETF comparisons preserved (chips + default seed + unchanged API call).
- **No backend change / no duplicated logic:** reuses the counterfactual engine and `/analysis/compare` verbatim.
- **Type consistency:** `SymbolPick` imported from `SymbolSearch.tsx`; `picks` is `Record<string, SymbolPick>`; `addPick` matches `onPick: (p: SymbolPick) => void`.

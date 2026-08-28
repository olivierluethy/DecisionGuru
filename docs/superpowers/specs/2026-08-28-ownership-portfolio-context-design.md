# Ownership-aware verdicts, portfolio fit, sharing & responsive — design

Date: 2026-08-28
Status: approved (design), Slice 1 in implementation

## Context

DecisionGuru already ships most of the large "Discover / Opportunities / portfolio
context" spec: a single shared verdict engine (`services/verdict.py`) consumed by every
view, portfolio-aware Discover (`inPortfolio` on every screener row + a not-owned
"New opportunities" mode), a global universe with the resumable screener warmer that
fixed the old "infinite loading / only one stock" root cause, valuation bands/zones,
cross-listing/exchange recommendation, and per-stock **PDF + XLSX** export.

What is genuinely missing or broken is captured below and split into three sequenced
slices, each its own branch. This document is the shared spec; each slice gets its own
implementation plan when we reach it.

The project's standing constraints still apply: Tailwind only, **dark mode only**,
**modals not page redirects**, Conventional Commits (many small commits), implementation
only (no automated tests — the owner tests the running app), and **never fabricate
financial data** — mark unavailable data as unavailable.

## The core defect (why Slice 1 exists)

`resolve_verdict(va, *, performance, held=False, position, settings)` emits exactly three
canonical keys — `buy-more | hold | sell` — and `held` only gates whether benchmark
*performance* is weighted; it does **not** change the wording. `screener.py` additionally
calls the engine with `held=False` for every row. The `inPortfolio` boolean is already
computed per row and already reaches the frontend, but nothing downstream uses it to
change the recommendation. Result: Discover shows **"Buy more"** for names the user does
not own (e.g. Nvidia). This violates the spec's stated most-important principle.

---

## Slice 1 — Correctness core  (branch `feat/ownership-aware-verdict`)

### 1a. Ownership-aware verdict wording (additive, one engine)

Keep the canonical signal key `buy-more | hold | sell` unchanged so every existing
consumer keeps working and the "one verdict engine" invariant holds. `resolve_verdict`
returns an **additional** field derived from the `held` flag it already receives:

```
action: { key: <signal-key>, label: <string>, owned: <bool> }
```

Label mapping (owned = `held`):

| signal | owned label | not-owned label |
|--------|-------------|-----------------|
| `buy-more`                              | Buy more | Buy   |
| `hold` + trimNote (overvalued, not sell-zone) | Reduce   | Watch |
| `hold` (plain)                          | Hold     | Watch |
| `sell` (sell-zone)                      | Sell     | Avoid |

Behavioral fix: `screener.py` passes `held = inPortfolio` instead of the hard-coded
`held=False`. `recommend.py` / `advisory.py` already pass `held=True`; watchlist candidates
pass `held=inPortfolio`. Frontend `components/Verdict.tsx` renders `action.label` when
present, falling back to the existing `LABELS` map so nothing regresses if a payload lacks
`action`.

Invariant preserved: benchmark underperformance alone still never forces Sell; the signal
key is still chosen by valuation band + fundamentals only. Only the *presentation* is now
ownership-aware.

### 1b. Portfolio Fit panel

New read-only endpoint `GET /api/analysis/fit/{symbol}` reusing `services/exposure.py` and
`services/allocation.py` — no new data source. Returns:

- `owned` (bool) and `directWeight` (portfolio weight of any direct holding, else 0)
- `indirect`: for each **owned ETF** whose provider top-holdings include this symbol,
  `holdingPercent × etfPortfolioWeight`, summed into an effective indirect %. Each
  contributor is listed (`{etfSymbol, viaWeight}`). Flagged
  `coverage: "top-holdings-only"` (may understate) and, when no owned ETF exposes holdings
  data for the name, `indirect: { available: false }` — **never a fabricated percentage**.
- `effectiveExposure` = direct + indirect (only when indirect is available; otherwise
  direct + "indirect unavailable")
- `concentration`: a note when effective exposure is already high
- `diversification`: sector/country of the candidate vs the portfolio rollup (from
  `exposure.py`) — same/different sector, same/different region, with a one-line benefit or
  redundancy note.

Frontend `components/PortfolioFit.tsx` renders this inside `OpportunityModal` and
`PositionDetail`. States: owned vs not-owned framing; unavailable fields explicitly shown
as "unavailable", not hidden silently.

### 1c. External research links

`lib/externalLinks.ts`:
- `yahooUrl(symbol)` → `https://finance.yahoo.com/quote/<symbol>` when a symbol exists.
- `googleUrl(symbol, exchange)` → `https://www.google.com/finance/quote/<TICKER>:<EXCH>`
  when both a ticker and a mappable exchange code exist; otherwise `null`.
- A destination whose URL is `null` is **disabled/hidden**, never a broken link.

A "Learn more about this investment" section with two
`target="_blank" rel="noopener noreferrer"` buttons in `OpportunityModal` and the
`PositionDetail` / `Research` header.

### Slice 1 acceptance
- Non-owned attractive name shows **Buy** (never Buy more); owned attractive shows Buy more.
- Owned overvalued-not-sell shows **Reduce**; not-owned equivalent shows **Watch**.
- Sell-zone shows **Sell** if owned, **Avoid** if not owned.
- Portfolio Fit shows owned Y/N, direct %, indirect % (or "unavailable"), overlap +
  diversification note, with no fabricated numbers.
- Yahoo/Google links open the correct instrument in a new tab; unmappable instruments hide
  the unavailable destination.
- No existing view regresses (verdict key unchanged, `action` additive).

---

## Slice 2 — Share & export  (branch `feat/share-export`)

Reuse `frontend/src/lib/exporters.ts` (`buildPositionExport`) and `backend/app/routers/export.py`.

- **Image export**: a dedicated professional export-card layout rasterized in-browser to
  PNG (reusing the existing in-browser SVG→PNG technique; add a small raster helper if the
  card needs full-DOM capture). Not a raw screenshot.
- **DOCX**: add `python-docx` and `POST /api/export/docx` mirroring the existing PDF payload
  (asset, valuation, thesis/strengths/risks, ownership-aware recommendation, portfolio
  context from Slice 1b).
- **ShareModal**: PDF / DOCX / XLSX / Image buttons + **Web Share API** where supported
  (`navigator.share`, with files when the browser allows) + a **mailto** workflow that
  downloads the file and opens a pre-filled email. The UI never claims an email was *sent*
  — mailto only opens the user's client. Matches the existing dark modal design language.

### Slice 2 acceptance
- Per-stock analysis exports to PDF, DOCX, XLSX and image with correct asset + analysis +
  ownership-aware recommendation + portfolio context.
- Share uses Web Share where available; email falls back to mailto + download, never a fake
  "sent" state.

---

## Slice 3 — Branding + responsive  (branch `feat/branding-responsive`)

- **Icon**: a distinctive DecisionGuru mark in the signature azure/gold palette (echoing
  azure=actual / gold=counterfactual), exported to `frontend/public/` as `favicon.svg`,
  `favicon.ico`, `apple-touch-icon.png`, and PWA sizes + a web manifest, wired into
  `index.html`. Recognizable at 16px, works on light/dark browser chrome.
- **Mobile navigation**: the fixed 240px `Sidebar` becomes a drawer below the `lg`
  breakpoint — a top bar with a ☰ button, an overlay drawer with body-scroll-lock,
  keyboard/focus handling, and auto-close on navigate; unchanged desktop layout at `lg+`.
- **Responsive pass**: charts (no horizontal overflow, touch tooltips), tables (horizontal
  scroll / stacked cards), Discover & Opportunities filters (drawer/modal on mobile), and
  modals usable on small viewports. Dark-only preserved throughout.

### Slice 3 acceptance
- A unique favicon/app icon renders in the browser tab and PWA contexts.
- On a mobile viewport the sidebar is a working burger drawer; charts, tables, filters and
  modals remain usable; no page-level horizontal scroll.

---

## Explicitly out of scope / already done
- Screener "infinite loading" and universe breadth — already fixed (warmer + polling +
  loading/empty/error states).
- Decisions↔Discover consistency and the shared verdict — already enforced by
  `services/verdict.py`.
- Full ETF constituent data — the provider only exposes top-~10 holdings; indirect exposure
  is honestly limited to that slice and marked as such. We do not acquire a new holdings
  dataset in these slices.

## Delivery order
Slice 1 now (this branch) → Slice 2 → Slice 3, each with its own implementation plan and
its own branch. Backend restart is required after Slice 1 to pick up the new `fit` route.

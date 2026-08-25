# DecisionGuru

**Swiss tax-aware investment counterfactual analyzer — "stocks vs. ETF" decision engine.**

For every position and for the whole portfolio, DecisionGuru answers one question:
*how much better or worse off am I holding this individual stock versus having put the
same money, on the same date, into an ETF?* — fully after Swiss tax, dividends and FX
(CHF base, USD/EUR holdings).

It is a **decision-support tool, not advice**: it presents the hard numbers plainly and
lets you draw conclusions. A persistent "Not financial advice" note is shown throughout.

## What it does

- **Counterfactual engine** — mirrors every cash outflow into a stock as a purchase of a
  benchmark ETF on the same date, rolls it forward, and shows the CHF opportunity-cost
  delta (the signature azure-vs-gold chart with the gap shaded green/red).
- **Swiss tax model** — capital gains tax-free; dividends (incl. the income component of
  *accumulating* ETFs) taxed at your marginal rate; withholding-tax reclaim; wealth tax.
  Fully configurable; pre-tax / after-tax toggle everywhere. See `docs/TAX-MODEL.md`.
- **Importer** — **DeGiro is a first-class, auto-detected preset**: drop the `Transactions`
  CSV export and it's fingerprinted, encoding-corrected (UTF-8/Windows-1252), and mapped
  automatically (signed quantity → buy/sell, the two empty currency columns bound, quoted
  product names parsed, corporate actions — ISIN changes / class swaps / delistings —
  labelled and excluded from P/L). Any other XLS/XLSX/CSV/PDF falls back to the generic
  column-mapping modal with preview, dedupe and savable presets.
- **Manual entry** — add a position with just ticker + date + amount (price auto-derived).
- **Break-even, 5-year projections, dividend-shock** scenarios with adjustable sliders.
- **Scenario workbench** — single stock, bundled baskets, or whole-portfolio
  "sell everything → ETF", savable and re-openable.
- **cobe 3D globe** — geographic exposure per instrument with an allocation breakdown.
- **Notes** anywhere; **export** any analysis to Excel and PDF.
- **Local-first** — all your data stays in a local SQLite file. Only market data & FX are
  fetched (and cached aggressively in SQLite).

## Stack

- **Frontend** React + Vite + TypeScript + Tailwind (dark mode only), Recharts, cobe, lucide.
- **Backend** Node + Express + TypeScript, `better-sqlite3`, `yahoo-finance2`,
  frankfurter.app (ECB FX), SheetJS, pdf-parse, exceljs, pdfmake.
- **shared/** TypeScript types shared by both.

## Run it

Requires Node ≥ 20.

```bash
npm install          # installs all workspaces
npm run dev          # starts API (http://localhost:5178) + web (http://localhost:5173)
```

Then open **http://localhost:5173**. The Vite dev server proxies `/api` to the backend.

Individually:

```bash
npm run dev:backend   # API only
npm run dev:frontend  # web only
```

Production build of the web app: `npm run build` (output in `frontend/dist`).

## Data & privacy

- Your transactions, instruments, scenarios, notes and settings live in
  `backend/data/decisionguru.sqlite` (git-ignored). Nothing personal leaves the machine.
- Market prices, dividends, fund holdings and FX rates are fetched from public sources and
  cached in the same SQLite file. When a provider is unavailable or rate-limits, the app
  degrades gracefully and shows a "cached" staleness indicator.

## Documentation

- `docs/STYLEGUIDE.md` — the dark-mode design system (single source of truth for the UI).
- `docs/TAX-MODEL.md` — the Swiss private-investor tax assumptions, with defaults and the
  exact after-tax computation.

> **Not financial advice.** Figures are model estimates; real tax liability depends on your
> canton, bracket and the ESTV *Kursliste*. Treat outputs as directional.

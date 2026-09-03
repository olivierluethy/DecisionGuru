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
- **Market position** — inside *Market analysis* (Research → a stock, Portfolio → a position,
  or any Opportunity modal): every company in the same competitive market ranked on two axes
  at once — how cheap it is *and* how strongly it is growing relative to that market. It names
  the corner a stock sits in (a cheap **leader** vs. a cheap **laggard**) and, when they exist,
  the peers that beat it on both axes — so you don't buy the discount on a company that is
  quietly falling behind its rivals. See `backend/app/services/market_position.py`.
- **Best historical combination** — its own section beside *Market position*: was holding this
  **one** company the best you could have done inside its market? Every mix of up to three of
  its competitors is replayed over 1/3/5 years on a 10 % weight grid with annual rebalancing,
  and the best splits are ranked *with the reason they won* — a partner that was simply better,
  a rebalancing bonus between uncorrelated names, or the same return on a calmer ride. Named
  highlights: the best mix that still holds your stock, the best of all allocations, the best
  return per unit of risk. Price return only, and explicitly a record rather than a forecast.
  See `backend/app/services/market_combos.py`.
- **Reinvestment check** — a *Hold* verdict says a stock is worth owning, not that it is the
  best home for your next franc. Before topping up, the *Top up this position?* section (and
  the **Check before topping up** button on every Hold / Buy-more card in Decisions) ranks the
  holding against its actual competitors on value and growth strength, shows what adding does
  to concentration versus buying a peer, and what the same amount would have returned in each.
  Below that the timing read: past **buy-zone windows** (price at or below the entry target)
  priced against *your* cost basis — what buying then would have been worth, and how much more
  than you made. See `backend/app/services/reinvest.py`.
- **Break-even, 5-year projections, dividend-shock** scenarios with adjustable sliders.
- **Scenario workbench** — single stock, bundled baskets, or whole-portfolio
  "sell everything → ETF", savable and re-openable.
- **cobe 3D globe** — geographic exposure per instrument with an allocation breakdown.
- **Notes** anywhere; **export** any analysis to Excel and PDF.
- **Local-first** — all your data stays in a local SQLite file. Only market data & FX are
  fetched (and cached aggressively in SQLite).
- **Installable (PWA)** — an *Install app* button appears at the bottom of the sidebar once
  the browser offers the prompt, and opens DecisionGuru in its own window. The service worker
  caches only the app shell and hashed assets; **`/api` is never cached**, so the numbers you
  see always come from your local backend. Works from `npm run dev` on `localhost` and from
  any https host; Safari installs via *Share → Add to Dock/Home Screen* instead.

## Stack

- **Frontend** React + Vite + TypeScript + Tailwind (dark mode only), Recharts, cobe, lucide.
- **Backend** Python 3.12 + **FastAPI** (uv-managed), served by uvicorn (dev) / gunicorn +
  uvicorn workers (prod). Market data via **yfinance** behind a `MarketDataProvider`
  interface; analytics on **pandas/numpy/scipy** for interactive endpoints and **PySpark**
  for the bulk/heavy path; `sqlite3`, frankfurter.app (ECB FX), openpyxl + reportlab exports.
- **shared/** TypeScript types shared by the frontend (the API contract lives in
  `docs/API_CONTRACT.md`).

## Run it

You need two things on your `PATH` before the first run: **[uv](https://docs.astral.sh/uv/)**
(it manages the backend *and* fetches Python 3.12 for you — your system Python version does
not matter) and **Node ≥ 20**. See `docs/RUNNING.md` for the full guide.

### macOS (Apple Silicon & Intel)

macOS ships **no** `uv` and no usable Java, so install the prerequisites first —
`npm run dev` fails with `sh: uv: command not found` otherwise:

```bash
# 1. Homebrew, if you don't have it yet — https://brew.sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Prerequisites
brew install uv node          # uv = backend toolchain, node ≥ 20 = frontend

# 3. Verify — both must print a version
uv --version && node --version
```

<details>
<summary>No Homebrew? Install <code>uv</code> with the official script instead</summary>

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

This installs to `~/.local/bin`, which is **not** on your `PATH` by default. Open a new
terminal, or add it permanently:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```
</details>

Then run the project (from the repo root):

```bash
cd backend && uv sync && cd ..   # install backend deps (creates backend/.venv, ~1 min)
npm install                      # install frontend workspaces
npm run dev                      # API (uvicorn :5178) + web (vite :5173)
```

> **Java is optional.** PySpark powers the bulk analytics path, but macOS's stock `java` is
> only a stub — the backend logs `Spark unavailable (…); using pandas reducer` once and
> works normally on the pandas fallback. For the Spark path: `brew install --cask temurin@21`.
> To silence the warning entirely, set `DG_SPARK_ENABLED=false` in `backend/.env`.

### Linux

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # then restart your shell
cd backend && uv sync && cd ..
npm install
npm run dev
```

### Windows (PowerShell)

```powershell
winget install --id=astral-sh.uv -e ; winget install --id=OpenJS.NodeJS.LTS -e
cd backend ; uv sync ; cd ..
npm install
npm run dev
```

---

Then open **http://localhost:5173**. The Vite dev server proxies `/api` to the backend on
port 5178.

Individually:

```bash
npm run dev:backend   # FastAPI (uvicorn --reload) only
npm run dev:frontend  # web only
```

Interactive API docs are at **http://localhost:5178/docs**. Production build of the web app:
`npm run build` (output in `frontend/dist`).

### If something goes wrong

| Symptom | Fix |
| --- | --- |
| `sh: uv: command not found` | `uv` isn't installed or isn't on `PATH` — see the install steps above, then open a **new** terminal. |
| `http proxy error: /api/… AggregateError [ECONNREFUSED]` | The web app is up but the API isn't. Scroll up for the `[api]` lines — the real error is there (usually the missing `uv`). |
| `Port 5173 is in use, trying another one…` | A previous `npm run dev` is still running. `npm run dev` prints the port it actually took; or free them: `lsof -ti:5173,5178 \| xargs kill`. |
| `Unable to locate a Java Runtime` / `Spark unavailable` | Harmless — the pandas fallback handles it. See the Java note above. |
| Backend deps look stale after a `git pull` | `cd backend && uv sync` again — it's fast and idempotent. |

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

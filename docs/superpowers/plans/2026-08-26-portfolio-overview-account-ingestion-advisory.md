# Portfolio Overview, Account Ingestion & Advisory Rebalancing — Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **NO automated tests** — the owner's standing constraint is *implementation only; the owner tests the running app*. Each task therefore ends with a **manual verification** note (what to click / what to see) instead of a test cycle. Commit in many small Conventional-Commit steps.

**Goal:** Turn DecisionGuru from an ETF-comparison-first tool into a portfolio-overview-first tool that ingests the full DEGIRO **Account statement** (cash, dividends-by-ISIN, taxes, fees) alongside the **Transactions** export, with time-range charts, a flexible N-vs-N comparison module, and an advisory "harmonize" module.

**Architecture:** Keep the clean separation the codebase already has. The **Transactions** export continues to drive *positions* (via `transactions` table + `finance.build_position`). A **new `account_events` table + `account.py` service** ingests the Account statement and derives per-currency cash, dividends-by-ISIN, deposits and fees — merged into positions/portfolio **on ISIN**. Frontend stays view-state routed (zustand `view`), reframed so the overview is the landing surface and comparison/advisory are secondary modals/views. Charts gain a shared time-range selector component.

**Tech Stack:** Backend Python 3.12 / FastAPI / SQLite (stdlib) / pandas; Frontend Vite + React + Zustand + react-query + Recharts + Tailwind (dark only). Shared TS types in `shared/src/types.ts`.

## Global Constraints

- Tailwind CSS only. No other CSS frameworks. Dark mode only.
- All create/edit/import/compare/advisory detail flows are **modals, never route changes**.
- Base currency **CHF**; convert USD/EUR/GBP → CHF for headline figures; keep original currency on hover/detail. FX via existing `services/fx.py` (`to_chf`, `get_fx_rate`).
- Money format: Swiss `1'234.50`, currency prefixed (`CHF 1'234`) — use existing `lib/format.ts` helpers.
- Conventional Commits, many small commits. **No tests / no Playwright / no verification agents.**
- Follow `docs/STYLEGUIDE.md` exactly: azure = you/actual, gold-dashed = ETF counterfactual, green/red reserved for gain/loss, hairline grid, mono tabular numerals, existing `.card/.th/.td/.input/.btn-*/.chip/.eyebrow/.label` utility classes.
- Run backend `gunicorn -w 1` / uvicorn single-process — importer keeps parsed uploads in an in-process store.
- **Do not probe Yahoo repeatedly** to "verify" — it rate-limits the IP; the app degrades to cached/stale by design.

---

## Task 1: `account_events` table + schema migration

**Files:**
- Modify: `backend/app/core/db.py` (add table to `SCHEMA`, add idempotent migration calls in `init_db`)

**Interfaces:**
- Produces: table `account_events` with columns
  `id, date TEXT, time TEXT, valueDate TEXT, name TEXT, isin TEXT, description TEXT, type TEXT, fx REAL, currency TEXT, amount REAL, balanceCurrency TEXT, balance REAL, orderId TEXT, instrumentId INTEGER (nullable), reversed INTEGER DEFAULT 0, source TEXT, dedupeKey TEXT, createdAt TEXT DEFAULT (datetime('now'))`
- Produces: `CREATE UNIQUE INDEX idx_account_dedupe ON account_events(dedupeKey) WHERE dedupeKey IS NOT NULL` and `CREATE INDEX idx_account_isin ON account_events(isin)`.

- [ ] **Step 1:** Add the `account_events` `CREATE TABLE IF NOT EXISTS` + two indexes to the `SCHEMA` string in `db.py` (mirror existing style; `instrumentId` has no FK constraint so account import never fails when positions aren't imported yet).
- [ ] **Step 2:** `executescript(SCHEMA)` in `init_db` already creates it for fresh DBs; for existing DBs the `IF NOT EXISTS` covers it — no `_ensure_column` needed since it's a whole new table.
- [ ] **Step 3:** Manual verify: `cd backend && uv run python -c "from app.core import db; db.init_db(); print(db.q('SELECT name FROM sqlite_master WHERE type=\"table\"').all())"` shows `account_events`.
- [ ] **Step 4:** Commit: `feat(backend): account_events table for DEGIRO account-statement ingestion`

---

## Task 2: Account-statement parser (positional, tolerant)

**Files:**
- Modify: `backend/app/services/importer.py` (add detector + parser; reuse `parse_csv_rows`, `parse_num`, `parse_date`, `_finalize_parsed`, `_store`)

**Interfaces:**
- Consumes: `_store[fileId]` shape from `_finalize_parsed` (has `sheets[].rawHeaders`, `sheets[].rows`).
- Produces:
  - `ACCOUNT_SIGNATURE: list[str]` and `detect_account(raw_headers) -> bool`
  - `transform_account(file_id, sheet_name=None) -> list[dict]` returning normalized event dicts:
    `{ "ok": bool, "errors": list[str], "type": str, "label": str, "event": {date,time,valueDate,name,isin,description,type,fx,currency,amount,balanceCurrency,balance,orderId,reversed,dedupeKey} }`
  - Normalized `type` ∈ `deposit | cash_sweep | fx_conversion | dividend | withholding_tax | corp_action_fee | connectivity_fee | unknown`.

**Key parsing rules (correctness-critical — implement exactly):**
- **Column positions are fixed** (header row present, comma-delimited): index 0 `Datum` (DD-MM-YYYY), 1 `Uhrze` (HH:MM), 2 `Valutadatum`, 3 `Produkt`, 4 `ISIN`, 5 `Beschreibung`, 6 `FX`, 7 `Änderung`=mutation currency, **8 = mutation amount (blank header)**, 9 `Saldo`=balance currency, **10 = balance amount (blank header)**, 11 `Order-ID`. Parse columns 8 and 10 **by position, never by header name** (they're blank). Do not assume `parse_csv_rows` trims trailing empty cells — pad short rows.
- **Date:** `parse_date(cell, ["%d-%m-%Y"])`. Amounts: `parse_num` (handles `.` decimal and sign; note account numeric columns use plain `.`).
- **Type mapping** on `Beschreibung` (case-insensitive `startswith`/`contains`):
  - `Einzahlung` → `deposit`
  - contains `flatexDEGIRO` OR `Cash Sweep` → `cash_sweep`
  - `Währungswechsel` → `fx_conversion` (keep the `FX` column value as `fx`)
  - exactly `Dividende` → `dividend`
  - `Dividendensteuer` → `withholding_tax`
  - `Gebühr für Kapitalmaßnahme` → `corp_action_fee`
  - `Einrichtung von Handelsmodalitäten` → `connectivity_fee`
  - else → `unknown` (never drop — surfaces in UI).
- **Reversal netting:** group by `(isin_or_name, normalized_description_base, round(abs(amount),2), currency)`; within a group, if there exist two rows with **opposite signs** and timestamps within **10 minutes**, mark **both** `reversed=1`. (Handles the SANOFI +247.20 / −247.20 storno pair and its tax/fee reversals.) Use `_base_name` for the name key.
- **`detect_account`:** true when normalized headers contain `datum`, `valutadatum`, `produkt`, `isin`, `beschreibung`, `saldo`, `orderid` AND the header has the blank-column signature (a blank header cell immediately after the `Änderung`-currency column). Distinguish from the Transactions export (which has `anzahl`, `kurs`, `wertinlokalwahrung`).
- **dedupeKey:** `account:{date}:{time}:{isin}:{description}:{amount}:{balance}` (include balance so legitimate same-day same-amount events don't collide, and re-imports dedupe).

- [ ] **Step 1:** Add `ACCOUNT_SIGNATURE`, `detect_account`, `ACCOUNT_BROKER_NAME = "DeGiro — Account statement (Kontoauszug)"`, and an `ACCOUNT_MAPPING_DISPLAY` list (columns → meaning, mirroring `DEGIRO_MAPPING_DISPLAY`).
- [ ] **Step 2:** In `parse_csv`, after computing `detect_broker`, also compute `detect_account`; pass a `detectedKind` ('transactions' | 'account' | None) into `_finalize_parsed` so the UI/preview knows which transform to run. Extend `_finalize_parsed` to carry `detectedKind`, `accountBrokerName`, `accountMapping` without breaking existing `detectedBroker` fields.
- [ ] **Step 3:** Implement `transform_account(file_id, sheet_name)` per the rules above (positional cell reader like `transform_degiro`'s `cell`, padding short rows).
- [ ] **Step 4:** Manual verify with the spec's representative rows saved as `/tmp/acct.csv`: `uv run python -c "from app.services import importer as I; p=I.parse_csv('/tmp/acct.csv','Account.csv'); print(p['detectedKind']); import json; print(json.dumps(I.transform_account(p['fileId']), indent=2, ensure_ascii=False))"` — dividends attributed to ISIN, taxes negative, FX rows typed, deposit typed, no unknowns for the samples.
- [ ] **Step 5:** Commit: `feat(backend): DEGIRO account-statement detector + positional parser`

---

## Task 3: Account repo + aggregation service

**Files:**
- Modify: `backend/app/services/repo.py` (insert/query account_events, resolve instrumentId by ISIN)
- Create: `backend/app/services/account.py` (aggregations)

**Interfaces:**
- Consumes: `repo.resolve_instrument`, `services/fx.to_chf`.
- Produces in `repo.py`:
  - `insert_account_event(ev: dict) -> dict` (INSERT OR IGNORE on dedupeKey; resolves `instrumentId` by ISIN via existing `instruments` row lookup only — **no Yahoo call**, to avoid rate-limit; leaves null if unknown ISIN)
  - `all_account_events() -> list[dict]`
  - `account_events_count() -> int`
  - `link_account_events_to_instruments() -> int` (backfill instrumentId by ISIN after a later Transactions import; returns count updated)
- Produces in `account.py`:
  - `cash_by_currency(events) -> dict[str, float]` = sum of non-reversed `amount` grouped by `currency` (the live DEGIRO cash position per currency).
  - `cash_chf(events, as_of) -> {"totalCHF": float, "byCurrency": {ccy: {amount, chf}}}` via `to_chf`.
  - `dividends_by_isin(events, as_of) -> dict[isin, {grossOrig, taxOrig, currency, grossCHF, taxCHF, netCHF, count}]` (dividend gross positive, withholding_tax negative → netCHF = grossCHF + taxCHF).
  - `deposits_total_chf(events, as_of) -> float`, `fees_total_chf(events, as_of) -> float` (corp_action_fee + connectivity_fee + fx spread if any).
  - `events_summary(events) -> {counts by type, unknown: list[event]}` for surfacing the unknown bucket.
  - All ignore rows where `reversed == 1`.

- [ ] **Step 1:** Add the `account_events` repo functions (mirror `insert_transaction` dedupe style).
- [ ] **Step 2:** Add `account.py` with the pure aggregation functions (take the event list as input so they're trivially reusable/testable-by-hand).
- [ ] **Step 3:** Manual verify: after committing a sample account file (Task 4), call the aggregation from a REPL and eyeball CHF totals.
- [ ] **Step 4:** Commit: `feat(backend): account_events repo + cash/dividend aggregation service`

---

## Task 4: Import router — account commit path + graceful degradation

**Files:**
- Modify: `backend/app/routers/imports.py` (route account previews/commits through the account transform; add account commit)

**Interfaces:**
- Consumes: `importer.transform_account`, `importer.detect_account`, `repo.insert_account_event`, `repo.link_account_events_to_instruments`.
- Produces: `/imports/preview` and `/imports/commit` handle `mapping["kind"] == "account"` (or auto from `detectedKind`) → account rows; commit inserts into `account_events` and returns `{importedEvents, skipped, dividends, deposits, fees, unknown}`.

- [ ] **Step 1:** In `_build_preview_rows`, branch: if `mapping.get("kind") == "account"` (or parsed `detectedKind == "account"`), return `transform_account(...)`; else keep existing behavior.
- [ ] **Step 2:** In `/preview`, when account kind, return account-shaped summary (`events`, `okCount`, `total`, per-type counts, `unknownCount`) instead of trades/corporateActions.
- [ ] **Step 3:** In `/commit`, when account kind, insert via `repo.insert_account_event`, then call `link_account_events_to_instruments()`; return the account result shape. Keep the transactions path unchanged.
- [ ] **Step 4:** After **any** transactions commit, also call `link_account_events_to_instruments()` so previously-imported account dividends attach to newly-created instruments (merge-on-ISIN, either import order).
- [ ] **Step 5:** Manual verify via the running app once the modal (Task 9) is wired; for now `curl` upload→preview→commit the sample account CSV and confirm `account_events` populated and dividends carry `instrumentId` when the ISIN already exists.
- [ ] **Step 6:** Commit: `feat(backend): account-statement preview/commit + merge-on-ISIN linking`

---

## Task 5: Portfolio endpoint — cash pool, dividends-by-ISIN, total gain

**Files:**
- Modify: `backend/app/routers/analysis.py` (`/portfolio` and `/position/{id}`)
- Modify: `backend/app/services/finance.py` (accept injected net dividends, or add merge in router — prefer router merge to keep `build_position` pure)
- Modify: `frontend/src/lib/api.ts` (`PortfolioResponse` gains `cash`, `hasPositions`, `hasAccount`; per-position `netDividendsCHF`)

**Interfaces:**
- Consumes: `account.cash_chf`, `account.dividends_by_isin`, `account.deposits_total_chf`, `account.fees_total_chf`, `account.events_summary`.
- Produces: `/portfolio` response adds
  - `cash: { totalCHF, byCurrency: {CHF,USD,EUR,...} }`
  - `totals` gains `netDividendsCHF` sourced from account (falls back to position dividends if no account import), `totalGainCHF` = `realizedCHF + unrealizedCHF + netDividendsCHF`, and `depositsCHF`, `feesCHF`.
  - each position gains `netDividendsCHF` (looked up by `instrument.isin`).
  - flags `hasPositions` (any tx), `hasAccount` (any account_events), plus `unknownEvents` count.

- [ ] **Step 1:** In `/portfolio` `_work`, load `events = repo.all_account_events()`, compute `divByIsin = account.dividends_by_isin(events, today)`; for each position set `netDividendsCHF = divByIsin.get(isin,{}).get('netCHF', position_dividends_net)`.
- [ ] **Step 2:** Compute `cash`, `depositsCHF`, `feesCHF`, `unknownEvents`; add to response. `totals.netDividendsCHF = sum(position netDividendsCHF)`; `totals.totalGainCHF = realized + unrealized + netDividends`.
- [ ] **Step 3:** Mirror the dividend merge in `/position/{id}` so the detail view shows account-sourced net dividends for that ISIN.
- [ ] **Step 4:** Update `PortfolioResponse` type in `api.ts` to match.
- [ ] **Step 5:** Manual verify: `curl 'localhost:5178/api/analysis/portfolio'` shows `cash.byCurrency`, per-position `netDividendsCHF`, `totals.totalGainCHF`.
- [ ] **Step 6:** Commit: `feat(backend): portfolio endpoint exposes cash pool, ISIN dividends, total gain`

---

## Task 6: Range-series backend for time-range charts

**Files:**
- Create: `backend/app/services/history.py` (portfolio & per-instrument value series over a range) OR extend existing series in `counterfactual`/`projection`.
- Modify: `backend/app/routers/analysis.py` (add `/portfolio/series?range=1Y` and `/series/{instrument_id}?range=1Y`)

**Interfaces:**
- Produces: `GET /analysis/series/{instrument_id}?range=1D|30D|1M|2M|5M|6M|1Y|2Y|5Y|MAX` → `{ range, points: [{date, value}], stats: {high, low, start, end, changeAbs, changePct} }` (value = holding market value in CHF using cached `price_cache`).
- Produces: `GET /analysis/portfolio/series?range=…` → combined equity curve (sum of held positions' daily value in CHF) with the same `stats`.
- Uses **cached** `price_cache`/history only — no live Yahoo probing.

- [ ] **Step 1:** Add a `RANGE_DAYS` map and a helper to slice a daily series to the range and compute stats.
- [ ] **Step 2:** Implement per-instrument series from `price_cache` × open quantity over time (reuse the lot-tracking from `build_position` to know quantity held on each date) × FX.
- [ ] **Step 3:** Implement portfolio series = element-wise sum across held instruments on the shared date axis.
- [ ] **Step 4:** Add both routes; add `api.series(...)` / `api.portfolioSeries(...)` in `api.ts`.
- [ ] **Step 5:** Manual verify: `curl 'localhost:5178/api/analysis/portfolio/series?range=1Y'` returns points + stats.
- [ ] **Step 6:** Commit: `feat(backend): cached range-series endpoints for portfolio + instrument`

---

## Task 7: Shared `TimeRangeSelector` + range stats strip (frontend)

**Files:**
- Create: `frontend/src/components/TimeRangeSelector.tsx`
- Create: `frontend/src/components/RangeStats.tsx`
- Modify: `frontend/src/store.ts` (optional: remember last range)

**Interfaces:**
- Produces: `<TimeRangeSelector value={range} onChange={setRange} />` with presets `1D · 30D · 1M · 2M · 5M · 6M · 1Y · 2Y · 5Y · MAX` (styled like existing `Segmented`).
- Produces: `<RangeStats stats={{high,low,start,end,changeAbs,changePct}} />` — compact mono row, gain/loss coloured `changePct`.
- `type RangeKey = '1D'|'30D'|'1M'|'2M'|'5M'|'6M'|'1Y'|'2Y'|'5Y'|'MAX'`.

- [ ] **Step 1:** Build `TimeRangeSelector` (horizontal scrollable pill row on mobile; default `1Y`).
- [ ] **Step 2:** Build `RangeStats` using `fmtCHF`/`fmtPctSigned`/`plClass`.
- [ ] **Step 3:** Manual verify visually once used in Task 8.
- [ ] **Step 4:** Commit: `feat(frontend): shared time-range selector + range stats strip`

---

## Task 8: Overview-first Dashboard (Gesamtübersicht)

**Files:**
- Modify: `frontend/src/views/Dashboard.tsx` (reframe as overview; cash vs invested band; holdings table with dividends + weight; portfolio equity curve with range selector)
- Modify: `frontend/src/components/Sidebar.tsx` (label the landing "Overview"; comparison/advisory as secondary entries)
- Create (optional): `frontend/src/components/PortfolioChart.tsx` (equity curve using `/portfolio/series`)

**Interfaces:**
- Consumes: `api.portfolio` (now with `cash`, `totals.totalGainCHF`, per-position `netDividendsCHF`), `api.portfolioSeries(range)`.

**UI (per spec Part 2):**
- Top band, two colour-separated pools: **Kontoguthaben (cash)** total CHF + per-currency on hover/detail modal; **Finanzrat Portfolio (invested)** current market value CHF. Plus **Today's P/L** (abs+%) and **Total gain (Gesamtgewinn)** (abs+%, = realized+unrealized+net dividends).
- Holdings table per row: name, ISIN, qty, current value CHF, cost basis, unrealized P/L, **net dividends**, **weight %**. Keep the existing compare-checkbox column and row→PositionDetail click.
- Portfolio equity curve with `TimeRangeSelector` (default `1Y`) + `RangeStats`.
- The counterfactual "opportunity cost" hero moves into the **Comparison** surface (Part 4), not the landing hero. Keep azure/gold styleguide motif on the equity curve.

- [ ] **Step 1:** Add the cash-vs-invested summary band (distinct colours; cash pool uses a neutral/azure-tinted card, invested uses the existing surface; **do not** use gain/red decoratively).
- [ ] **Step 2:** Add Today's P/L (derive from series: last two points) + Total gain stat from `totals.totalGainCHF`.
- [ ] **Step 3:** Extend the holdings table with ISIN, qty, cost basis, net dividends, weight% columns; keep sticky `th` (already `sticky` via styleguide) and compare checkboxes.
- [ ] **Step 4:** Replace the counterfactual `DeltaChart` hero with `PortfolioChart` (equity curve) + range selector; add a per-currency cash detail modal (`{ kind: 'cash-detail' }`).
- [ ] **Step 5:** Empty/degraded states: if `hasPositions` false but `hasAccount` true → show cash + dividend history and a banner "Import your Transactions export to see holdings & valuation." If neither → existing empty state, updated copy.
- [ ] **Step 6:** Manual verify in the running app.
- [ ] **Step 7:** Commit in 2–3 small commits: `feat(frontend): overview cash vs invested band`, `feat(frontend): holdings table with dividends + weight`, `feat(frontend): portfolio equity curve with time range`.

---

## Task 9: Import modal — dual upload (Account + Transactions)

**Files:**
- Modify: `frontend/src/modals/ImportModal.tsx` (two clearly-labelled drop zones / a kind toggle; account preview + result screens)
- Modify copy per spec Part 1.1.

**Interfaces:**
- Consumes: `api.uploadFile` (returns `detectedKind`), `api.previewImport`, `api.commitImport` (account-aware).

- [ ] **Step 1:** Update the upload step: two labelled targets — **Account statement (Kontoauszug)** and **Transactions** — with helper copy (DEGIRO → Reports → Account statement → export CSV). Auto-route by `detectedKind`; if a file matches the other schema, show a gentle "this looks like the {other} export" hint.
- [ ] **Step 2:** Add an `AccountPanel` (preview table: date, type badge, security/ISIN, amount+currency, running balance; surface unknown-type rows in `--warn`).
- [ ] **Step 3:** Account result screen: imported events, dividends attributed, deposits, fees, unknowns.
- [ ] **Step 4:** Validate schema before accepting (reject a Transactions file dropped as Account and vice-versa, with a fixable error message).
- [ ] **Step 5:** Manual verify: import Account then Transactions (and reverse order); dividends attach either way.
- [ ] **Step 6:** Commit: `feat(frontend): dual-upload import — account statement + transactions`

---

## Task 10: Comparison module (secondary, flexible N-vs-N)

**Files:**
- Modify: `frontend/src/modals/CompareModal.tsx` (flexible multi-select of stocks+ETFs; sticky table headers; time-range selector; toggleable metrics)
- Modify: `frontend/src/store.ts` (`{ kind: 'compare' }` already exists; ensure basket-vs-multi-ETF scenarios supported)
- Backend `/analysis/compare` already supports `instrumentIds` + `benchmarks[]`.

**Interfaces:** Consumes existing `api.compare`; add `TimeRangeSelector`.

- [ ] **Step 1:** Ensure the compare entry is reachable from the overview (selection bar already exists) and from a Sidebar "Comparison" secondary item; not the landing.
- [ ] **Step 2:** Make selection flexible N-vs-N (already list-based); add ETF multi-select for benchmarks.
- [ ] **Step 3:** Comparison tables: sticky headers on scroll (`thead sticky top-0` + scroll container); toggleable metric columns (return over range, volatility, dividend yield, weight).
- [ ] **Step 4:** Wire `TimeRangeSelector` to the comparison chart.
- [ ] **Step 5:** Manual verify.
- [ ] **Step 6:** Commit: `feat(frontend): flexible N-vs-N comparison with sticky headers + range`

---

## Task 11: Advisory / "harmonize" (Finanzrat rebalancing insights)

**Files:**
- Create: `backend/app/services/advisory.py` (flag underperformers, pick best alternative ETF, compute reallocation delta)
- Modify: `backend/app/routers/analysis.py` (add `GET /analysis/advisory`)
- Create: `frontend/src/views/Advisory.tsx` (insight cards) + Sidebar entry
- Modify: `frontend/src/store.ts` (add `'advisory'` to `View`; dismissed/handled insight ids persisted via a small `settings`-backed store or localStorage)

**Interfaces:**
- Produces: `GET /analysis/advisory?benchmark=…` → `[{ instrumentId, name, isin, investedCHF, sinceDate, holdingReturnPct, referenceEtf, referenceReturnPct, deltaCHF, rationale }]`. Underperformer = long-horizon return materially below the reference ETF over the same period (reuse `compute_counterfactual`/`benchmark_cagr`, cached data only).
- Produces: dismiss/handled endpoint or client-side persistence: `POST /analysis/advisory/{instrumentId}/handled` writing into `settings` (`advisoryHandled: number[]`), so handled insights don't reappear.

- [ ] **Step 1:** `advisory.py`: for each position with ≥ some horizon, compute holding return vs the single best reference ETF (from `settings["benchmarks"]`), reallocation delta CHF, plain-language rationale (Part 5 wording).
- [ ] **Step 2:** Add `/analysis/advisory` route + `api.advisory()`.
- [ ] **Step 3:** `Advisory.tsx`: dismissible/handled insight cards, each with a long-horizon holding-vs-ETF chart (reuse `DeltaChart` + `TimeRangeSelector`) and the recommended single best alternative + reasoning. "Not financial advice" label.
- [ ] **Step 4:** Persist handled ids; hide handled cards.
- [ ] **Step 5:** Manual verify.
- [ ] **Step 6:** Commit in 2 commits: `feat(backend): advisory underperformer detection + best-alternative`, `feat(frontend): advisory insight cards (harmonize)`.

---

## Task 12: Shared types + copy + disclaimer polish

**Files:**
- Modify: `shared/src/types.ts` (add `AccountEvent`, `CashByCurrency`, `AdvisoryInsight`, `RangeKey`, `RangeSeries`; extend `PortfolioResponse`).
- Modify: `docs/API_CONTRACT.md` (document new endpoints).
- Modify: Sidebar footer keeps the persistent "Not financial advice" disclaimer.

- [ ] **Step 1:** Add/extend shared types so frontend imports are typed (no `any`).
- [ ] **Step 2:** Document new endpoints in `API_CONTRACT.md`.
- [ ] **Step 3:** Commit: `chore: shared types + API contract for account/overview/advisory`.

---

## Self-review notes

- **Spec coverage:** Part 1 → Tasks 1–5, 9. Part 2 → Task 8. Part 3 → Tasks 6–7 (+ used in 8/10/11). Part 4 → Task 10. Part 5 → Task 11. Acceptance-checklist items each map to a task above.
- **Merge-on-ISIN both orders:** Task 4 Step 4 + Task 3 `link_account_events_to_instruments` guarantee dividends attach regardless of upload order.
- **Graceful degradation:** Task 5 flags + Task 8 Step 5.
- **No double-counting dividends:** account is the dividend source of truth; Transactions export carries none; `build_position` div_summary stays ~0, account merge supplies net dividends (Task 5).
- **Rate-limit safety:** Tasks 3/6 use cached data only; ISIN→instrument linking is a DB lookup, never a Yahoo search.
- **Sequencing:** 1→2→3→4→5 (backend ingestion critical path) can ship and be tested before frontend Tasks 8–9; Tasks 6–7 precede 8/10/11.

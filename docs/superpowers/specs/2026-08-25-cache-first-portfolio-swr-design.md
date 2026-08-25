# Cache-first portfolio with stale-while-revalidate

**Date:** 2026-08-25
**Status:** Approved (design)
**Area:** `backend/app/services`, `backend/app/providers`, `backend/app/routers/analysis.py`, `frontend`

## Problem

`GET /analysis/portfolio` blocks the dashboard behind live Yahoo fetches. It loops
sequentially over every instrument (~39 holdings); each iteration calls `get_quote`
(15-minute TTL) and `compute_counterfactual` (which calls `ensure_history` + benchmark
history + dividends). Every upstream call is serialized behind a single global lock with a
forced 700 ms gap (`yfinance_provider._call`), so a cold-quote load has a ~27 s floor before
network latency — and under Yahoo rate-limiting (20 s timeout × 4 retries per symbol,
serialized) it balloons to minutes. The user sees the spinner
"Computing after-tax counterfactuals…" for 30–70 s.

The quote cache expires every 15 minutes, so this re-triggers on essentially every visit.

## Goal

The dashboard opens essentially immediately — even on a cold cache or right after a data
reset — and prices refresh in the background. Yahoo latency is removed from the critical UI
path, and the app becomes more resilient to rate-limiting (no synchronous burst of requests
per page load).

## Core principle

**The portfolio endpoint never makes a blocking upstream call** — not for quotes, not for
history. It computes from whatever is in the SQLite cache tables at request time and enqueues
background refreshes for anything stale or missing.

Making `ensure_history` non-blocking (not just quotes) is required: otherwise a cold first
load still blocks on ~39 chart fetches. This is explicitly in scope. It is *not* the separate
scheduled-ingestion subsystem (nightly cron / `/update-market-data`) that was considered and
rejected — it is only making the existing inline fetches non-blocking.

## Out of scope (deliberately)

- Redis (this is a local-first app; SQLite already is the cache; the Redis config is unused).
- Nightly / scheduled ingestion worker (fights the on-demand `uvicorn` deployment model).
- Batch quote requests (the cheap quote path uses per-ticker `fast_info` + `history_metadata`
  to avoid the 20 s `.get_info()` hang; `fast_info` has no batch form).
- Precalculated / cached counterfactual results (the bottleneck is network, not CPU; the
  pandas/Spark math over ~39 holdings is not what makes it spin).

## Design

### 1. `get_quote` → stale-while-revalidate (`services/marketdata.py`)

Three cases, none of which block:

- **Fresh cache** (`now - fetchedAt < cache_ttl_quote`): return as today.
- **Stale cache** (row exists, past TTL): return the cached row immediately marked
  `stale: true`; enqueue a background refresh for the symbol.
- **No cache row at all**: return a `pending` sentinel (price `None`/0, `stale: true`);
  enqueue a background refresh.

The inline `provider.quote(...)` call is removed from the request path entirely.

### 2. `ensure_history` / `get_dividends` → non-blocking (`services/marketdata.py`)

Serve whatever price/dividend rows are already cached. If coverage is missing or stale (same
`needs_backfill` / `is_stale` logic as today), enqueue a background backfill instead of
fetching inline. The existing per-symbol cooldown (`HISTORY_COOLDOWN_MS`) still guards against
re-enqueuing the same backfill repeatedly. On a truly cold DB the counterfactual/chart is
computed from empty history (renders a pending/empty state) and fills in on a later poll.

### 3. Bounded background refresh pool (new `services/refresh.py`)

- A module-level `ThreadPoolExecutor` — start at **4 workers**.
- An in-flight `set[str]` (guarded by a lock) keyed by a refresh job id (e.g. `quote:SYM`,
  `history:SYM`) so the same job is never enqueued twice concurrently. Cleared in a `finally`.
- `enqueue_quote(symbol)` / `enqueue_history(symbol, from_date)` submit work that calls
  `provider.quote` / `provider.chart` and writes the cache (reusing the existing
  `_fetch_chart` / quote-write code paths).
- `refresh_in_progress() -> bool` reports whether any job is in flight.
- Single-worker gunicorn (`-w 1`, existing constraint) makes the in-process pool and in-flight
  set correct. The `db` module is already thread-safe (single shared connection,
  `check_same_thread=False`, all access under an `RLock`) so background writes are safe.

### 4. Relax provider serialization (`providers/yfinance_provider.py`)

Convert the global `_gate` from `threading.Lock` to `threading.Semaphore(N)` (N = 4, matching
the pool) so refreshes run bounded-concurrent instead of strictly serial. Keep the 20 s
soft timeout and the 429 retry-with-backoff. Concurrency becomes the throttle; the fixed
700 ms `yf_min_gap_ms` serial gap is dropped or greatly reduced. Concurrency stays modest to
respect the documented rate-limit gotcha (back off on 429 as today).

### 5. Response envelope + `pricing` state

`PortfolioResponse` (frontend `lib/api.ts`) and the endpoint (`routers/analysis.py`) gain:

- `quotesUpdatedAt: string | null` — the oldest quote timestamp among open (held) positions:
  the "prices as of" the UI shows. `null` when nothing is priced yet.
- `refreshInProgress: boolean` — `refresh.refresh_in_progress()` at response time.

`InstrumentDataStatus.state` (shared `types.ts`) gains a new value **`'pricing'`** — "no quote
yet, fetch in flight." Emitted by `services/datastatus.py` / `finance.py` when a held position
has no cached price and a refresh is queued.

### 6. Frontend (`views/Dashboard.tsx`, `store`, `components/ui.tsx`, `lib/api.ts`)

- Remove the full-screen `Spinner` gate on `isLoading`. The endpoint now returns in <100 ms,
  so `isLoading` resolves effectively instantly; keep a minimal spinner only for the genuine
  first in-flight HTTP request.
- react-query polls (`refetchInterval` ≈ 2.5 s) **while** `refreshInProgress` is true or any
  position is `pricing`; polling stops once refresh is done and no position is pending.
- Header indicator: **"Prices updated 18 min ago · Refreshing…"** derived from
  `quotesUpdatedAt` + `refreshInProgress` (drop the "Refreshing…" clause when idle).
- `pricing` positions render a pulsing badge (new `STATUS_META.pricing` entry) and a pending
  "—" in the value/P-L columns instead of a number; they fill in on the next poll.

### 7. TTL bump (`core/config.py`)

`cache_ttl_quote`: `15 * 60` → `60 * 60`. Minor now that stale still serves instantly, but it
cuts background-refresh churn. Optionally add a `quote_refresh_workers` (=4) knob.

## Data flow (after)

```
GET /analysis/portfolio
  → read instruments + txs + cached quotes/history from SQLite   (no upstream calls)
  → for each held position with stale/missing quote: refresh.enqueue_quote(sym)
  → for each symbol/benchmark with stale/missing history: refresh.enqueue_history(sym)
  → compute positions + counterfactuals from cache
  → return { ...data, quotesUpdatedAt, refreshInProgress }        (<100 ms)

background pool (≤4 concurrent, semaphore-throttled, 429 backoff)
  → provider.quote / provider.chart → write quote_cache / price_cache / dividend_cache

frontend
  → if refreshInProgress || any position 'pricing': poll every ~2.5s
  → header shows "Prices updated N min ago · Refreshing…"
  → 'pricing' rows show pending state, fill in on next poll
```

## Error handling

- Background fetch failure: logged (as today), cache untouched; stale/pending row keeps
  serving. In-flight id is always cleared in `finally` so a failed symbol can be retried on a
  later request.
- Rate-limit (429): provider retry/backoff inside the pool; the request path is unaffected
  because it never waits on the pool.
- Cold DB / data reset: positions show `pricing`; counterfactual computed from empty history
  until backfill lands; frontend polling reconciles.

## Files touched

- `backend/app/services/marketdata.py` — SWR `get_quote`; non-blocking `ensure_history` /
  `get_dividends`.
- `backend/app/services/refresh.py` — **new**: bounded pool, in-flight set, `refresh_in_progress`.
- `backend/app/providers/yfinance_provider.py` — `_gate` Lock → Semaphore(N); drop/reduce
  `yf_min_gap_ms`.
- `backend/app/routers/analysis.py` — add `quotesUpdatedAt` / `refreshInProgress` to portfolio
  response.
- `backend/app/services/finance.py`, `services/datastatus.py` — emit `pricing` state.
- `backend/app/core/config.py` — `cache_ttl_quote` bump; optional worker-count knob.
- `shared/src/types.ts` — add `'pricing'` to `InstrumentDataStatus['state']`.
- `frontend/src/lib/api.ts` — extend `PortfolioResponse`.
- `frontend/src/components/ui.tsx` — `STATUS_META.pricing`.
- `frontend/src/views/Dashboard.tsx` + store — remove blocking spinner, conditional polling,
  header indicator, pending-row rendering.

## Constraints honored

Tailwind only, dark-mode only, modals not redirects, Conventional Commits (many small).
Implementation only — no tests / Playwright / verification agents; the owner tests the running
app. Single-worker gunicorn (`-w 1`).

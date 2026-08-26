# DecisionGuru — API Contract

The single source of truth the FastAPI backend must reproduce **byte-for-byte in shape**.
It is the contract the existing (unchanged) React frontend consumes today. Extracted from
the retired Node/Express backend (`backend/src/routes/*`) and cross-checked against every
call in `frontend/src/lib/api.ts`.

- **Base URL:** all endpoints are served under `/api`. The Vite dev server proxies `/api`
  → `http://localhost:5178`, so the backend **must listen on port 5178** and mount every
  route under the `/api` prefix.
- **Content type:** JSON in, JSON out (except file upload + exports). `express.json` limit
  was 15 MB; uploads accepted up to 25 MB.
- **CORS:** open (`cors()` with defaults) — allow the frontend origin.
- **Error envelope:** every failure returns `{ "error": "<message>" }` with an appropriate
  status (`400` bad request, `404` not found, `422` unprocessable, `500` internal). The
  frontend reads `body.error`.
- **Health:** `GET /api/health` → `{ ok: true, service: "decisionguru", time: <ISO> }`.
- **Money:** all monetary outputs are CHF unless a field name says otherwise. Field naming
  is **camelCase** and must be preserved exactly.

Domain object shapes (`Instrument`, `Transaction`, `Position`, `CounterfactualResult`,
`ScenarioResult`, `AllocationBreakdown`, `ParsedFile`, `ImportPreviewRow`, …) are defined
in `shared/src/types.ts` and are authoritative; this document lists the endpoints and their
request/response envelopes.

---

## settings
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/settings` | — | `AppSettings` |
| PUT | `/api/settings` | `Partial<AppSettings>` | `AppSettings` (merged: shallow spread + `tax` deep-merged + `benchmarks` replaced if present) |
| POST | `/api/settings/reset` | — | `AppSettings` (defaults) |

## instruments
| Method | Path | Query/Body | Response |
|---|---|---|---|
| GET | `/api/instruments` | — | `Instrument[]` (ordered by name) |
| GET | `/api/instruments/search?q=` | `q` | `Array<{symbol,name,exchange,kind,type}>` (Yahoo search hits; `[]` if empty q) |
| POST | `/api/instruments/reresolve-all` | `{offline?:boolean}` | `{attempted:number, offline:boolean, results:Array<{id,isin,symbol,unresolved}>}` |
| POST | `/api/instruments/:id/reresolve` | `{offline?:boolean}` | `Instrument` (404 if missing) |
| GET | `/api/instruments/:id/status` | — | `InstrumentDataStatus` (404 if missing) |
| GET | `/api/instruments/:id` | — | `Instrument` (404 if missing) |
| GET | `/api/instruments/:id/transactions` | — | `Transaction[]` (ordered date,id) |
| POST | `/api/instruments` | `Partial<Instrument>` (needs symbol\|isin\|name) | `Instrument` (resolves + patches domicile/kind/incomeYieldOverride) |
| PATCH | `/api/instruments/:id` | `Partial<Instrument>` | `Instrument` (404 if missing) |
| DELETE | `/api/instruments/:id` | — | `{ok:true}` |
| POST | `/api/instruments/manual` | `{symbol?,isin?,name?,date,amount?,units?,currency?,action?}` | `{instrument:Instrument, transaction:Transaction, derivedPrice:number}` (400/422 on validation) |

`InstrumentDataStatus.state`: `'ok' | 'stale' | 'unresolved' | 'no-data'`.

## transactions
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/transactions` | `Partial<Transaction>` (needs instrumentId, action, date) | `Transaction` (400 on validation) |
| DELETE | `/api/transactions/:id` | — | `{ok:true}` |

## analysis
| Method | Path | Query/Body | Response |
|---|---|---|---|
| GET | `/api/analysis/position/:id?preTax=` | `preTax` | `Position` (404 if missing) |
| GET | `/api/analysis/counterfactual/:id?preTax=&benchmark=` | | `CounterfactualResult` |
| GET | `/api/analysis/breakeven/:id?benchmark=` | | `BreakEvenResult & {benchmark:string}` |
| GET | `/api/analysis/projection/:id?benchmark=&years=&stockCagr=&etfCagr=` | | `ProjectionResult & {benchmark:string}` |
| GET | `/api/analysis/dividend-shock/:id?cut=` | `cut` 0..1 | `{currentAnnualGrossCHF, shockedAnnualGrossCHF, lostGrossCHF, lostNetAfterTaxCHF, cut}` |
| GET | `/api/analysis/portfolio?preTax=&benchmark=` | | `PortfolioResponse` (see below) |
| POST | `/api/analysis/compare` | `{instrumentIds:number[], benchmarks:string[], preTax?:boolean}` | `CompareResponse` (see below) |
| GET | `/api/analysis/portfolio/series?range=` | `range` = `1D..MAX` (default `1Y`) | `RangeSeries` `{range, points:[{date,value}], stats:{high,low,start,end,changeAbs,changePct}\|null}` |
| GET | `/api/analysis/series/:id?range=` | | `RangeSeries` (404 if instrument missing) |
| GET | `/api/analysis/advisory?includeHandled=` | | `{insights:AdvisoryInsight[], handled:number[]}` |
| POST | `/api/analysis/advisory/:id/handled` | `{handled?:boolean=true}` | `{ok:true, handled:number[]}` |

**PortfolioResponse**: `{ benchmark, preTax, positions:Position[] (each +netDividendsCHF,+weight), counterfactuals, aggregate:{...}, totals:{investedCHF,currentValueCHF,realizedCHF,unrealizedCHF,netDividendsCHF,absolutePLChf,totalGainCHF,depositsCHF,feesCHF}, cash:{totalCHF, byCurrency:{[ccy]:{amount,chf}}}, accountDividends:AccountDividend[], hasPositions, hasAccount, unknownEvents, quotesUpdatedAt, refreshInProgress }`

Series endpoints use **cached prices only** (never block on Yahoo). Portfolio series =
forward-filled sum of each holding's `quantity_held × close × FX(→CHF)` on a shared date
axis. Advisory `netDividendsCHF`/`totalGainCHF`/`cash` come from the ingested account
statement; `totalGainCHF = realized + unrealized + net dividends`.

**CompareResponse**: `{ preTax, instrumentIds:number[], positions:Position[], comparisons:Array<{benchmark, benchmarkName, aggregate:{...}, perPosition:Array<{instrumentId,symbol,name?,counterfactual}>}> }`

Only instruments **with transactions** contribute positions/counterfactuals. `compare` with
empty `instrumentIds` falls back to all instruments; empty `benchmarks` falls back to
`[defaultBenchmarkSymbol]`.

## data management
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/data/reset` | `{keepResolutions?:boolean=true}` | `{ok:true, cleared:string[], keptResolutions:boolean}` |

Clears transactions, instruments, price/quote/dividend/fund caches (+ `symbol_map` when
`keepResolutions=false`) and instrument-scoped notes. Keeps settings, benchmarks, presets.

## market
| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/market/quote/:symbol` | — | `{symbol,price,currency,name,time,stale}` |
| GET | `/api/market/history/:symbol?from=&to=` | | `PricePoint[]` (`{date,close}`) |
| GET | `/api/market/fund/:symbol` | — | fund summary passthrough (or `null`) |
| GET | `/api/market/search?q=` | | Yahoo search hits |
| GET | `/api/market/fx?from=&to=&date=` | | `{from,to,date,rate}` |
| GET | `/api/market/allocation/:instrumentId` | — | `AllocationBreakdown` (404 if missing) |

## scenarios
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/scenarios` | — | `Scenario[]` |
| GET | `/api/scenarios/:id` | — | `Scenario` (404) |
| POST | `/api/scenarios` | `{name, config}` | `Scenario` (400) |
| PUT | `/api/scenarios/:id` | `{name, config}` | `Scenario` (404) |
| DELETE | `/api/scenarios/:id` | — | `{ok:true}` |
| POST | `/api/scenarios/run` | `ScenarioConfig` | `ScenarioResult` |

## notes
| Method | Path | Query/Body | Response |
|---|---|---|---|
| GET | `/api/notes?target=&targetId=` | (no target → all notes) | `Note[]` |
| POST | `/api/notes` | `{target, targetId, body}` | `Note` (400) |
| PATCH | `/api/notes/:id` | `{body}` | `Note` (404) |
| DELETE | `/api/notes/:id` | — | `{ok:true}` |

## imports
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/imports/upload` | multipart `file` | `ParsedFile & {defaultActionMap}` (400 no file, 422 parse error) |
| GET | `/api/imports/file/:fileId` | — | `ParsedFile` (404) |
| POST | `/api/imports/preview` | `ImportMapping` | txns: `{rows:ImportPreviewRow[], okCount, total, trades, corporateActions}`; account (`kind:'account'`): `{kind:'account', rows:AccountPreviewRow[], okCount, total, byType, unknownCount, reversedCount}` (400/404) |
| POST | `/api/imports/commit` | `ImportMapping` | txns: `{imported, skipped, corporateActions, instruments:number[]}`; account: `{kind:'account', importedEvents, skipped, linked, dividends, summary}` (400/404) |
| GET | `/api/imports/presets` | — | `ImportPreset[]` |
| POST | `/api/imports/presets` | `{name, mapping}` | `{ok:true}` (400) |
| DELETE | `/api/imports/presets/:id` | — | `{ok:true}` |

DeGiro **Transactions** export is auto-detected (`detectedBroker:'degiro'`, `detectedKind:'transactions'`)
and uses a dedicated transform when `mapping.broker === 'degiro'`; otherwise the generic column
mapping is applied.

The DeGiro **Account statement (Kontoauszug)** is auto-detected as `detectedKind:'account'` (blank
amount/balance columns parsed by position). `preview`/`commit` with `mapping.kind === 'account'` run
the account transform: normalizes each `Beschreibung` to `deposit | cash_sweep | fx_conversion |
dividend | withholding_tax | corp_action_fee | connectivity_fee | unknown`, nets storno pairs
(opposite sign, same security/amount within 10 min), and stores rows in `account_events`. Events
link to instruments **on ISIN** (DB-only lookup, never a Yahoo resolve) after either import order.
Account cash, dividends-by-ISIN, deposits and fees surface via `PortfolioResponse`.

## export
| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/api/export/excel` | `{title, sheets:[{name, table:{title?,headers,rows}}]}` | `.xlsx` binary (attachment) |
| POST | `/api/export/pdf` | `{title, subtitle?, tables:[{title?,headers,rows}], notes?, chartImage?, disclaimer?}` | `.pdf` binary (attachment) |

## market (extensions)
| Method | Path | Query | Response |
|---|---|---|---|
| GET | `/api/market/news/:symbol` | `limit=12` | `{symbol, items:NewsItem[], stale, fetchedAt}` — Yahoo RSS, cached (`news_cache`), de-duplicated by link hash |
| GET | `/api/market/hours` | — | `{exchanges:ExchangeStatus[]}` — live open/closed for SIX/US/LSE/Xetra |
| GET | `/api/market/hours/:symbol` | — | `ExchangeStatus` for the symbol's exchange |
| GET | `/api/market/movements/:symbol` | `from?` | `{legs:MovementLeg[], stagnation:StagnationWindow[], coverage}` — zig-zag surge/drop legs + stagnation stretches from cached closes |

`ExchangeStatus`: `{code,name,country,tz,localTime,localDate,open,close,isOpen,nextChange:'opens'|'closes',minutesToNextChange, secondsToNextChange, nextChangeAt (UTC ISO), serverNowUtc (UTC ISO)}`. `nextChangeAt`/`serverNowUtc` let the client tick a live HH:MM:SS countdown against its own clock (skew-corrected) without polling every second.

`Position` additionally carries `firstBuyDate` (actual entry date), `lastSellDate` (most recent sell or null), and `closedDate` (set when fully sold out — the closing date; null while open). Fully-closed positions are still returned by `/api/analysis/portfolio` with `openQuantity 0`.
Regular cash-session hours only; public holidays are not modelled.

## decisions (decision engine)
| Method | Path | Query/Body | Response |
|---|---|---|---|
| GET | `/api/decisions/recommendations` | — | `{recommendations:Recommendation[], cashSignal, summary}` — explainable Buy/Hold/Sell/Trim, one counterfactual vs the default benchmark per holding, ranked by capital at stake |
| GET | `/api/decisions/recovery/:id` | `horizon=5&alternatives=SYM,SYM` | `{proceedsCHF,targetCHF,alternatives[],fastest,combinations[],...}` — recovery-time per alternative + single/multi-asset strategies |
| POST | `/api/decisions/simulate` | `{sellInstrumentIds:number[], targets:[{symbol,allocationPct}], horizonYears?}` | sell-today→reinvest outcome vs holding, with recovery years |
| GET | `/api/decisions/exposure` | — | `{totalValueCHF,countries[],sectors[],holdings[],concentration}` — value-weighted portfolio geo/sector rollup |
| GET | `/api/decisions/exposure/compare` | `a=&b=` (instrument ids) | `{a,b,overlap}` — two assets' exposures + country/sector overlap |

Each `Recommendation` carries an explicit `reason`, `impactCHF`, `recoveryMonths`, the exact
reinvest `benchmarkSymbol`/`benchmarkName`, and the holding's return/CAGR/XIRR.

## plans (decision plans)
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/plans` | — | `DecisionPlan[]` (newest first) |
| POST | `/api/plans` | `{name, config:PlanConfig}` | `DecisionPlan` — snapshots a baseline at creation |
| GET | `/api/plans/:id` | — | `DecisionPlan` (404) |
| PUT | `/api/plans/:id` | `{name?, config?, status?}` | `DecisionPlan` (rebaselines when the sell/target set changes) |
| DELETE | `/api/plans/:id` | — | `{ok:true}` |
| GET | `/api/plans/:id/compare` | — | `{plan:{valueNowCHF,...}, hold:{valueNowCHF,...}, deltaCHF, ...}` — reprices the baseline units at today's prices (plan reinvested vs held) |

`PlanConfig`: `{sellInstrumentIds:number[], targets:[{symbol,name?,allocationPct}], horizonYears?, intendedOutcome?}`.

## research (any-asset)
| Method | Path | Query/Body | Response |
|---|---|---|---|
| GET | `/api/research/asset/:symbol` | `window=5` | `{symbol,name,kind,metrics,allocation,movements,news}` — portfolio-independent snapshot |
| POST | `/api/research/claim` | `{symbol, claim:string\|ClaimSpec}` | `{parsed,actual,supported,explanation,...}` — validate a claim vs history (structured or plain-English) |
| POST | `/api/research/compare` | `{entities:[{type:'instrument'\|'symbol'\|'portfolio',...}], windowYears?}` | `{windowYears, entities:AssetMetrics[]}` — one consistent risk/return metric set, ranked |

`AssetMetrics` is identical across held instruments, arbitrary symbols and the whole portfolio
(the portfolio's return is money-weighted XIRR, not the contribution-inflated value series).

---

## Backend routing: interactive (pandas) vs. heavy (PySpark)

- **Interactive / low-latency (pandas + numpy + scipy):** single-instrument endpoints —
  `position`, `counterfactual`, `breakeven`, `projection`, `dividend-shock`, `quote`,
  `history`, `allocation`, `manual`, all CRUD.
- **Heavy / bulk (PySpark, lazy local SparkSession, offloaded to a threadpool):** the
  portfolio-wide aggregation across many positions — `analysis/portfolio`,
  `analysis/compare`, `scenarios/run` — where per-position counterfactual series are summed
  by date (a natural distributed group-by / reduce). Spark degrades gracefully to the pandas
  reducer (identical output) when a `SparkSession` cannot be created, so the contract never
  changes and requests never hang.

All blocking work (yfinance, Spark, pandas-heavy loops) is offloaded via
`run_in_threadpool` so the event loop never blocks.

# Market-Data Audit — Historical Price / Dividend Integrity

_Last run: 2026-08-26. Trigger case: **The Swatch Group AG** charting to ~CHF 12,000 / share with a current value of CHF 7,650._

## TL;DR

The Swatch anomaly was **not** a scaling, currency, or split bug. It was a **wrong-instrument (share-class) resolution error**: the ISIN was mapped to the wrong Yahoo ticker. The cached price/dividend series for the *mapped* symbol was itself perfectly correct — it was simply the wrong security. A second holding (UBS SMI ETF) had the same class of error. Both are fixed; a general guard now catches this class of bug for every holding.

## Root cause

`CH0012255144` (the ISIN on the executed Swatch buy) is Swatch's **registered share** (_Namenaktie_, ~CHF 40). The curated ISIN map resolved it to **`UHR.SW`**, the **bearer share** (_Inhaberaktie_, ~CHF 190 today, all-time high ~CHF 600 in 2014).

The user bought **40 shares at CHF 49.50** (2023-06-19). That price only exists on the registered line:

| Date (trade) | `UHR.SW` (bearer, mapped) | `UHRN.SW` (registered, actual) | Executed |
|---|---:|---:|---:|
| 2023-06-19 | 258.40 | **48.90** | **49.50** |
| current | 191.25 | **37.60** | — |

Because the position value is `quantity × series price`:

- `40 × 191.25 = CHF 7,650` → the exact bogus "current value".
- `40 × ~300` (bearer, mid-history) `≈ CHF 12,000` → the chart peak.
- Real value: `40 × 37.60 = CHF 1,504` — a **loss** on CHF 1,980 invested, not a gain.

The "expected ~CHF 190 / CHF 600 / CHF 4.50 dividend" in the original brief describes the **bearer** share (what you get by searching "Swatch" on Google Finance). The **executed transaction price is the ground truth**, and it proves the holding is the registered share. The reference/executed price wins.

### Second instance — UBS SMI ETF

`CH0017142719` ("UBS SMI ETF CHF DIS", bought at CHF 123.90) was mapped to **`SMMCHA.SW`** — which is the UBS **SMIM** _mid-cap_ ETF (~CHF 340). The correct line is **`SMICHA.SW`**, the UBS **SMI** ETF (CHF 123.00 on the trade date). Same share-class/line confusion, ratio 2.8×.

## The fix

A wrong resolution persists in **five** places; correcting the seed alone is not enough:

1. `backend/app/reference/isin_map.py` — curated seed (backend)
2. `shared/src/isin-map.ts` — curated seed (frontend)
3. `symbol_map` table — permanent resolution cache (overrides the seed)
4. `instruments` table — the resolved symbol per holding
5. `price_cache` / `quote_cache` / `dividend_cache` — keyed by the (wrong) symbol

- **Seeds** corrected: `CH0012255144 → UHRN.SW`, `CH0017142719 → SMICHA.SW`.
- **`repair_misresolved_instruments()`** (runs at startup, idempotent) reconciles `symbol_map` + `instruments` against the curated seed for every ISIN, rewrites any *non-manual* row that disagrees, and **purges the orphaned symbol's caches** so the corrected symbol backfills clean. Manual overrides are never touched.

Post-fix verification:

| Symbol | Quote | Series range | Div (recent) | Entry match |
|---|---:|---|---|---|
| `UHRN.SW` | CHF 37.60 | 25.64 – 54.90 | ~0.90–1.30 / yr | 48.90 vs paid 49.50 ✓ |
| `SMICHA.SW` | CHF 150.00 | 102.98 – 150.52 | ~0.7–0.8 / distrib | 123.00 vs paid 123.90 ✓ |

## The guard — executed-price vs resolved-series integrity check

`backend/app/services/price_integrity.py`. The strongest per-holding ground truth we own is the **executed transaction price**. For each buy, the guard compares the executed unit price against the cached series price **on the trade date**, both converted to CHF via trade-date FX (so a cross-currency listing is not a false positive). A ratio beyond **2.0×** → the resolved series is the wrong instrument / currency / scale.

Empirically this separates real bugs from noise cleanly on this portfolio:

- Wrong instrument: **Swatch 5.2×**, **UBS-SMI 2.8×** → flagged.
- Worst *legitimate* noise (intraday fill vs daily close + FX timing): **~1.16×** → passes.

When the guard fails, `datastatus` returns a **`data-issue`** state (with the shown-vs-paid ratio and a fix hint) instead of `ok`, and the position page shows a prominent banner — a plausible-looking wrong number is flagged, never displayed as real. A false-positive is fixed with one click via "Fix symbol".

## Dividends

Dividends were **already** correct and are **not** a bug. Received dividends come from `Account.csv` (the source of truth), reconciled per-ISIN in `services/account.py::dividends_by_isin` and overlaid onto each position in the analysis router; they fall back to transaction-derived dividends only when no account events exist. Swatch has **zero** account dividend events, so its CHF 0 net received dividend is **truthful** (the ~CHF 4.50 in the brief was again the bearer-share figure). The provider dividend series is available for yield/counterfactual use.

## Full per-holding audit (executed vs series, near trade date)

All ratios ≤ 1.2× unless noted. Ratios > 1 that are *not* bugs are cross-currency (executed in a different currency than the listing) — handled correctly by the CHF-normalised guard.

| Status | Holdings |
|---|---|
| **Fixed (was wrong instrument)** | `UHR.SW→UHRN.SW` (Swatch), `SMMCHA.SW→SMICHA.SW` (UBS SMI ETF) |
| **OK** | NESN, NOVN, SRAIL, BARN, AMD, ASAN, BRK-B, CRSR, DX, IBM, META, NKE, NVDA, PFE, SNY, TTWO, TGT, UPS, UNH, SAN.PA, CA.PA, LHA.DE, VNA.DE, CNDX.L, SSAC.L, VUAA.L, VWRA.L, VWRL.SW, VUAA, CSU.TO |
| **OK, cross-currency exec** | `CSU.TO` (bought in EUR on Tradegate; 1.58× is EUR↔CAD FX, not a bug) |
| **Provider gap (no series)** | `ROG.SW` (Roche Genussschein, ISIN CH0012032048) — Yahoo dropped this ticker (404). `RO.SW` exists but is the **bearer/voting** share (~7% premium) — a different class, so **not** substituted. Roche is a **closed** position, so its money figures come from executed prices; only the historical chart is affected. |
| **Delisted / private — correctly unresolved** | Tattooed Chef (`US87663X1028`), Social Capital Hedosophia IV & VI (`KYG825141032`, `KYG8251L1059`), Razer (`KYG7397A1067`) — no live ticker; shown as `unresolved`. |
| **Illiquid `.V` — no Yahoo series** | Else Nutrition (`BABY.V`), Good Natured Products (`GDNP.V`) — resolve but Yahoo returns no history; shown as `no-data`. |

## Remaining gaps / follow-ups

- **Roche Genussschein series**: no correct Yahoo ticker currently available. If one appears (or a second provider is added), map `CH0012032048` to it; do **not** use `RO.SW` (wrong share class).
- **Illiquid `.V` lines**: depend on Yahoo coverage; a secondary provider would fill these.
- The guard is a *detector*, not an auto-fixer — a flagged holding is surfaced for a one-click symbol correction rather than silently re-resolved, to avoid swapping to another wrong line automatically.

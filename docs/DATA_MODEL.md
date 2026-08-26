# DecisionGuru — Data model (source files)

> Everything the app shows is derived from **two DEGIRO exports**. This document
> records their real structure (as observed in the sample files), the sign
> conventions, and the calculation definitions that the import + valuation layer
> must honour. When a rule was ambiguous, the decision taken is marked **[D]**.

## 1. `Transactions.csv` — security trades (Transaktionsübersicht)

Header row (17 columns, two currency columns carry a **blank** header — parsed by
position):

| # | Header | Field | Notes |
|---|--------|-------|-------|
| 0 | `Datum` | date | `DD-MM-YYYY` |
| 1 | `Uhrzeit` | time | `HH:MM` |
| 2 | `Produkt` | name | quoted names may contain commas |
| 3 | `ISIN` | isin | **primary instrument key** |
| 4 | `Referenzbörse` | referenceExchange | |
| 5 | `Ausführungsort` | executionVenue | may be empty |
| 6 | `Anzahl` | quantity | **signed** → +buy / −sell |
| 7 | `Kurs` | unitPrice (native) | |
| 8 | *(blank)* | priceCurrency | currency of `Kurs` |
| 9 | `Wert in Lokalwährung` | localValue | signed, native currency |
| 10 | *(blank)* | localCurrency | currency of local value |
| 11 | `Wert CHF` | valueCHF | signed, already CHF |
| 12 | `Wechselkurs` | fxRate | native→CHF at trade time (blank for CHF) |
| 13 | `AutoFX-Gebühr` | fee part (CHF) | may be empty |
| 14 | `Transaktionsgebühren …` | fee part (CHF) | may be empty |
| 15 | `Gesamt CHF` | totalCHF | **net cash effect in CHF** (incl. fees) |
| 16 | `Order-ID` | orderId | empty for corporate actions |

**Key fact:** columns 11 (`Wert CHF`) and 15 (`Gesamt CHF`) are already converted to
CHF by the broker at the trade-time FX rate. The importer therefore stores each
trade's `unitPrice` as **CHF per share** (`|valueCHF| / |qty|`) and `currency = "CHF"`,
so the position builder must **never re-apply FX to a trade** — the cost basis is
already CHF. This is the single most important rule for avoiding double FX.

**Sign convention:** `Anzahl > 0` = buy (cash out, `Gesamt CHF` negative);
`Anzahl < 0` = sell (cash in, `Gesamt CHF` positive).

**Corporate actions / delistings** appear as rows with `Kurs = 0` and
`Gesamt CHF = 0` (e.g. Tattooed Chef, Social Capital SPACs, Razer) or as **paired
±quantity rows** on the same day for the same security (ISIN change / class swap,
e.g. Else Nutrition's `CA290257…` chain). These are flagged `category:
corporate_action` and **excluded from P/L**, but kept for history.

### Cost-basis & P/L definitions (per position)

- `openQuantity` = Σ signed quantities of non-corporate trades.
- `investedCHF` = Σ CHF cost of **all buys** (incl. fees) — the capital deployed.
  This is the headline "invested" figure. **[D]** the owner's reference "invested"
  ≈ total gross buys, not average-cost remaining basis.
- Average-cost lots: each sell removes `open_cost × (qty_sold / open_qty)`.
- `realizedCHF` = Σ over sells of `(proceeds − cost_removed)`.
- `currentValueCHF` = `openQuantity × live_price × FX(price_ccy→CHF)` — **FX applied
  exactly once**, price normalised to major currency units first (see §3).
- `unrealizedCHF` = `currentValueCHF − open_cost_chf` (remaining basis).
- **Total gain (position & portfolio)** = `currentValueCHF + realizedCHF +
  netDividendsCHF − investedCHF`. Method-independent economic gain.

## 2. `Account.csv` — cash movements (Kontoauszug)

Header row (12 columns; the mutation amount and running balance carry **blank**
headers, parsed by position after their currency column):

| # | Header | Field | Notes |
|---|--------|-------|-------|
| 0 | `Datum` | date | `DD-MM-YYYY` |
| 1 | `Uhrze` | time | header typo for Uhrzeit |
| 2 | `Valutadatum` | valueDate | |
| 3 | `Produkt` | name | empty on pure cash/FX rows |
| 4 | `ISIN` | isin | attributes dividends to a security |
| 5 | `Beschreibung` | description | → normalised event **type** |
| 6 | `FX` | fx | only on Währungswechsel rows |
| 7 | `Änderung` | currency | currency of the mutation |
| 8 | *(blank)* | amount | **signed mutation** |
| 9 | `Saldo` | balanceCurrency | currency of the running balance |
| 10 | *(blank)* | balance | running balance for that currency |
| 11 | `Order-ID` | orderId | empty on cash events |

### Description → type mapping

| Beschreibung (prefix / contains) | type |
|---|---|
| `Einzahlung` | `deposit` |
| `… flatexDEGIRO Bank …`, `Cash Sweep`, `Geldkonto` | `cash_sweep` |
| `Währungswechsel …` | `fx_conversion` |
| `Dividendensteuer` (checked first) | `withholding_tax` |
| `Dividende` | `dividend` |
| `Gebühr für Kapitalmaßnahme` | `corp_action_fee` |
| `Einrichtung von Handelsmodalitäten …` | `connectivity_fee` |

**Storno / reversals:** re-booked rows (same security + type + `|amount|` +
currency, opposite sign, within 10 min) are flagged `reversed` and excluded
everywhere (e.g. the Sanofi dividend booked, reversed, re-booked).

### Cash balance — the canonical definition **[D]**

DEGIRO's flatex model keeps two internal pools that are **both your cash**:

1. the **settlement (trading) account** — the running `Saldo`; kept near zero
   because idle cash is swept out; and
2. the **flatex Geldkonto** — the interest-bearing cash reserve that deposits are
   swept *into* (`Überweisung auf Ihr Geldkonto bei der flatexDEGIRO Bank …` +
   its `Degiro Cash Sweep Transfer` counterpart).

A **`cash_sweep` only moves money between these two pools** — it never leaves your
cash. Summing *all* mutations (the old bug) makes a deposit (+20 000) and its sweep
(−20 000) cancel to `≈ 0` → the observed `CHF -0.00`.

**Canonical cash = Σ (non-reversed mutations, EXCLUDING `cash_sweep`), per
currency, converted to CHF once.** This is the ledger of money that entered your
DEGIRO cash and has not been spent on securities: `deposits + net dividends −
fees + net FX`. One value, reused on every page.

> Caveat: the sample `Account.csv` is a **partial** window (2026-07-30 → 2026-08-17),
> so it does not carry the settlement account's opening balance (~CHF 335). The
> canonical figure is therefore the *reserve inflow over the window* (≈ CHF 20 030),
> which is the right order of magnitude for current cash. A full statement (from
> account opening) reconciles exactly. The running `Saldo` column is retained
> per-row for audit only — its same-timestamp ties make it unsafe as the headline.

**Dividends are the account statement's responsibility** (source of truth), keyed
on ISIN: `netCHF = grossDividende + Dividendensteuer` (tax is negative).

## 3. Live valuation & FX — minor-currency units **[D]**

Yahoo quotes **UK-listed instruments in `GBp` (pence)**, not pounds. `SSAC.L`
(iShares MSCI ACWI) quotes at `9120 GBp`. `frankfurter` has no `GBp` rate, so
`FX(GBp→CHF)` degraded to `1.0` and that one position valued at
`24 × 9120 × 1 = CHF 218 880` instead of `~CHF 2 357` — single-handedly inflating
the portfolio from ~CHF 103 k to the observed CHF 322 k (and every derived figure:
total gain, today's P/L).

**Rule:** normalise minor units to their major currency **at the provider boundary
and defensively on every cached read** before applying FX:

| Minor | Major | Factor |
|---|---|---|
| `GBp`, `GBX` | `GBP` | ÷100 |
| `ZAc` | `ZAR` | ÷100 |
| `ILA` | `ILS` | ÷100 |

Normalisation is idempotent (only divides when the currency is a known minor unit),
so applying it at both write and read time is safe. FX is then applied **exactly
once**, `major_ccy → CHF`.

## 4. Instrument classification & delisted handling **[D]**

- `instruments.kind ∈ {stock, etf}` is derived at resolution time (Yahoo
  `quoteType == ETF`) and persisted. UCITS ETFs (Vanguard/iShares/UBS) are `etf`;
  everything else `stock`.
- **No-ticker / delisted:** an instrument whose `symbol == isin` (never resolved to
  a real ticker) or flagged `unresolved` is **delisted / untracked**. It is
  excluded from live valuation and today's P/L (no stale price), but keeps its
  realised P/L, dividends and cost history, and is surfaced in a labelled
  "delisted / untracked" group. Quote/history fetches for these are **not retried
  in a loop** — they are skipped.

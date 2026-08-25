# DecisionGuru — Swiss Tax Model

> How DecisionGuru models taxation for a **private investor** resident in Switzerland.
> Every figure here is a **configurable assumption** with a Swiss-sensible default,
> editable in the Settings modal. All comparisons are computed **after-tax**, with a
> pre-tax / after-tax toggle so the tax drag is always visible.
>
> This is a modelling tool, **not tax advice**. Real liability depends on canton,
> municipality, income bracket, marital status, and the ESTV *Kursliste*. Treat outputs
> as directional estimates.

## 0. Who this models

A **private investor** (Privatperson), not a professional securities dealer
(*gewerbsmässiger Wertschriftenhändler*). The distinction matters enormously:
professionals are taxed on capital gains. The whole model below assumes private status.
A Settings flag `professionalTrader` (default **off**) exists to note the caveat; when on,
the app surfaces a warning that capital gains would become taxable (we still show the
private-investor computation but flag it).

## 1. Capital gains — TAX-FREE (the crux)

For a private investor, **realised and unrealised capital gains are not taxed**.
Selling a stock or an ETF at a profit incurs **zero** tax on the price appreciation.

**Consequence the app must make visible:** this structurally favours **price growth over
income**. An accumulating world ETF that grows mostly via price appreciation is highly
tax-efficient; a high-dividend stock is not, because (see §2) the dividend is taxed every
year regardless of whether you wanted the cash.

Setting: `capitalGainsTaxable` (default **false**). Do not expose casually — it flips the
entire thesis; it lives under an "Advanced / professional trader" disclosure.

## 2. Dividends & income — taxed as INCOME at the marginal rate

Dividends and interest are **taxable income**, added to the investor's other income and
taxed at their **marginal rate** (federal + cantonal + municipal combined).

- Setting: `marginalIncomeRate` — single input %, default **30%** (a mid Swiss combined
  marginal rate; real range ≈ 20–45%). Advanced breakdown optional:
  `federalRate`, `cantonalRate`, `municipalMultiplier` — if provided, the effective
  marginal rate is derived; otherwise the single `marginalIncomeRate` is used directly.
- This is the **real drag on dividend stocks** and the reason a mediocre dividend payer
  can badly trail an accumulating ETF after tax even at similar pre-tax total return.

## 3. Accumulating ETFs do **NOT** escape dividend tax

**Common misconception — corrected explicitly in the UI.** In Switzerland the taxable
income of a fund is taxed **whether it is distributed or reinvested**. For accumulating
funds, the reinvested income component is reported as *steuerbarer Ertrag* in the ESTV
*Kursliste* and taxed as income in the year it accrues — even though **no cash is paid
out**. You owe income tax on money you never received as cash.

**Modelling:** each ETF (and stock) carries an **income yield** used for the tax drag:

- Distributing funds: use the actual distribution yield.
- Accumulating funds: use the fund's **income component yield** (`accumulatingIncomeYield`),
  taxed at `marginalIncomeRate` every year, applied to the FX-converted market value —
  **regardless of distribution**. Default estimate: derive from the underlying index gross
  vs. net return; when unknown, fall back to the fund's trailing distribution-equivalent
  yield (Settings: `defaultEtfIncomeYield`, default **1.8%** for a broad world equity ETF).
- **Only price appreciation beyond the income component is tax-free.** The engine splits
  total return into (income component → taxed) + (price appreciation → free).

The UI copy states plainly: *"Accumulating ETFs are still taxed on their income component
in Switzerland — reinvestment does not avoid the dividend tax."*

## 4. Withholding tax (Verrechnungssteuer & foreign)

### Swiss withholding (Verrechnungssteuer) — 35%
Swiss dividends are levied 35% at source, **fully reclaimable** by a Swiss resident who
declares them. Modelled as reclaimable by default.

- `swissWithholdingRate` default **35%**.
- `swissWithholdingReclaimed` default **true** (fully reclaimed).
- `reclaimDelayMonths` default **12** — the cash-flow delay before the reclaim lands.
  Used to model a (small) time-value drag on the reclaimed amount when
  `applyReclaimTimeValue` is on (default **off**; a second-order effect).

Net effect when fully reclaimed: Swiss withholding is **cash-flow timing only**, not a
permanent cost. The permanent cost is the income tax of §2.

### Foreign withholding (per domicile)
Foreign dividends suffer source-country withholding, partly reclaimable via DA-1 (US),
tax-treaty refunds (FR, DE, etc.).

- `foreignWithholding[domicile]` map, defaults: **US 15%** (treaty rate via W-8BEN),
  **generic 15%**, with `foreignReclaimFraction` default **1.0** for US (DA-1 credit) and
  configurable per domicile. Non-recoverable foreign withholding (the part above treaty,
  or unclaimed) is a **permanent cost** subtracted from net dividends.
- Instruments carry a `domicile` (issuer/fund domicile, e.g. IE for Irish-domiciled UCITS,
  US for US-listed). Irish-domiciled accumulating UCITS (VWRL/VWRA/CSPX) are the common
  tax-efficient wrapper for Swiss investors on US equity (15% US L1 withholding at fund
  level, no L2) — the model reflects this via the fund's net income yield, not a separate
  reclaim.

## 5. Wealth tax (Vermögenssteuer)

Annual tax on **net market value** of holdings at year-end, applying **equally to stocks
and ETFs** (so it is comparison-neutral but included for fair long-hold totals).

- `wealthTaxRate` default **0.3%** per year (varies by canton/bracket ≈ 0.1–1.0%).
- Applied to the mean market value over the holding period (or year-end snapshots when
  available), FX-converted to CHF. Included in after-tax totals and in projections.

## 6. Currency

- Base currency **CHF**. Holdings may be USD/EUR (extensible).
- **Historical FX** (frankfurter.app / ECB) applied at each transaction date to convert
  invested capital; **current FX** for present value. Dividends converted at pay date.
- FX gains/losses are part of (tax-free) capital movement for a private investor and are
  **not separately taxed**; they simply flow through the CHF valuation.

## 7. The after-tax computation (per position / basket)

Pseudocode of the drag applied on top of pre-tax figures:

```
grossDividends_CHF        = Σ dividend_i × fx(payDate_i)
swissWH                   = swissDividends × swissWithholdingRate
swissWH_reclaimed         = swissWithholdingReclaimed ? swissWH : 0        // returns as cash (delayed)
foreignWH                 = foreignDividends × foreignWithholding[domicile]
foreignWH_permanent       = foreignWH × (1 − foreignReclaimFraction[domicile])
incomeTax                 = grossDividends_CHF × marginalIncomeRate         // §2, on the gross income
netDividends_afterTax     = grossDividends_CHF
                            − incomeTax
                            − foreignWH_permanent
                            − (swissWithholdingReclaimed ? 0 : swissWH)
                            − reclaimTimeValueDrag?                          // optional §4

// ETF counterfactual income drag (§3), applied per year of the hold:
etfIncome_CHF             = etfMarketValue × etfIncomeYield
etfIncomeTax              = etfIncome_CHF × marginalIncomeRate               // taxed even if accumulating

wealthTax                 = meanMarketValue_CHF × wealthTaxRate × years      // §5, both sides

// Capital gains contribute ZERO tax on both sides (§1).
afterTaxValue             = marketValue_CHF + netDividends_afterTax − wealthTax
```

The **counterfactual delta** = `afterTaxValue(actual) − afterTaxValue(ETF)`, both computed
with the same tax settings so the comparison is apples-to-apples. Pre-tax variants drop the
income/wealth terms.

## 8. Defaults summary (Settings modal)

| Setting | Default | Meaning |
|---|---|---|
| `professionalTrader` | false | If true, capital gains would be taxable (flagged) |
| `capitalGainsTaxable` | false | Private investor: gains tax-free |
| `marginalIncomeRate` | 30% | Combined marginal income rate on dividends |
| `defaultEtfIncomeYield` | 1.8% | Fallback income yield for broad-world ETF tax drag |
| `swissWithholdingRate` | 35% | Verrechnungssteuer |
| `swissWithholdingReclaimed` | true | Reclaim in full |
| `reclaimDelayMonths` | 12 | Cash-flow delay of reclaim |
| `applyReclaimTimeValue` | false | Model time-value drag of delayed reclaim |
| `foreignWithholdingUS` | 15% | US treaty rate |
| `foreignReclaimFractionUS` | 1.0 | DA-1 recovery fraction |
| `foreignWithholdingGeneric` | 15% | Other domiciles |
| `foreignReclaimFractionGeneric` | 0.0 | Conservative: unrecovered |
| `wealthTaxRate` | 0.3% | Annual Vermögenssteuer |

All are editable; changing any recomputes every analysis live.

## 9. Explicit non-goals / caveats

- No stamp duty (Umsatzabgabe) modelling by default (`stampDutyRate` = 0; toggle exists;
  ~0.075%/0.15% CH/foreign per side) — second-order for this tool's thesis.
- No church tax, no AHV on capital income (not applicable to private capital income).
- Progressive bracketing is approximated by a single marginal rate; the advanced breakdown
  is a linear approximation, not a full progressive schedule.
- The ESTV *Kursliste* per-security taxable-income figure is not fetched; the income-yield
  estimate stands in for it. A manual per-instrument `incomeYieldOverride` is provided.

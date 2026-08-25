import type { TaxSettings } from '@decisionguru/shared';

export interface DividendTaxBreakdown {
  grossCHF: number;
  swissWithholdingCHF: number;
  foreignWithholdingCHF: number;
  incomeTaxCHF: number;
  /** permanent (non-reclaimable) withholding cost */
  permanentWithholdingCHF: number;
  netAfterTaxCHF: number;
}

/**
 * After-tax breakdown of a gross dividend (already in CHF) for a given issuer domicile.
 * See docs/TAX-MODEL.md §2–§4.
 */
export function dividendTax(
  grossCHF: number,
  domicile: string | null | undefined,
  tax: TaxSettings,
): DividendTaxBreakdown {
  const incomeTaxCHF = grossCHF * tax.marginalIncomeRate;
  const isSwiss = (domicile ?? '').toUpperCase() === 'CH';

  if (isSwiss) {
    const swissWH = grossCHF * tax.swissWithholdingRate;
    const permanent = tax.swissWithholdingReclaimed ? 0 : swissWH;
    return {
      grossCHF,
      swissWithholdingCHF: swissWH,
      foreignWithholdingCHF: 0,
      incomeTaxCHF,
      permanentWithholdingCHF: permanent,
      netAfterTaxCHF: grossCHF - incomeTaxCHF - permanent,
    };
  }

  const isUS = (domicile ?? '').toUpperCase() === 'US';
  const whRate = isUS ? tax.foreignWithholdingUS : tax.foreignWithholdingGeneric;
  const reclaimFrac = isUS ? tax.foreignReclaimFractionUS : tax.foreignReclaimFractionGeneric;
  const foreignWH = grossCHF * whRate;
  const permanent = foreignWH * (1 - reclaimFrac);
  return {
    grossCHF,
    swissWithholdingCHF: 0,
    foreignWithholdingCHF: foreignWH,
    incomeTaxCHF,
    permanentWithholdingCHF: permanent,
    netAfterTaxCHF: grossCHF - incomeTaxCHF - permanent,
  };
}

/** Wealth tax over a holding period (docs §5). meanValue in CHF, years fractional. */
export function wealthTax(meanValueCHF: number, years: number, tax: TaxSettings): number {
  if (meanValueCHF <= 0 || years <= 0) return 0;
  return meanValueCHF * tax.wealthTaxRate * years;
}

/**
 * After-tax income drag on an accumulating/distributing fund over `years`, applied to
 * mean market value (docs §3). This is owed even when nothing is distributed.
 */
export function fundIncomeTaxDrag(
  meanValueCHF: number,
  incomeYield: number,
  years: number,
  domicile: string | null | undefined,
  tax: TaxSettings,
): number {
  if (meanValueCHF <= 0 || years <= 0) return 0;
  const grossIncome = meanValueCHF * incomeYield * years;
  const bd = dividendTax(grossIncome, domicile, tax);
  return bd.incomeTaxCHF + bd.permanentWithholdingCHF;
}

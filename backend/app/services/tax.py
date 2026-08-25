"""Swiss private-investor tax model — port of tax.ts. See docs/TAX-MODEL.md."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class DividendTaxBreakdown:
    grossCHF: float
    swissWithholdingCHF: float
    foreignWithholdingCHF: float
    incomeTaxCHF: float
    permanentWithholdingCHF: float  # permanent (non-reclaimable) withholding cost
    netAfterTaxCHF: float


def dividend_tax(gross_chf: float, domicile: str | None, tax: dict) -> DividendTaxBreakdown:
    income_tax = gross_chf * tax["marginalIncomeRate"]
    is_swiss = (domicile or "").upper() == "CH"

    if is_swiss:
        swiss_wh = gross_chf * tax["swissWithholdingRate"]
        permanent = 0.0 if tax["swissWithholdingReclaimed"] else swiss_wh
        return DividendTaxBreakdown(
            grossCHF=gross_chf,
            swissWithholdingCHF=swiss_wh,
            foreignWithholdingCHF=0.0,
            incomeTaxCHF=income_tax,
            permanentWithholdingCHF=permanent,
            netAfterTaxCHF=gross_chf - income_tax - permanent,
        )

    is_us = (domicile or "").upper() == "US"
    wh_rate = tax["foreignWithholdingUS"] if is_us else tax["foreignWithholdingGeneric"]
    reclaim_frac = tax["foreignReclaimFractionUS"] if is_us else tax["foreignReclaimFractionGeneric"]
    foreign_wh = gross_chf * wh_rate
    permanent = foreign_wh * (1 - reclaim_frac)
    return DividendTaxBreakdown(
        grossCHF=gross_chf,
        swissWithholdingCHF=0.0,
        foreignWithholdingCHF=foreign_wh,
        incomeTaxCHF=income_tax,
        permanentWithholdingCHF=permanent,
        netAfterTaxCHF=gross_chf - income_tax - permanent,
    )


def wealth_tax(mean_value_chf: float, years: float, tax: dict) -> float:
    if mean_value_chf <= 0 or years <= 0:
        return 0.0
    return mean_value_chf * tax["wealthTaxRate"] * years


def fund_income_tax_drag(mean_value_chf: float, income_yield: float, years: float,
                        domicile: str | None, tax: dict) -> float:
    if mean_value_chf <= 0 or years <= 0:
        return 0.0
    gross_income = mean_value_chf * income_yield * years
    bd = dividend_tax(gross_income, domicile, tax)
    return bd.incomeTaxCHF + bd.permanentWithholdingCHF

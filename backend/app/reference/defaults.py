"""Default app settings — port of shared/src/defaults.ts (byte-compatible shapes)."""
from __future__ import annotations

DEFAULT_TAX_SETTINGS: dict = {
    "professionalTrader": False,
    "capitalGainsTaxable": False,
    "marginalIncomeRate": 0.3,
    "federalRate": None,
    "cantonalRate": None,
    "municipalMultiplier": None,
    "defaultEtfIncomeYield": 0.018,
    "swissWithholdingRate": 0.35,
    "swissWithholdingReclaimed": True,
    "reclaimDelayMonths": 12,
    "applyReclaimTimeValue": False,
    "foreignWithholdingUS": 0.15,
    "foreignReclaimFractionUS": 1.0,
    "foreignWithholdingGeneric": 0.15,
    "foreignReclaimFractionGeneric": 0.0,
    "wealthTaxRate": 0.003,
    "stampDutyRate": 0,
    "baseCurrency": "CHF",
}

DEFAULT_BENCHMARKS: list[dict] = [
    {"symbol": "VWRL.SW", "name": "Vanguard FTSE All-World (dist, CHF-listed)", "currency": "CHF", "domicile": "IE", "incomeYield": 0.019, "accumulating": False},
    {"symbol": "VT", "name": "Vanguard Total World Stock", "currency": "USD", "domicile": "US", "incomeYield": 0.02, "accumulating": False},
    {"symbol": "CSPX.L", "name": "iShares Core S&P 500 (acc, UCITS)", "currency": "USD", "domicile": "IE", "incomeYield": 0.013, "accumulating": True},
    {"symbol": "VWRA.L", "name": "Vanguard FTSE All-World (acc, UCITS)", "currency": "USD", "domicile": "IE", "incomeYield": 0.019, "accumulating": True},
    {"symbol": "SPY", "name": "SPDR S&P 500 ETF Trust", "currency": "USD", "domicile": "US", "incomeYield": 0.013, "accumulating": False},
]

# Value-investing knobs. Margin of safety and the discount rate are the two the owner
# is most likely to tune; the band multipliers define what counts as (significantly)
# overvalued. All are read by services/valuation.py so a change here (or via Settings)
# reshapes every fair-value band, entry target, sell signal and alert consistently.
DEFAULT_VALUATION_SETTINGS: dict = {
    "marginOfSafety": 0.30,          # buy target = fairValue × (1 − MoS)
    "discountRate": 0.09,            # WACC proxy for the owner-earnings DCF
    "terminalGrowth": 0.025,         # perpetual growth beyond the 10y horizon
    "overvaluedPremium": 0.20,       # price ≥ fairValue × 1.20  → overvalued
    "significantOvervaluedPremium": 0.40,  # price ≥ fairValue × 1.40 → sell zone
}

DEFAULT_SETTINGS: dict = {
    "tax": DEFAULT_TAX_SETTINGS,
    "benchmarks": DEFAULT_BENCHMARKS,
    "defaultBenchmarkSymbol": "VWRL.SW",
    "valuation": DEFAULT_VALUATION_SETTINGS,
}

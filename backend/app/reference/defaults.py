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

DEFAULT_SETTINGS: dict = {
    "tax": DEFAULT_TAX_SETTINGS,
    "benchmarks": DEFAULT_BENCHMARKS,
    "defaultBenchmarkSymbol": "VWRL.SW",
}

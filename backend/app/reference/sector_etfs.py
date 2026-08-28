"""Curated sector benchmark proxy — the US SPDR sector ETFs, keyed by the provider's
sector string. There is no sector-index data feed, so this maps a company's sector to a
real, fetchable sector ETF used as the sector benchmark; when a sector has no mapping the
caller falls back to the median of the identified peers (never a fabricated index).
"""
from __future__ import annotations

# yfinance `sector` strings → SPDR sector ETF. Aliases included for the few sectors the
# provider labels inconsistently across listings.
SECTOR_ETF: dict[str, str] = {
    "Healthcare": "XLV",
    "Technology": "XLK",
    "Information Technology": "XLK",
    "Financial Services": "XLF",
    "Financials": "XLF",
    "Energy": "XLE",
    "Consumer Defensive": "XLP",
    "Consumer Staples": "XLP",
    "Consumer Cyclical": "XLY",
    "Consumer Discretionary": "XLY",
    "Industrials": "XLI",
    "Basic Materials": "XLB",
    "Materials": "XLB",
    "Utilities": "XLU",
    "Real Estate": "XLRE",
    "Communication Services": "XLC",
}

# Real, fetchable broad benchmarks: US large cap + global all-world (CHF-listed).
BROAD_BENCHMARKS: list[tuple[str, str]] = [("sp500", "SPY"), ("world", "VWRL.SW")]


def sector_etf_for(sector: str | None) -> str | None:
    """The sector ETF for a provider sector string, or None when unmapped/missing."""
    return SECTOR_ETF.get(sector) if sector else None


# Symbols whose price history the market-analysis endpoint warms in the background so the
# sector/broad-benchmark lines fill in (deduped, stable order).
MARKET_ANALYSIS_SYMBOLS: list[str] = list(dict.fromkeys(
    [*SECTOR_ETF.values(), *(sym for _key, sym in BROAD_BENCHMARKS)]
))

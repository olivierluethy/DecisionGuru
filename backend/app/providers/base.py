"""MarketDataProvider interface — a second source can be swapped in without touching routers."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

# Exchanges quote some instruments in a currency's MINOR unit (1/100 of the major).
# Yahoo reports e.g. UK-listed ETFs in GBp (pence). Left unnormalised, FX(GBp→CHF)
# has no rate and degrades to 1.0 → the value inflates ~100×. Normalise to the major
# unit before any FX is applied. Idempotent: only fires for a known minor unit.
# Keyed on the exact, case-sensitive codes providers emit (GBp, not GBP) so a
# legitimate major-unit GBP/USD quote is never touched.
_MINOR_CODES: dict[str, tuple[str, float]] = {
    "GBp": ("GBP", 100.0),
    "GBX": ("GBP", 100.0),
    "ZAc": ("ZAR", 100.0),
    "ILA": ("ILS", 100.0),
}


def normalize_minor_currency(price: float, currency: str | None) -> tuple[float, str | None]:
    """Convert a minor-unit quote (e.g. 9120 GBp) to its major unit (91.20 GBP).

    Idempotent — a major-unit currency (GBP, USD…) passes through unchanged, so this
    is safe to apply at both the provider write path and every cached read."""
    if not currency:
        return price, currency
    hit = _MINOR_CODES.get(currency)
    if hit is None:
        return price, currency
    major, factor = hit
    return price / factor, major


@dataclass
class ChartResult:
    prices: list[dict] = field(default_factory=list)      # [{date: 'YYYY-MM-DD', close: float}]
    dividends: list[dict] = field(default_factory=list)   # [{date: 'YYYY-MM-DD', amount: float}]
    currency: str | None = None                           # listing currency (major unit, normalised)


@dataclass
class ProviderQuote:
    price: float
    currency: str
    name: str


@dataclass
class SearchHit:
    symbol: str
    name: str
    exchange: str | None = None
    kind: str = "stock"          # 'stock' | 'etf'
    type: str | None = None      # raw quoteType
    currency: str | None = None


class MarketDataProvider(ABC):
    """Normalises an upstream market-data source into clean, cache-ready structures."""

    @abstractmethod
    def chart(self, symbol: str, from_date: str) -> ChartResult: ...

    @abstractmethod
    def quote(self, symbol: str) -> ProviderQuote | None: ...

    @abstractmethod
    def fund_summary(self, symbol: str) -> dict | None: ...

    @abstractmethod
    def search(self, query: str) -> list[SearchHit]: ...

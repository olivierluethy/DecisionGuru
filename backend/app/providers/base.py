"""MarketDataProvider interface — a second source can be swapped in without touching routers."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class ChartResult:
    prices: list[dict] = field(default_factory=list)      # [{date: 'YYYY-MM-DD', close: float}]
    dividends: list[dict] = field(default_factory=list)   # [{date: 'YYYY-MM-DD', amount: float}]


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

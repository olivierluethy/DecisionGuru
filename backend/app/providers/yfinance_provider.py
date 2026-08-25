"""yfinance-backed MarketDataProvider ("wifiness" = yfinance).

Wraps every upstream call behind a serialising, rate-limit-aware gate with
min-spacing, retry-with-backoff and a soft timeout, mirroring the guarantees the
retired yahoo-finance2 layer provided.
"""
from __future__ import annotations

import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout

import pandas as pd
import yfinance as yf

from ..core.config import settings
from ..core.logging import get_logger
from .base import ChartResult, MarketDataProvider, ProviderQuote, SearchHit

log = get_logger("marketdata")

_RATE_LIMIT_RE = re.compile(r"too many requests|rate.?limit|429", re.IGNORECASE)


def _is_rate_limited(exc: Exception) -> bool:
    return bool(_RATE_LIMIT_RE.search(str(exc)))


class YFinanceProvider(MarketDataProvider):
    def __init__(self) -> None:
        self._gate = threading.Lock()
        self._last_call = 0.0
        self._timeout_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="yf")

    # ---- serialise + space out + retry-with-backoff + timeout ----
    def _call(self, label: str, fn):
        with self._gate:
            gap = (time.monotonic() - self._last_call) * 1000.0
            if gap < settings.yf_min_gap_ms:
                time.sleep((settings.yf_min_gap_ms - gap) / 1000.0)
            delay = 1.5
            last_exc: Exception | None = None
            for attempt in range(settings.yf_retries):
                try:
                    fut = self._timeout_pool.submit(fn)
                    out = fut.result(timeout=settings.yf_timeout_s)
                    self._last_call = time.monotonic()
                    return out
                except FutureTimeout as exc:
                    self._last_call = time.monotonic()
                    last_exc = exc
                    log.warning("%s timed out (attempt %d)", label, attempt + 1)
                    continue
                except Exception as exc:  # noqa: BLE001
                    self._last_call = time.monotonic()
                    last_exc = exc
                    if _is_rate_limited(exc) and attempt < settings.yf_retries - 1:
                        time.sleep(delay)
                        delay *= 2
                        continue
                    raise
            raise RuntimeError(f"[marketdata] {label} exhausted retries: {last_exc}")

    # ---- chart (price history + dividends) ----
    def chart(self, symbol: str, from_date: str) -> ChartResult:
        start = (pd.Timestamp(from_date) - pd.Timedelta(days=10)).strftime("%Y-%m-%d")

        def _fetch() -> pd.DataFrame:
            return yf.Ticker(symbol).history(
                start=start, interval="1d", auto_adjust=False, actions=True, raise_errors=False
            )

        df = self._call(f"chart {symbol}", _fetch)
        result = ChartResult()
        if df is None or df.empty:
            return result
        for idx, row in df.iterrows():
            date = pd.Timestamp(idx).strftime("%Y-%m-%d")
            close = row.get("Close")
            if close is not None and pd.notna(close):
                result.prices.append({"date": date, "close": float(close)})
            div = row.get("Dividends")
            if div is not None and pd.notna(div) and float(div) != 0.0:
                result.dividends.append({"date": date, "amount": float(div)})
        return result

    # ---- quote ----
    def quote(self, symbol: str) -> ProviderQuote | None:
        # Uses fast_info (price/currency) + history_metadata (name/currency) — both cheap.
        # Deliberately avoids the heavy .get_info() scrape, which can hang for tens of seconds.
        def _fetch():
            t = yf.Ticker(symbol)
            price = 0.0
            currency = "USD"
            name = symbol
            try:
                fi = t.fast_info
                price = float(getattr(fi, "last_price", None) or 0)
                currency = getattr(fi, "currency", None) or "USD"
            except Exception:  # noqa: BLE001
                pass
            md = {}
            try:
                md = t.history_metadata or {}
                if not md:
                    t.history(period="5d", auto_adjust=False)
                    md = t.history_metadata or {}
            except Exception:  # noqa: BLE001
                md = {}
            if isinstance(md, dict) and md:
                name = md.get("longName") or md.get("shortName") or symbol
                currency = md.get("currency") or currency
                if not price:
                    price = float(md.get("regularMarketPrice") or 0)
            return ProviderQuote(price=price, currency=currency or "USD", name=name or symbol)

        return self._call(f"quote {symbol}", _fetch)

    # ---- fund / instrument profile ----
    def fund_summary(self, symbol: str) -> dict | None:
        def _fetch() -> dict:
            t = yf.Ticker(symbol)
            info = {}
            try:
                info = t.get_info() or {}
            except Exception:  # noqa: BLE001
                info = {}

            top_holdings = None
            try:
                fd = t.funds_data
                holdings = []
                th = getattr(fd, "top_holdings", None)
                if th is not None and not th.empty:
                    for sym, row in th.iterrows():
                        holdings.append({
                            "symbol": str(sym),
                            "holdingName": row.get("Name") if hasattr(row, "get") else None,
                            "holdingPercent": float(row.get("Holding Percent") or 0)
                            if hasattr(row, "get") else 0.0,
                        })
                sector_w = getattr(fd, "sector_weightings", None) or {}
                sector_list = [{k: float(v)} for k, v in sector_w.items()]
                if holdings or sector_list:
                    top_holdings = {"holdings": holdings, "sectorWeightings": sector_list}
            except Exception:  # noqa: BLE001
                top_holdings = None

            profile = {
                "country": info.get("country"),
                "sector": info.get("sector"),
                "industry": info.get("industry"),
                "longBusinessSummary": info.get("longBusinessSummary"),
            }
            summary: dict = {
                "assetProfile": profile,
                "summaryProfile": profile,
                "price": {
                    "regularMarketPrice": info.get("regularMarketPrice"),
                    "currency": info.get("currency"),
                    "longName": info.get("longName") or info.get("shortName"),
                },
                "summaryDetail": {
                    "yield": info.get("yield"),
                    "dividendYield": info.get("dividendYield"),
                },
            }
            if top_holdings:
                summary["topHoldings"] = top_holdings
            return summary

        try:
            return self._call(f"fund_summary {symbol}", _fetch)
        except Exception as exc:  # noqa: BLE001
            log.warning("quoteSummary failed for %s: %s", symbol, exc)
            return None

    # ---- search ----
    def search(self, query: str) -> list[SearchHit]:
        if not query or not query.strip():
            return []

        def _fetch() -> list[SearchHit]:
            res = yf.Search(query, max_results=10, news_count=0, enable_fuzzy_query=False)
            hits: list[SearchHit] = []
            for q in (res.quotes or []):
                sym = q.get("symbol")
                if not sym:
                    continue
                qt = (q.get("quoteType") or "").upper()
                hits.append(SearchHit(
                    symbol=sym,
                    name=q.get("longname") or q.get("shortname") or sym,
                    exchange=q.get("exchange"),
                    kind="etf" if qt == "ETF" else "stock",
                    type=q.get("quoteType"),
                    currency=q.get("currency"),
                ))
            return hits

        try:
            return self._call(f"search {query}", _fetch)
        except Exception as exc:  # noqa: BLE001
            log.warning("search failed for %s: %s", query, exc)
            return []


provider: MarketDataProvider = YFinanceProvider()

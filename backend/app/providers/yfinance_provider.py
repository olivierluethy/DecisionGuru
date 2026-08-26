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
from .base import (
    ChartResult,
    MarketDataProvider,
    ProviderQuote,
    SearchHit,
    normalize_minor_currency,
)

log = get_logger("marketdata")

_RATE_LIMIT_RE = re.compile(r"too many requests|rate.?limit|429", re.IGNORECASE)


def _is_rate_limited(exc: Exception) -> bool:
    return bool(_RATE_LIMIT_RE.search(str(exc)))


class YFinanceProvider(MarketDataProvider):
    def __init__(self) -> None:
        # Bounded concurrency instead of a single global lock: up to yf_concurrency
        # upstream calls run at once, so a portfolio refresh fans out in parallel
        # instead of serializing ~39 symbols behind a 700ms gap.
        self._gate = threading.Semaphore(settings.yf_concurrency)
        self._last_call = 0.0
        self._timeout_pool = ThreadPoolExecutor(
            max_workers=settings.yf_concurrency, thread_name_prefix="yf"
        )

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

        def _fetch() -> tuple[pd.DataFrame, str | None]:
            t = yf.Ticker(symbol)
            df = t.history(
                start=start, interval="1d", auto_adjust=False, actions=True, raise_errors=False
            )
            ccy = None
            try:
                md = t.history_metadata or {}
                ccy = md.get("currency") if isinstance(md, dict) else None
            except Exception:  # noqa: BLE001
                ccy = None
            return df, ccy

        df, raw_ccy = self._call(f"chart {symbol}", _fetch)
        result = ChartResult()
        if df is None or df.empty:
            return result
        # Listing currency drives minor-unit (GBp→GBP) normalisation of every close.
        _, major_ccy = normalize_minor_currency(1.0, raw_ccy)
        result.currency = major_ccy or raw_ccy
        for idx, row in df.iterrows():
            date = pd.Timestamp(idx).strftime("%Y-%m-%d")
            close = row.get("Close")
            if close is not None and pd.notna(close):
                px, _ = normalize_minor_currency(float(close), raw_ccy)
                result.prices.append({"date": date, "close": px})
            div = row.get("Dividends")
            if div is not None and pd.notna(div) and float(div) != 0.0:
                amt, _ = normalize_minor_currency(float(div), raw_ccy)
                result.dividends.append({"date": date, "amount": amt})
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
            # Normalise minor units (GBp→GBP ÷100) so downstream FX is applied once.
            price, currency = normalize_minor_currency(price, currency)
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

    # ---- fundamentals ----
    def fundamentals(self, symbol: str) -> dict | None:
        """Valuation, profitability and a multi-year income statement for a company.
        Uses the heavy get_info() scrape + income_stmt — expensive, so callers cache it."""
        def _fetch() -> dict:
            import math as _m

            t = yf.Ticker(symbol)
            info = {}
            try:
                info = t.get_info() or {}
            except Exception:  # noqa: BLE001
                info = {}

            def num(*keys):
                for k in keys:
                    v = info.get(k)
                    if isinstance(v, (int, float)) and not (isinstance(v, float) and _m.isnan(v)):
                        return float(v)
                return None

            snapshot = {
                "name": info.get("longName") or info.get("shortName") or symbol,
                "currency": info.get("currency") or info.get("financialCurrency"),
                "sector": info.get("sector"),
                "industry": info.get("industry"),
                "country": info.get("country"),
                "exchange": info.get("exchange"),
                "marketCap": num("marketCap"),
                "enterpriseValue": num("enterpriseValue"),
                "trailingPE": num("trailingPE"),
                "forwardPE": num("forwardPE"),
                "pegRatio": num("pegRatio", "trailingPegRatio"),
                "priceToBook": num("priceToBook"),
                "priceToSales": num("priceToSalesTrailing12Months"),
                "trailingEps": num("trailingEps"),
                "forwardEps": num("forwardEps"),
                "dividendYield": num("dividendYield"),
                "payoutRatio": num("payoutRatio"),
                "grossMargins": num("grossMargins"),
                "operatingMargins": num("operatingMargins"),
                "profitMargins": num("profitMargins"),
                "ebitdaMargins": num("ebitdaMargins"),
                "returnOnEquity": num("returnOnEquity"),
                "returnOnAssets": num("returnOnAssets"),
                "revenueGrowth": num("revenueGrowth"),
                "earningsGrowth": num("earningsGrowth", "earningsQuarterlyGrowth"),
                "totalRevenue": num("totalRevenue"),
                "ebitda": num("ebitda"),
                "netIncome": num("netIncomeToCommon"),
                "totalCash": num("totalCash"),
                "totalDebt": num("totalDebt"),
                "beta": num("beta"),
                "fiftyTwoWeekHigh": num("fiftyTwoWeekHigh"),
                "fiftyTwoWeekLow": num("fiftyTwoWeekLow"),
                "sharesOutstanding": num("sharesOutstanding"),
                "recommendationKey": info.get("recommendationKey"),
                "targetMeanPrice": num("targetMeanPrice"),
                "numberOfAnalystOpinions": num("numberOfAnalystOpinions"),
                "longBusinessSummary": info.get("longBusinessSummary"),
            }

            history: list[dict] = []
            try:
                fin = t.income_stmt
                if fin is not None and not fin.empty:
                    def row(label):
                        return fin.loc[label] if label in fin.index else None
                    rev_r, ni_r = row("Total Revenue"), row("Net Income")
                    gp_r, oi_r = row("Gross Profit"), row("Operating Income")

                    def cell(r, col):
                        try:
                            v = r[col] if r is not None else None
                            if v is None or (isinstance(v, float) and _m.isnan(v)):
                                return None
                            return float(v)
                        except Exception:  # noqa: BLE001
                            return None

                    for col in fin.columns:
                        yr = getattr(col, "year", None)
                        if yr is None:
                            continue
                        rev, ni = cell(rev_r, col), cell(ni_r, col)
                        gp, oi = cell(gp_r, col), cell(oi_r, col)
                        ok = lambda a: rev not in (None, 0) and a is not None  # noqa: E731
                        history.append({
                            "year": int(yr),
                            "revenue": rev, "netIncome": ni, "grossProfit": gp, "operatingIncome": oi,
                            "netMargin": (ni / rev) if ok(ni) else None,
                            "grossMargin": (gp / rev) if ok(gp) else None,
                            "operatingMargin": (oi / rev) if ok(oi) else None,
                        })
                    history.sort(key=lambda h: h["year"])
            except Exception:  # noqa: BLE001
                history = []

            return {
                "snapshot": snapshot,
                "history": history,
                "financialCurrency": info.get("financialCurrency") or info.get("currency"),
            }

        try:
            return self._call(f"fundamentals {symbol}", _fetch)
        except Exception as exc:  # noqa: BLE001
            log.warning("fundamentals failed for %s: %s", symbol, exc)
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

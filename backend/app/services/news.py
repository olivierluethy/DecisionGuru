"""Per-ticker news headlines from the Yahoo Finance RSS feed.

No API key, no yfinance news path (which is rate-limit-prone). Fetches the public RSS
headline feed over httpx, parses it with the stdlib XML parser, upserts into `news_cache`
keyed by a stable hash of the article link (so re-fetching de-duplicates), and serves
cached rows stale-while-revalidate. Never raises to the caller — on any upstream failure
the last cached headlines are returned.
"""
from __future__ import annotations

import hashlib
import time as _time
from email.utils import parsedate_to_datetime
from xml.etree import ElementTree as ET

import httpx

from ..core.config import settings
from ..core.db import q
from ..core.logging import get_logger

log = get_logger("news")

_RSS_URL = "https://feeds.finance.yahoo.com/rss/2.0/headline"
_UA = "Mozilla/5.0 (compatible; DecisionGuru/1.0; +local)"


def _now_ms() -> int:
    return int(_time.time() * 1000)


def _link_id(link: str, title: str) -> str:
    return hashlib.md5((link or title).encode("utf-8")).hexdigest()


def _parse_pubdate(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        return parsedate_to_datetime(raw).astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
    except Exception:  # noqa: BLE001
        return raw


def _fetch_rss(symbol: str) -> list[dict]:
    params = {"s": symbol, "region": "US", "lang": "en-US"}
    with httpx.Client(timeout=8.0, headers={"User-Agent": _UA}) as client:
        resp = client.get(_RSS_URL, params=params)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
    items = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        if not title:
            continue
        items.append({
            "id": _link_id(link, title),
            "symbol": symbol,
            "title": title,
            "publisher": (item.findtext("source") or item.findtext("{http://purl.org/dc/elements/1.1/}creator") or "Yahoo Finance").strip() or None,
            "link": link or None,
            "publishedAt": _parse_pubdate(item.findtext("pubDate")),
            "summary": (item.findtext("description") or "").strip() or None,
        })
    return items


def _cached(symbol: str, limit: int) -> list[dict]:
    rows = q(
        "SELECT id, symbol, title, publisher, link, publishedAt, summary FROM news_cache "
        "WHERE symbol = ? ORDER BY publishedAt DESC NULLS LAST, fetchedAt DESC LIMIT ?"
    ).all((symbol, limit))
    return [dict(r) for r in rows]


def _newest_fetch_ms(symbol: str) -> int:
    row = q("SELECT MAX(fetchedAt) AS m FROM news_cache WHERE symbol = ?").get((symbol,))
    return int(row["m"]) if row and row["m"] is not None else 0


def _upsert(items: list[dict]) -> None:
    now = _now_ms()
    for it in items:
        q(
            "INSERT INTO news_cache (id, symbol, title, publisher, link, publishedAt, summary, fetchedAt) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET title=excluded.title, publisher=excluded.publisher, "
            "link=excluded.link, publishedAt=excluded.publishedAt, summary=excluded.summary, "
            "fetchedAt=excluded.fetchedAt"
        ).run((it["id"], it["symbol"], it["title"], it["publisher"], it["link"],
               it["publishedAt"], it["summary"], now))


def get_news(symbol: str, limit: int = 12, force: bool = False) -> dict:
    """Return `{symbol, items, stale, fetchedAt}` — cached-first, refreshed past TTL."""
    if not symbol:
        return {"symbol": symbol, "items": [], "stale": False, "fetchedAt": None}
    age_ms = _now_ms() - _newest_fetch_ms(symbol)
    fresh = age_ms < settings.cache_ttl_news * 1000
    if fresh and not force:
        return {"symbol": symbol, "items": _cached(symbol, limit), "stale": False,
                "fetchedAt": _newest_fetch_ms(symbol) or None}
    try:
        items = _fetch_rss(symbol)
        if items:
            _upsert(items)
        return {"symbol": symbol, "items": _cached(symbol, limit), "stale": False,
                "fetchedAt": _newest_fetch_ms(symbol) or None}
    except Exception as exc:  # noqa: BLE001 — never fail the request on a news fetch
        log.info("news fetch failed for %s: %s", symbol, exc)
        return {"symbol": symbol, "items": _cached(symbol, limit), "stale": True,
                "fetchedAt": _newest_fetch_ms(symbol) or None}

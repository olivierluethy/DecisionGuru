"""TTL cache layer to absorb yfinance rate limits and speed up repeat queries.

Default is an in-process `cachetools.TTLCache`; when `DG_REDIS_URL` is set the same
interface is served by Redis. This sits in front of the persistent SQLite caches: it
short-circuits repeat lookups within the process without changing staleness semantics.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any

from cachetools import TTLCache

from .config import settings
from .logging import get_logger

log = get_logger("cache")


class _MemoryCache:
    def __init__(self) -> None:
        # generous ceiling; entries expire by TTL anyway
        self._store: TTLCache = TTLCache(maxsize=10_000, ttl=settings.cache_ttl_history)
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        with self._lock:
            item = self._store.get(key)
        if item is None:
            return None
        expires_at, value = item
        if expires_at and expires_at < time.time():
            return None
        return value

    def set(self, key: str, value: Any, ttl: int) -> None:
        with self._lock:
            self._store[key] = (time.time() + ttl, value)


class _RedisCache:
    def __init__(self, url: str) -> None:
        import redis  # imported lazily; optional dependency

        self._r = redis.Redis.from_url(url)

    def get(self, key: str) -> Any | None:
        raw = self._r.get(key)
        return json.loads(raw) if raw else None

    def set(self, key: str, value: Any, ttl: int) -> None:
        self._r.set(key, json.dumps(value), ex=ttl)


def _make_cache():
    if settings.redis_url:
        try:
            log.info("using Redis cache at %s", settings.redis_url)
            return _RedisCache(settings.redis_url)
        except Exception as exc:  # pragma: no cover - optional path
            log.warning("Redis unavailable (%s); falling back to in-process cache", exc)
    return _MemoryCache()


cache = _make_cache()

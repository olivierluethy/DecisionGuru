"""Bounded background refresh pool for market data.

The portfolio critical path never blocks on Yahoo. Instead, stale or missing
quotes/history are enqueued here and fetched by a small worker pool while the
request returns immediately from the SQLite cache (stale-while-revalidate).

Single-worker gunicorn (`-w 1`) makes the in-process pool + in-flight set correct.
The `db` module is thread-safe (shared connection under an RLock), so worker writes
are safe.
"""
from __future__ import annotations

import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from ..core.config import settings
from ..core.logging import get_logger

log = get_logger("refresh")

_pool = ThreadPoolExecutor(
    max_workers=settings.yf_concurrency, thread_name_prefix="refresh"
)
_inflight: set[str] = set()
_lock = threading.Lock()


def _run(job_id: str, fn: Callable[[], None]) -> None:
    try:
        fn()
    except Exception as exc:  # noqa: BLE001
        log.warning("refresh %s failed: %s", job_id, exc)
    finally:
        with _lock:
            _inflight.discard(job_id)


def _submit(job_id: str, fn: Callable[[], None]) -> None:
    with _lock:
        if job_id in _inflight:
            return
        _inflight.add(job_id)
    try:
        _pool.submit(_run, job_id, fn)
    except RuntimeError:  # pool shutting down
        with _lock:
            _inflight.discard(job_id)


def enqueue_quote(symbol: str, fn: Callable[[], None]) -> None:
    _submit(f"quote:{symbol}", fn)


def enqueue_history(symbol: str, fn: Callable[[], None]) -> None:
    _submit(f"history:{symbol}", fn)


def is_quote_pending(symbol: str) -> bool:
    with _lock:
        return f"quote:{symbol}" in _inflight


def refresh_in_progress() -> bool:
    with _lock:
        return bool(_inflight)

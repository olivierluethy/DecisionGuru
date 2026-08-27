"""Universe fundamentals warmer — makes the screener evaluate the *whole* universe, not
just names that happened to be cached.

The screener scores off cached fundamentals (cache = performance optimisation). This
warmer fills that cache for the entire screening universe in a controlled way:

  - only fetches names that are **missing or stale** (fresh-cached names are skipped, so
    there are no redundant upstream requests — `get_fundamentals` also enforces a 7-day
    TTL as a second guard);
  - runs on a **small worker pool**, and every upstream call still passes through the
    provider's serialising gate (bounded concurrency + min-gap spacing + retry-with-backoff
    on HTTP 429), so a broad warm degrades gracefully instead of tripping the rate limit;
  - is **resumable and idempotent** — one warm runs at a time; a second trigger no-ops and
    returns the live progress; a killed process just leaves the already-cached names cached;
  - reports **progress** so the UI can show "N/M fundamentals loaded" and refresh results as
    the universe fills.

Names the provider can't return (delisted, rate-limited this pass) are counted as failed
and simply retried on a later warm — they're never fabricated.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor

from ..core.config import settings
from ..core.db import set_state, get_state
from ..core.logging import get_logger
from ..core.timefmt import iso_now
from . import repo
from .watchlist import list_watchlist
from .fundamentals import get_fundamentals, get_cached_fundamentals
from ..reference.universe import UNIVERSE_SEED

log = get_logger("screener_warm")

# Fundamentals use the heavy get_info() scrape, so keep the fan-out modest even though the
# provider gate would bound it anyway — 3 in flight keeps the rate limit comfortable.
WARM_WORKERS = min(3, settings.yf_concurrency)

_lock = threading.Lock()
_running = False
_state: dict = {
    "running": False, "total": 0, "done": 0, "ok": 0, "failed": 0,
    "startedAt": None, "finishedAt": None, "lastSymbol": None, "trigger": None,
}
_state_lock = threading.Lock()


def universe_symbols() -> list[str]:
    holdings = [i["symbol"] for i in repo.list_instruments() if i.get("symbol")]
    watch = [w["symbol"] for w in list_watchlist() if w.get("symbol")]
    return list(dict.fromkeys([*UNIVERSE_SEED, *holdings, *watch]))


def _has_snapshot(sym: str) -> bool:
    cached = get_cached_fundamentals(sym)
    return bool(cached and cached.get("snapshot"))


def coverage() -> dict:
    syms = universe_symbols()
    cached = sum(1 for s in syms if _has_snapshot(s))
    return {"universeTotal": len(syms), "cached": cached, "missing": len(syms) - cached}


def _publish() -> None:
    with _state_lock:
        snap = dict(_state)
    set_state("screener.warm", snap)


def status() -> dict:
    with _state_lock:
        snap = dict(_state)
    snap.update(coverage())
    snap["workers"] = WARM_WORKERS
    return snap


def is_running() -> bool:
    with _lock:
        return _running


def _run(targets: list[str], trigger: str) -> None:
    global _running
    with _state_lock:
        _state.update({
            "running": True, "total": len(targets), "done": 0, "ok": 0, "failed": 0,
            "startedAt": iso_now(), "finishedAt": None, "lastSymbol": None, "trigger": trigger,
        })
    _publish()
    log.info("warm(%s): fetching %s missing fundamentals across the universe", trigger, len(targets))

    def one(sym: str) -> None:
        try:
            data = get_fundamentals(sym)  # cache-first; fetches + caches only if missing/stale
            good = bool(data and data.get("snapshot"))
        except Exception:  # noqa: BLE001 — a single bad name must not stop the warm
            good = False
        with _state_lock:
            _state["done"] += 1
            _state["ok" if good else "failed"] += 1
            _state["lastSymbol"] = sym
            snap = dict(_state)
        set_state("screener.warm", snap)

    try:
        with ThreadPoolExecutor(max_workers=WARM_WORKERS, thread_name_prefix="screenwarm") as ex:
            list(ex.map(one, targets))
    finally:
        with _state_lock:
            _state["running"] = False
            _state["finishedAt"] = iso_now()
        _publish()
        with _lock:
            _running = False
        with _state_lock:
            done, ok, failed = _state["done"], _state["ok"], _state["failed"]
        log.info("warm(%s) done: %s fetched, %s ok, %s failed", trigger, done, ok, failed)


def start_warm(limit: int | None = None, trigger: str = "manual") -> dict:
    """Kick a background warm of the missing part of the universe. `limit` caps how many
    names this run fetches (None = all missing). No-ops if a warm is already running."""
    global _running
    with _lock:
        if _running:
            return {**status(), "started": False, "reason": "already running"}
        targets = [s for s in universe_symbols() if not _has_snapshot(s)]
        if limit is not None:
            targets = targets[:limit]
        if not targets:
            return {**status(), "started": False, "reason": "universe already fully cached"}
        _running = True
    threading.Thread(target=_run, args=(targets, trigger), name="screener-warm", daemon=True).start()
    return {**status(), "started": True, "queued": len(targets)}


def warm_blocking_batch(limit: int, trigger: str = "scan") -> int:
    """Warm up to `limit` missing names inline (used by the 6-hourly scan so the universe
    fills over time even with no manual action). Returns how many it attempted. Skips when a
    manual warm is already running."""
    global _running
    with _lock:
        if _running:
            return 0
        targets = [s for s in universe_symbols() if not _has_snapshot(s)][:limit]
        if not targets:
            return 0
        _running = True
    try:
        _run(targets, trigger)
    finally:
        pass
    return len(targets)

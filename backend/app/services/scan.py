"""The continuous opportunity scan.

Runs on a 6-hour cadence (and on demand). Each pass, entirely off cached data so it never
hammers the rate-limited provider:

  1. maintains fair-value **auto alerts** — a BUY alert at the attractive entry price for
     every watchlist name, and a SELL alert at the sell zone for every open holding;
  2. **evaluates** all active alerts against the latest cached quote, firing notifications
     on a crossing;
  3. re-runs the **screener** and surfaces names that have *newly* become attractive since
     the previous scan into the notification feed as opportunities;
  4. records the run (time + summary) so the UI can show "last scanned N ago".
"""
from __future__ import annotations

import threading
import time

from ..core.db import get_settings, get_state, set_state, q
from ..core.logging import get_logger
from . import alerts as alerts_svc
from .watchlist import list_watchlist
from .screener import screen_universe
from .fundamentals import get_cached_fundamentals

log = get_logger("scan")

SCAN_INTERVAL_SECONDS = 6 * 60 * 60  # every 6 hours
_started = False
_lock = threading.Lock()


def _held_symbols() -> list[str]:
    """Symbols with a positive open quantity — from transactions only (no network)."""
    rows = q(
        "SELECT i.symbol AS symbol, "
        "SUM(CASE t.action WHEN 'buy' THEN t.quantity WHEN 'sell' THEN -t.quantity ELSE 0 END) AS qty "
        "FROM transactions t JOIN instruments i ON i.id = t.instrumentId "
        "GROUP BY i.symbol HAVING qty > 1e-9"
    ).all()
    return [r["symbol"] for r in rows if r["symbol"]]


def _sync_auto_alerts(settings: dict) -> dict:
    """Ensure a fair-value buy alert per watchlist name and a sell alert per holding, but
    only where the name has cached fundamentals (so a target can be computed)."""
    created = 0
    for w in list_watchlist():
        sym = w.get("symbol")
        if sym and get_cached_fundamentals(sym):
            a = alerts_svc.create_alert(sym, "buy", settings, name=w.get("name"), auto=True)
            if a:
                created += 1
    for sym in _held_symbols():
        if get_cached_fundamentals(sym):
            alerts_svc.create_alert(sym, "sell", settings, auto=True)
    return {"autoAlerts": created}


def _detect_new_opportunities(settings: dict) -> dict:
    """Screen the universe and notify on names that turned attractive since last scan."""
    try:
        result = screen_universe(settings)
    except Exception as exc:  # noqa: BLE001 — a scan must never crash on a screen hiccup
        log.warning("screen failed during scan: %s", exc)
        return {"attractive": 0, "new": 0}

    attractive = {r["symbol"]: r for r in result.get("rows", []) if r.get("verdict") == "attractive"}
    prev = set(get_state("scan.attractive") or [])
    fresh = [s for s in attractive if s not in prev]

    for sym in fresh:
        r = attractive[sym]
        mos = r.get("marginOfSafety")
        mos_txt = f"{mos*100:.0f}% below fair value" if mos is not None else "below fair value"
        alerts_svc.add_notification(
            "opportunity",
            title=f"New opportunity: {r.get('name') or sym}",
            body=(f"{sym} screens as attractive — {mos_txt}, quality "
                  f"{(r.get('quality') or {}).get('score','?')}/"
                  f"{(r.get('quality') or {}).get('max','?')}, "
                  f"attractiveness {r.get('attractiveness')}/100."),
            symbol=sym,
            payload={"marginOfSafety": mos, "attractiveness": r.get("attractiveness"),
                     "entryTarget": r.get("entryTarget"), "sector": r.get("sector"),
                     "inPortfolio": r.get("inPortfolio")},
        )

    set_state("scan.attractive", list(attractive.keys()))
    return {"attractive": len(attractive), "new": len(fresh),
            "newSymbols": fresh, "analysed": result.get("analysedCount", 0)}


def run_scan(trigger: str = "manual") -> dict:
    """One full scan pass. Serialised so a manual trigger can't overlap the timer."""
    with _lock:
        started = time.time()
        settings = get_settings()
        auto = _sync_auto_alerts(settings)
        fired = alerts_svc.evaluate_alerts()
        opps = _detect_new_opportunities(settings)
        summary = {
            "trigger": trigger,
            "finishedAt": _now_iso(),
            "durationMs": int((time.time() - started) * 1000),
            "alertsFired": len(fired),
            "firedSymbols": [f["symbol"] for f in fired],
            **auto,
            **opps,
        }
        set_state("scan.last", summary)
        log.info("scan(%s): %s alerts fired, %s new opportunities",
                 trigger, summary["alertsFired"], opps.get("new", 0))
        return summary


def last_scan() -> dict | None:
    return get_state("scan.last")


def _now_iso() -> str:
    from ..core.timefmt import iso_now
    return iso_now()


# ---- scheduler --------------------------------------------------------------

def _loop() -> None:
    # A short initial delay lets the app finish starting before the first pass.
    time.sleep(20)
    while True:
        try:
            run_scan(trigger="scheduled")
        except Exception as exc:  # noqa: BLE001 — keep the scheduler alive across failures
            log.warning("scheduled scan failed: %s", exc)
        time.sleep(SCAN_INTERVAL_SECONDS)


def start_scheduler() -> None:
    """Start the 6-hourly background scan once per process."""
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, name="opportunity-scan", daemon=True).start()
    log.info("opportunity scan scheduler started (every %sh)", SCAN_INTERVAL_SECONDS // 3600)

"""The continuous opportunity scan.

Runs on a 6-hour cadence (and on demand). Each pass, entirely off cached data so it never
hammers the rate-limited provider:

  1. maintains fair-value **auto alerts** — a BUY alert at the attractive entry price for
     every watchlist name, and a SELL alert at the sell zone for every open holding;
  2. **evaluates** all active alerts against the latest cached quote, firing notifications
     on a crossing;
  3. re-runs the **screener** and surfaces names that have *newly* become attractive since
     the previous scan into the notification feed as opportunities;
  3b. races each holding against its market and warns when a rival is about to overtake it;
  4. records the run (time + summary) so the UI can show "last scanned N ago".
"""
from __future__ import annotations

import threading
import time

from ..core.db import get_settings, get_state, set_state, q
from ..core.logging import get_logger
from . import alerts as alerts_svc
from . import screener_warm
from .watchlist import list_watchlist
from .screener import screen_universe
from .fundamentals import get_cached_fundamentals
from .rivalry import rivalry_alert_candidates

# Fundamentals to warm per scan, so the screening universe fills over successive scans
# without a single large burst against the rate-limited provider.
SCAN_WARM_BATCH = 40

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
    """Screen the universe, then diff against the previous scan's snapshot to compute the
    'freshly attractive / mover' signals for **not-yet-owned** names, persist a new
    snapshot, and notify on names that just turned attractive."""
    try:
        result = screen_universe(settings)
    except Exception as exc:  # noqa: BLE001 — a scan must never crash on a screen hiccup
        log.warning("screen failed during scan: %s", exc)
        return {"attractive": 0, "new": 0}

    rows = result.get("rows", [])
    now = _now_iso()
    prev_snapshot = get_state("scan.snapshot") or {}
    became = dict(get_state("scan.became_attractive") or {})

    movers: dict[str, dict] = {}
    snapshot: dict[str, dict] = {}
    fresh: list[str] = []

    for r in rows:
        sym = r["symbol"]
        price = r.get("price")
        attractive_now = r.get("verdict") == "buy-more"
        owned = bool(r.get("inPortfolio"))
        snapshot[sym] = {"price": price, "attractive": attractive_now, "owned": owned}

        prev = prev_snapshot.get(sym) or {}
        prev_attractive = bool(prev.get("attractive"))
        prev_price = prev.get("price")

        # Track when each name (re)entered the attractive band.
        if attractive_now:
            became.setdefault(sym, now)
        else:
            became.pop(sym, None)

        # Movers only make sense for names you don't already own.
        if owned:
            continue
        price_change = round(price / prev_price - 1, 4) if (price and prev_price and prev_price > 0) else None
        is_new = attractive_now and not prev_attractive
        # Keep an entry when it's attractive (so becameAttractiveAt/isNew are available)
        # or when there's a notable price drop worth surfacing as a mover.
        if attractive_now or (price_change is not None and price_change <= -0.03):
            movers[sym] = {
                "isNew": is_new,
                "priceChangePct": price_change,
                "becameAttractiveAt": became.get(sym),
            }
        if is_new:
            fresh.append(sym)
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
                         "theme": r.get("theme"), "inPortfolio": owned},
            )

    set_state("scan.snapshot", snapshot)
    set_state("scan.became_attractive", became)
    set_state("scan.movers", movers)

    attractive_not_owned = sum(1 for r in rows if r.get("verdict") == "buy-more" and not r.get("inPortfolio"))
    return {"attractive": attractive_not_owned, "new": len(fresh),
            "newSymbols": fresh, "analysed": result.get("analysedCount", 0)}


def _rivalry_watch(settings: dict) -> dict:
    """Warn when a competitor is about to overtake a holding you own.

    Fires at most once per rival and per stage. Without that, a rival that stays 80 days out
    would re-announce itself every six hours until the reader stopped reading alerts at all —
    so what is remembered is the STAGE ('ahead', or the crossover bucketed to a fortnight),
    and a notification goes out only when that stage changes.
    """
    fired = 0
    try:
        candidates = rivalry_alert_candidates(settings)
    except Exception as exc:  # noqa: BLE001 — the race must never break the scan
        log.warning("rivalry watch failed: %s", exc)
        return {"rivalryAlerts": 0}

    for c in candidates:
        threat = c["threat"]
        days = threat.get("daysToCrossover")
        stage = "ahead" if threat["aheadOfYou"] else f"in-{(days // 14) if days is not None else '?'}"
        key = f"rivalry.{c['symbol']}.{threat['symbol']}"
        if get_state(key) == stage:
            continue
        set_state(key, stage)

        cheaper = threat["verdict"].endswith("cheaper")
        if threat["aheadOfYou"]:
            headline = f"{threat['symbol']} has overtaken {c['symbol']}"
            when = "It is now ahead of your holding since the day you bought."
        else:
            headline = f"{threat['symbol']} is closing on {c['symbol']}"
            when = (f"On the current trend it overtakes your holding in about {days} days "
                    f"({threat.get('crossoverDate')}).")
        months = (threat.get("switch") or {}).get("monthsToRecoverFee")
        cost = (f" Switching would take about {months} months to earn back its trading fees."
                if months is not None else "")
        value = (" It also trades further below its own fair value than your holding does."
                 if cheaper else
                 " But it is priced higher against its own fair value than your holding — "
                 "momentum without the valuation behind it.")

        alerts_svc.add_notification(
            "rivalry",
            title=headline,
            body=f"{when}{value}{cost}",
            symbol=c["symbol"],
            payload={"instrumentId": c["instrumentId"], "rival": threat["symbol"],
                     "gap": threat["gap"], "daysToCrossover": days,
                     "crossoverDate": threat.get("crossoverDate"),
                     "verdict": threat["verdict"],
                     "closingSpeedPerYear": threat.get("closingSpeedPerYear")},
        )
        fired += 1
    return {"rivalryAlerts": fired}


def run_scan(trigger: str = "manual") -> dict:
    """One full scan pass. Serialised so a manual trigger can't overlap the timer."""
    with _lock:
        started = time.time()
        settings = get_settings()
        # Fill a batch of the universe's missing fundamentals first, so each scan makes the
        # screener cover more of the universe (throttled + resumable inside the warmer).
        warmed = 0
        try:
            warmed = screener_warm.warm_blocking_batch(SCAN_WARM_BATCH, "scan")
        except Exception as exc:  # noqa: BLE001 — warming must never break the scan
            log.warning("scan warm batch failed: %s", exc)
        auto = _sync_auto_alerts(settings)
        fired = alerts_svc.evaluate_alerts()
        opps = _detect_new_opportunities(settings)
        rivalry = _rivalry_watch(settings)
        summary = {
            "trigger": trigger,
            "finishedAt": _now_iso(),
            "durationMs": int((time.time() - started) * 1000),
            "warmedFundamentals": warmed,
            "alertsFired": len(fired),
            "firedSymbols": [f["symbol"] for f in fired],
            **auto,
            **opps,
            **rivalry,
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

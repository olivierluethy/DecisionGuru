"""Price alerts + the notification feed.

Alerts are grounded in fair value, not round-number price targets: a BUY alert's default
target is the attractive entry price (fairValue × (1 − margin of safety)); a SELL alert's
default target is the sell zone (fairValue × 1.40). Each alert carries the valuation
reasoning that set it. `evaluate_alerts()` checks active alerts against the latest cached
quote and, on a crossing, marks the alert triggered and drops a notification into the feed.

Everything reads cached quotes/fundamentals — no forced provider calls — so it is safe to
run on the 6-hour background scan without hammering the rate-limited data source.
"""
from __future__ import annotations

import json

from ..core.db import execute, q
from .valuation import value_analysis
from .fundamentals import get_cached_fundamentals
from .marketdata import get_quote


# ---- fair-value targets -----------------------------------------------------

def _valuation(symbol: str, settings: dict) -> dict | None:
    cached = get_cached_fundamentals(symbol)
    if not cached or not (cached.get("snapshot")):
        return None
    quote = get_quote(symbol) or {}
    va = value_analysis(symbol, quote.get("price"), quote.get("currency"),
                        data=cached, settings=settings)
    return va if va.get("band") else None


def default_target(symbol: str, kind: str, settings: dict) -> tuple[float | None, dict | None, str | None]:
    """(targetPrice, reasoning, currency) for a fair-value-driven alert, or (None, None, ccy)
    when the symbol has no cached fundamentals to value it against yet."""
    va = _valuation(symbol, settings)
    if not va:
        q0 = get_quote(symbol) or {}
        return None, None, q0.get("currency")
    band = va["band"]
    if kind == "buy":
        target = band["entryTarget"]
        reasoning = {
            "basis": "Attractive entry price = fair value × (1 − margin of safety).",
            "fairValue": band["fairValue"],
            "marginOfSafety": band["marginOfSafetyPct"],
            "entryTarget": band["entryTarget"],
            "currentBand": band["label"],
        }
    else:  # sell
        target = band["sellZoneAt"]
        reasoning = {
            "basis": "Sell zone = fair value × 1.40 (significantly overvalued).",
            "fairValue": band["fairValue"],
            "sellZoneAt": band["sellZoneAt"],
            "currentBand": band["label"],
        }
    return target, reasoning, va.get("currency")


# ---- CRUD -------------------------------------------------------------------

def _row(r) -> dict:
    d = dict(r)
    if d.get("reasoning"):
        try:
            d["reasoning"] = json.loads(d["reasoning"])
        except Exception:
            pass
    d["auto"] = bool(d.get("auto"))
    return d


def list_alerts(status: str | None = None) -> list[dict]:
    if status:
        rows = q("SELECT * FROM alerts WHERE status = ? ORDER BY createdAt DESC").all((status,))
    else:
        rows = q("SELECT * FROM alerts ORDER BY "
                 "CASE status WHEN 'triggered' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, "
                 "createdAt DESC").all()
    return [_row(r) for r in rows]


def create_alert(symbol: str, kind: str, settings: dict, *, target: float | None = None,
                 name: str | None = None, auto: bool = False) -> dict:
    symbol = (symbol or "").strip()
    kind = "sell" if kind == "sell" else "buy"
    direction = "above" if kind == "sell" else "below"
    reasoning = None
    computed_target, computed_reason, ccy = default_target(symbol, kind, settings)
    if target is None:
        target = computed_target
    reasoning = computed_reason
    if auto:
        # Auto alerts are unique per (symbol, kind): upsert so the scan just refreshes them.
        execute(
            "INSERT INTO alerts (symbol, name, kind, direction, targetPrice, currency, auto, reasoning) "
            "VALUES (?, ?, ?, ?, ?, ?, 1, ?) "
            "ON CONFLICT(symbol, kind) WHERE auto = 1 DO UPDATE SET "
            "targetPrice = excluded.targetPrice, reasoning = excluded.reasoning, "
            "currency = excluded.currency, updatedAt = datetime('now'), "
            "status = CASE WHEN alerts.status = 'triggered' THEN 'active' ELSE alerts.status END",
            (symbol, name, kind, direction, target, ccy,
             json.dumps(reasoning) if reasoning else None),
        )
        row = q("SELECT * FROM alerts WHERE symbol = ? AND kind = ? AND auto = 1").get((symbol, kind))
    else:
        cur = execute(
            "INSERT INTO alerts (symbol, name, kind, direction, targetPrice, currency, auto, reasoning) "
            "VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
            (symbol, name, kind, direction, target, ccy,
             json.dumps(reasoning) if reasoning else None),
        )
        row = q("SELECT * FROM alerts WHERE id = ?").get((cur.lastrowid,))
    return _row(row) if row else {}


def delete_alert(alert_id: int) -> bool:
    return execute("DELETE FROM alerts WHERE id = ?", (alert_id,)).rowcount > 0


def dismiss_alert(alert_id: int) -> bool:
    return execute(
        "UPDATE alerts SET status = 'dismissed', updatedAt = datetime('now') WHERE id = ?",
        (alert_id,),
    ).rowcount > 0


# ---- evaluation -------------------------------------------------------------

def evaluate_alerts() -> list[dict]:
    """Check every active alert against its latest cached price. On a crossing, mark it
    triggered and push a notification. Returns the alerts that fired this pass."""
    fired: list[dict] = []
    for a in list_alerts(status="active"):
        target = a.get("targetPrice")
        if target is None:
            continue
        quote = get_quote(a["symbol"]) or {}
        price = quote.get("price")
        if price is None:
            continue
        execute("UPDATE alerts SET lastPrice = ?, updatedAt = datetime('now') WHERE id = ?",
                (price, a["id"]))
        crossed = (a["direction"] == "below" and price <= target) or \
                  (a["direction"] == "above" and price >= target)
        if not crossed:
            continue
        execute(
            "UPDATE alerts SET status = 'triggered', triggeredPrice = ?, "
            "triggeredAt = datetime('now'), updatedAt = datetime('now') WHERE id = ?",
            (price, a["id"]),
        )
        verb = "reached its attractive entry price" if a["kind"] == "buy" else "entered its sell zone"
        add_notification(
            "alert",
            title=f"{a['symbol']} {verb}",
            body=(f"{a['symbol']} is {price:,.2f} {a.get('currency') or ''} vs the "
                  f"{'buy' if a['kind']=='buy' else 'sell'} target {target:,.2f}."),
            symbol=a["symbol"],
            payload={"alertId": a["id"], "kind": a["kind"], "price": price,
                     "target": target, "reasoning": a.get("reasoning")},
        )
        fired.append({**a, "triggeredPrice": price, "status": "triggered"})
    return fired


# ---- notifications feed -----------------------------------------------------

def add_notification(ntype: str, title: str, body: str | None = None,
                     symbol: str | None = None, payload: dict | None = None) -> None:
    execute(
        "INSERT INTO notifications (type, title, body, symbol, payload) VALUES (?, ?, ?, ?, ?)",
        (ntype, title, body, symbol, json.dumps(payload) if payload else None),
    )


def _notif_row(r) -> dict:
    d = dict(r)
    if d.get("payload"):
        try:
            d["payload"] = json.loads(d["payload"])
        except Exception:
            pass
    d["read"] = bool(d.get("readAt"))
    return d


def list_notifications(limit: int = 50) -> list[dict]:
    rows = q("SELECT * FROM notifications ORDER BY createdAt DESC LIMIT ?").all((limit,))
    return [_notif_row(r) for r in rows]


def unread_count() -> int:
    row = q("SELECT COUNT(*) AS n FROM notifications WHERE readAt IS NULL").get()
    return int(row["n"]) if row else 0


def mark_read(notification_id: int | None = None) -> None:
    if notification_id is None:
        execute("UPDATE notifications SET readAt = datetime('now') WHERE readAt IS NULL")
    else:
        execute("UPDATE notifications SET readAt = datetime('now') WHERE id = ?", (notification_id,))

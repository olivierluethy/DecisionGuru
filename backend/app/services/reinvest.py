"""Reinvestment check — should the NEXT franc go into the stock you already own?

A Hold or Buy-more verdict quietly invites topping up the name you are already attached to.
That verdict answers "is this worth owning", which is not the same question as "is this the
best home for new money in this market right now". This module asks the second question, in
the three dimensions that can each independently make the answer no:

1. **Position in its market today.** Reuses the value x strength ranking from
   ``market_position`` — the stock may be a fine hold and still sit behind two competitors
   that are both cheaper and growing faster.
2. **What topping up does to concentration.** Adding to what you hold raises its portfolio
   weight; putting the same money into a peer of the same market keeps the market exposure
   and lowers single-name risk. The weight after the purchase is computed both ways and
   checked against the app's existing concentration threshold.
3. **What that money would have done.** The same amount, over 1/3/5 years, in your stock and
   in each peer, from cached closes. Backward-looking, and labelled as such.

It also answers the timing question the issue raises — *what would I have if I had bought when
it was actually worth buying?* Past **buy-zone windows** (price at or below the value engine's
entry target) are reconstructed from the cached price history and each is priced against your
own cost basis, so the gap is money, not a percentage. The cheapest single day in the window
is reported alongside as the honest ceiling: nobody could have done better than that.

Caveat carried through to the UI, the same one the point-in-time replay already states: the
entry target comes from TODAY's fundamentals, so a reconstructed buy zone is what we now know
was cheap, not what was visible at the time.

Everything reads caches and already-computed services; no new provider traffic.
"""
from __future__ import annotations

import pandas as pd

from . import account as acct
from . import repo
from .exposure import portfolio_exposure
from .finance import build_position
from .market_analysis import cached_closes, market_analysis
from .marketdata import latest_cached_close
from .valuation import value_analysis

# Mirrors recommend.CONCENTRATION_WEIGHT — a single holding above this share of the book is
# worth flagging. Kept as its own constant so a change here is a deliberate decision.
CONCENTRATION_WEIGHT = 0.25

# Horizons the "what would this money have done" comparison reports.
LOOKBACK_YEARS = (1, 3, 5)

# How far back buy-zone windows are searched.
BUY_ZONE_YEARS = 5

# A buy-zone window shorter than this is noise — a single close dipping under the target.
MIN_ZONE_DAYS = 3

# Fallback amount when there is no idle cash to suggest — a round number to think in, which
# the reader overrides in the UI anyway.
DEFAULT_AMOUNT_CHF = 5000.0


def _weighted_entry(txs: list[dict]) -> tuple[float | None, str | None]:
    """Cost-weighted average buy price and the matching average date.

    Weighting the DATE by cost too is what makes "your entry" a single comparable point: a
    small early lot should not drag the date the way a plain mean of dates would.
    """
    buys = [t for t in txs
            if t.get("action") == "buy" and t.get("category") != "corporate_action"
            and (t.get("quantity") or 0) > 0 and (t.get("unitPrice") or 0) > 0]
    if not buys:
        return None, None
    total_cost = sum((t["quantity"] * t["unitPrice"]) for t in buys)
    total_qty = sum(t["quantity"] for t in buys)
    if total_qty <= 0 or total_cost <= 0:
        return None, None
    avg_price = total_cost / total_qty
    ordinal = sum(pd.Timestamp(t["date"]).value * (t["quantity"] * t["unitPrice"]) for t in buys)
    avg_date = pd.Timestamp(int(ordinal / total_cost)).strftime("%Y-%m-%d")
    return avg_price, avg_date


def _value_today(amount: float, entry_price: float | None, last_price: float | None) -> float | None:
    """What `amount` invested at `entry_price` would be worth at `last_price`.

    A price ratio, so the listing currency cancels and a CHF amount can be carried through a
    USD-quoted security. The trade-off is that an FX move between the two dates is NOT
    reflected — stated in the payload's `note` rather than silently absorbed. Price return
    only: no dividends, no tax, no fees.
    """
    if not entry_price or entry_price <= 0 or not last_price or last_price <= 0:
        return None
    return round(amount * (last_price / entry_price), 2)


def _buy_zone_windows(rows: list[dict], entry_target: float, amount: float,
                      last_close: float) -> list[dict]:
    """Contiguous stretches where the close sat at or below the entry target.

    Each window is priced at its LOWEST close — the best that stretch could have given —
    rather than its first, so the figure is not an artefact of where the window happens to
    start.
    """
    windows: list[dict] = []
    current: list[dict] = []

    def flush() -> None:
        if len(current) < MIN_ZONE_DAYS:
            current.clear()
            return
        low = min(current, key=lambda r: r["close"])
        windows.append({
            "start": current[0]["date"],
            "end": current[-1]["date"],
            "days": len(current),
            "lowClose": round(low["close"], 4),
            "lowDate": low["date"],
            "valueTodayCHF": _value_today(amount, low["close"], last_close),
        })
        current.clear()

    for r in rows:
        if r["close"] <= entry_target:
            current.append(r)
        else:
            flush()
    flush()

    # Most recent first — the last chance missed is the one worth looking at.
    windows.sort(key=lambda w: w["start"], reverse=True)
    return windows


def reinvest_check(instrument_id: int, amount_chf: float | None = None,
                   settings: dict | None = None, range_key: str = "1Y") -> dict:
    """Assemble the three cross-sectional dimensions plus the missed-entry read."""
    settings = settings or {}
    inst = repo.get_instrument(instrument_id)
    if not inst:
        return {"available": False, "reason": "instrument not found"}

    symbol = inst.get("symbol")
    txs = repo.get_transactions(instrument_id)
    pos = build_position(inst, txs, settings.get("tax") or {})["position"]

    if not symbol or pos["openQuantity"] <= 0:
        return {"instrumentId": instrument_id, "symbol": symbol, "available": False,
                "reason": "this position is closed — there is nothing to top up"}

    # Amount: default to what is actually sitting idle, so the figures are about real money.
    idle_cash = 0.0
    try:
        events = repo.all_account_events()
        idle_cash = acct.cash_chf(events, pd.Timestamp.utcnow().strftime("%Y-%m-%d"))["totalCHF"]
    except Exception:  # noqa: BLE001 — a missing ledger must not break the check
        idle_cash = 0.0
    amount = amount_chf if (amount_chf and amount_chf > 0) else (
        round(idle_cash, 2) if idle_cash >= 100 else DEFAULT_AMOUNT_CHF)

    # --- 1. where this stock stands in its market today ---------------------------------
    market = market_analysis(symbol, range_key, settings)
    position_read = market.get("marketPosition")
    peers = [c for c in (market.get("competitors") or []) if not c.get("isSubject")]

    # --- 2. what topping up does to concentration ---------------------------------------
    concentration = None
    try:
        exposure = portfolio_exposure(settings)
        total = exposure.get("totalValueCHF") or 0.0
        value = pos.get("currentValueCHF") or 0.0
        if total > 0 and value > 0:
            after_top_up = (value + amount) / (total + amount)
            # Buying the peer instead grows the book without growing this position, so this
            # name's weight FALLS — the same money, the opposite effect on single-name risk.
            after_peer = value / (total + amount)
            concentration = {
                "portfolioValueCHF": round(total, 2),
                "positionValueCHF": round(value, 2),
                "currentWeight": round(value / total, 4),
                "weightAfterTopUp": round(after_top_up, 4),
                "weightAfterPeerBuy": round(after_peer, 4),
                "threshold": CONCENTRATION_WEIGHT,
                "crossesThreshold": after_top_up > CONCENTRATION_WEIGHT >= (value / total),
                "aboveThreshold": after_top_up > CONCENTRATION_WEIGHT,
            }
    except Exception:  # noqa: BLE001 — exposure is a nice-to-have, not a precondition
        concentration = None

    # --- 3. what the money would have done, here vs. in each peer ------------------------
    def _history_value(sym: str) -> dict[str, float | None]:
        out: dict[str, float | None] = {}
        rows = cached_closes(sym, _years_ago(max(LOOKBACK_YEARS)))
        if len(rows) < 2:
            return {f"{y}Y": None for y in LOOKBACK_YEARS}
        last = rows[-1]["close"]
        for y in LOOKBACK_YEARS:
            target = _years_ago(y)
            if target < rows[0]["date"]:
                out[f"{y}Y"] = None
                continue
            start = next((r for r in reversed(rows) if r["date"] <= target), None)
            out[f"{y}Y"] = _value_today(amount, start["close"] if start else None, last)
        return out

    subject_history = _history_value(symbol)
    peer_history = [{
        "symbol": p["symbol"], "name": p.get("name"),
        "currency": p.get("currency"),
        "valuePct": p.get("valuePct"), "strengthPct": p.get("strengthPct"), "rank": p.get("rank"),
        "wouldBeWorth": _history_value(p["symbol"]),
    } for p in peers]

    # --- the missed-entry read ----------------------------------------------------------
    missed = _missed_entry(symbol, inst, txs, pos, amount, settings)

    stronger = (position_read or {}).get("strongerAlternatives") or []
    if position_read and position_read.get("rank") == 1:
        verdict = "best-in-market"
    elif stronger:
        verdict = "peers-better-positioned"
    elif position_read:
        verdict = "mid-field"
    else:
        verdict = "unranked"

    return {
        "instrumentId": instrument_id,
        "symbol": symbol,
        "name": inst.get("name"),
        "currency": inst.get("currency"),
        "available": True,
        "amountCHF": amount,
        "idleCashCHF": round(idle_cash, 2),
        "amountSource": "idle-cash" if (not amount_chf and idle_cash >= 100) else (
            "requested" if amount_chf else "default"),
        "horizon": market.get("range", range_key),
        "marketPosition": position_read,
        "strongerAlternatives": stronger,
        "concentration": concentration,
        "wouldBeWorth": {"subject": subject_history, "peers": peer_history,
                         "years": list(LOOKBACK_YEARS)},
        "missedEntry": missed,
        "verdict": verdict,
    }


def _years_ago(years: int) -> str:
    return (pd.Timestamp.utcnow().normalize() - pd.DateOffset(years=years)).strftime("%Y-%m-%d")


def _missed_entry(symbol: str, inst: dict, txs: list[dict], pos: dict, amount: float,
                  settings: dict | None) -> dict:
    """Past buy-zone windows priced against the reader's own cost basis."""
    ccy = inst.get("currency")
    close = latest_cached_close(symbol)
    last_close = close["close"] if close else None

    your_price, your_date = _weighted_entry(txs)
    if your_price is None:
        your_price = pos.get("avgCost") or None
        your_date = pos.get("firstBuyDate")
    your_value = _value_today(amount, your_price, last_close)

    entry_target = None
    try:
        va = value_analysis(symbol, last_close, ccy, None, settings)
        entry_target = va.get("entryTarget")
    except Exception:  # noqa: BLE001
        entry_target = None

    rows = cached_closes(symbol, _years_ago(BUY_ZONE_YEARS))
    best_day = None
    if rows and last_close:
        low = min(rows, key=lambda r: r["close"])
        best_day = {
            "date": low["date"],
            "price": round(low["close"], 4),
            "valueTodayCHF": _value_today(amount, low["close"], last_close),
        }

    windows: list[dict] = []
    if entry_target and rows and last_close:
        windows = _buy_zone_windows(rows, entry_target, amount, last_close)

    def _extra(v: float | None) -> float | None:
        if v is None or your_value is None:
            return None
        return round(v - your_value, 2)

    for w in windows:
        w["extraVsYoursCHF"] = _extra(w.get("valueTodayCHF"))
    if best_day:
        best_day["extraVsYoursCHF"] = _extra(best_day.get("valueTodayCHF"))

    # The window that would have paid most — the headline "you were this close" figure.
    best_window = max((w for w in windows if w.get("valueTodayCHF") is not None),
                      key=lambda w: w["valueTodayCHF"], default=None)

    return {
        "available": bool(last_close and your_price),
        "currency": ccy,
        "lastClose": round(last_close, 4) if last_close else None,
        "entryTarget": round(entry_target, 4) if entry_target else None,
        "entryTargetAvailable": entry_target is not None,
        "lookbackYears": BUY_ZONE_YEARS,
        "yourEntry": {
            "price": round(your_price, 4) if your_price else None,
            "date": your_date,
            "valueTodayCHF": your_value,
            "investedCHF": round(pos.get("investedCHF") or 0.0, 2),
        },
        "windows": windows,
        "bestWindow": best_window,
        "bestDay": best_day,
        # Repeated in the payload so no consumer can render the numbers without it.
        "note": ("Buy zones are reconstructed from today's fundamentals, so they show what we "
                 "now know was cheap — not what was visible at the time. Price return only: "
                 "no dividends, tax or fees, and no FX move between then and now (the CHF "
                 "amount is carried at the security's own price ratio)."),
    }

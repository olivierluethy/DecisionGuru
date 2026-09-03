"""Competitor watch — who in this market is closing on the company you hold?

A holding can look fine on its own and still be quietly losing a race. This module runs that
race explicitly, from the only starting line that matters to the reader: **the day they
actually bought**.

    gap(t) = peer(t)/peer(entry)  −  yours(t)/yours(entry)

A negative gap means you are ahead. What earns an alert is a rival that is still behind but
*catching up* — gap below zero and rising — because that is the moment there is still a
decision to make. Once it has overtaken, the news is old.

Three numbers come out of it:

* **Speed.** The slope of the gap over the last ~90 trading days, by least squares rather
  than a two-point comparison, which would hang on a single outlier day.
* **The crossover.** The slope's zero crossing: `-gap / slope` days out. When the gap is not
  closing there is no crossing, and this reports None instead of inventing a date.
* **What switching costs and returns.** Swiss private investors owe no capital-gains tax, so
  the whole price of a switch is trading fees — and the annualised gap tells you how long the
  performance difference needs to pay them back.

Against all of that sits the value read, because momentum alone would push a reader into
exactly the expensive laggard that Market position warns about: a rival closing the gap while
trading further above its own fair value is a different proposition from one closing it while
cheaper. The verdict names which of the two it is.

Everything reads caches; the projection is an extrapolation and is labelled as one.
"""
from __future__ import annotations

import pandas as pd

from . import repo
from .competitors import competitors
from .finance import build_position
from .fundamentals import get_cached_fundamentals
from .market_analysis import cached_closes
from .market_position import margin_of_safety
from .reinvest import _weighted_entry

# Trading days the closing speed is measured over. A quarter is long enough to survive a bad
# week and short enough to still be about now.
SPEED_WINDOW = 90

# Minimum overlapping history since the entry date before a rival is raced at all.
MIN_HISTORY = 30

# A rival is "closing" only once the gap narrows by more than this per year — below it the
# slope is indistinguishable from noise.
MIN_CLOSING_SPEED = 0.02

# The alert fires once a projected crossover falls inside this horizon.
ALERT_HORIZON_DAYS = 120

# Rivals reported, nearest first.
MAX_RIVALS = 5

# Assumed round-trip trading cost when the settings carry none — named in the payload so it
# is never mistaken for a measured figure.
DEFAULT_ROUND_TRIP_FEE_CHF = 30.0


def _series_since(symbol: str, start: str) -> dict[str, float]:
    return {r["date"]: r["close"] for r in cached_closes(symbol, start)}


def _slope_per_day(dates: list[str], values: list[float]) -> float | None:
    """Least-squares slope of `values` over the trailing window, per calendar day.

    Regression rather than (last - first) / days: a single spike on either endpoint would
    otherwise set the speed, and the speed is what the crossover date is divided by.
    """
    n = len(values)
    if n < 10:
        return None
    xs = [(pd.Timestamp(d) - pd.Timestamp(dates[0])).days for d in dates]
    mean_x = sum(xs) / n
    mean_y = sum(values) / n
    denom = sum((x - mean_x) ** 2 for x in xs)
    if denom <= 0:
        return None
    return sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, values)) / denom


def _race(subject: dict[str, float], peer: dict[str, float]) -> dict | None:
    """The gap curve for one rival, plus its speed and projected crossing."""
    dates = sorted(set(subject) & set(peer))
    if len(dates) < MIN_HISTORY:
        return None
    s0, p0 = subject[dates[0]], peer[dates[0]]
    if s0 <= 0 or p0 <= 0:
        return None

    gap = [peer[d] / p0 - subject[d] / s0 for d in dates]
    window = dates[-SPEED_WINDOW:]
    slope = _slope_per_day(window, gap[-len(window):])
    current = gap[-1]

    # Positive slope = the rival is gaining. Annualised so it reads as a return difference.
    speed_per_year = round(slope * 365, 6) if slope is not None else None

    days_to_crossover = None
    if current < 0 and slope is not None and slope > 0:
        days_to_crossover = int(round(-current / slope))

    return {
        "from": dates[0],
        "to": dates[-1],
        "days": len(dates),
        "gap": round(current, 6),
        "aheadOfYou": current > 0,
        "closingSpeedPerYear": speed_per_year,
        "closing": speed_per_year is not None and speed_per_year > MIN_CLOSING_SPEED,
        # A rival that is ahead but losing ground is a receding one, not a threat.
        "receding": speed_per_year is not None and speed_per_year < -MIN_CLOSING_SPEED,
        "daysToCrossover": days_to_crossover,
        "crossoverDate": (
            (pd.Timestamp.utcnow().normalize() + pd.Timedelta(days=days_to_crossover)).strftime("%Y-%m-%d")
            if days_to_crossover is not None else None
        ),
    }


def _verdict(closing: bool, ahead: bool, mos_peer: float | None, mos_subject: float | None) -> str:
    """Where a rival sits once momentum is weighed against valuation."""
    cheaper = (mos_peer is not None and mos_subject is not None and mos_peer > mos_subject)
    if ahead:
        return "already-ahead-and-cheaper" if cheaper else "already-ahead-but-pricier"
    if closing:
        return "closing-and-cheaper" if cheaper else "closing-but-pricier"
    return "behind"


def _threat_group(r: dict) -> int:
    """0 = ahead and still gaining, 1 = behind but closing, 2 = ahead yet receding, 3 = behind."""
    if r["aheadOfYou"]:
        return 0 if not r["receding"] else 2
    return 1 if r["closing"] else 3


def _switch_maths(position_value_chf: float, speed_per_year: float | None,
                  fee_chf: float) -> dict:
    """What a switch costs and how long the performance difference needs to repay it."""
    annual_gain = (position_value_chf * speed_per_year) if (speed_per_year and speed_per_year > 0) else None
    months = None
    if annual_gain and annual_gain > 0:
        months = round(fee_chf / annual_gain * 12, 1)
    return {
        "positionValueCHF": round(position_value_chf, 2),
        "roundTripFeeCHF": round(fee_chf, 2),
        "feeIsAssumed": True,
        "annualDifferenceCHF": round(annual_gain, 2) if annual_gain is not None else None,
        "monthsToRecoverFee": months,
        # Stated rather than implied: in the app's tax model a private investor's capital
        # gain is untaxed, so fees really are the whole price of switching.
        "note": ("Swiss private investors pay no capital-gains tax, so the cost of switching "
                 "is the trading fees — not a tax bill. The annual difference simply carries "
                 "the current closing speed forward and is not a forecast."),
    }


def rivalry_check(instrument_id: int, settings: dict | None = None) -> dict:
    """Race every comparable company against this holding, from the reader's entry date."""
    settings = settings or {}
    inst = repo.get_instrument(instrument_id)
    if not inst or not inst.get("symbol"):
        return {"available": False, "reason": "instrument not found"}

    symbol = inst["symbol"]
    txs = repo.get_transactions(instrument_id)
    pos = build_position(inst, txs, settings.get("tax") or {})["position"]
    if pos["openQuantity"] <= 0:
        return {"instrumentId": instrument_id, "symbol": symbol, "available": False,
                "reason": "this position is closed — there is no race to run"}

    _price, entry_date = _weighted_entry(txs)
    entry_date = entry_date or pos.get("firstBuyDate")
    if not entry_date:
        return {"instrumentId": instrument_id, "symbol": symbol, "available": False,
                "reason": "no purchase date to race from"}

    subject_series = _series_since(symbol, entry_date)
    if len(subject_series) < MIN_HISTORY:
        return {"instrumentId": instrument_id, "symbol": symbol, "available": False,
                "reason": "not enough cached price history since your purchase yet"}

    comp = competitors(symbol)
    peers = [p for p in (comp.get("peers") or []) if p.get("symbol") and p["symbol"] != symbol]

    subj_snap = (get_cached_fundamentals(symbol) or {}).get("snapshot") or {}
    mos_subject = margin_of_safety(symbol, subj_snap, settings)

    fee = float((settings.get("trading") or {}).get("roundTripFeeCHF")
                or DEFAULT_ROUND_TRIP_FEE_CHF)
    position_value = pos.get("currentValueCHF") or 0.0

    rivals: list[dict] = []
    for p in peers:
        race = _race(subject_series, _series_since(p["symbol"], entry_date))
        if race is None:
            continue
        snap = (get_cached_fundamentals(p["symbol"]) or {}).get("snapshot") or {}
        mos_peer = margin_of_safety(p["symbol"], snap, settings)
        rivals.append({
            "symbol": p["symbol"], "name": p.get("name"), "currency": p.get("currency"),
            **race,
            "marginOfSafety": mos_peer,
            "verdict": _verdict(race["closing"], race["aheadOfYou"], mos_peer, mos_subject),
            "switch": _switch_maths(position_value, race["closingSpeedPerYear"], fee),
        })

    for r in rivals:
        r["threatGroup"] = _threat_group(r)
    # Urgency, not merely position: a rival that is ahead AND still gaining outranks one that
    # is ahead but falling back, which is no threat at all however far ahead it sits.
    rivals.sort(key=lambda r: (
        r["threatGroup"],
        r["daysToCrossover"] if r["daysToCrossover"] is not None else 10 ** 6,
        -(r["closingSpeedPerYear"] or 0),
    ))

    threat = next((r for r in rivals if r["threatGroup"] <= 1), None)

    return {
        "instrumentId": instrument_id,
        "symbol": symbol,
        "name": inst.get("name"),
        "available": True,
        "entryDate": entry_date,
        "positionValueCHF": round(position_value, 2),
        "marginOfSafety": mos_subject,
        "speedWindowDays": SPEED_WINDOW,
        "alertHorizonDays": ALERT_HORIZON_DAYS,
        "rivals": rivals[:MAX_RIVALS],
        "nearestThreat": threat,
        "note": ("The race starts on your cost-weighted purchase date and runs on price only "
                 "— no dividends, tax, fees or FX. The crossover is a straight-line "
                 "extrapolation of the last "
                 f"{SPEED_WINDOW} trading days, not a forecast."),
    }


def rivalry_alert_candidates(settings: dict | None = None) -> list[dict]:
    """Holdings whose nearest rival crosses inside the alert horizon.

    Used by the background scan. Returns one entry per holding worth telling the reader
    about — a rival that has just gone ahead, or one projected to within the horizon.
    """
    out: list[dict] = []
    for inst in repo.list_instruments():
        try:
            result = rivalry_check(inst["id"], settings)
        except Exception:  # noqa: BLE001 — one unraceable holding must not stop the scan
            continue
        if not result.get("available"):
            continue
        threat = result.get("nearestThreat")
        if not threat:
            continue
        days = threat.get("daysToCrossover")
        if threat["threatGroup"] == 0 or (days is not None and days <= ALERT_HORIZON_DAYS):
            out.append({"instrumentId": inst["id"], "symbol": result["symbol"],
                        "name": result.get("name"), "threat": threat,
                        "marginOfSafety": result.get("marginOfSafety")})
    return out

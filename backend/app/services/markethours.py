"""Exchange market hours & live open/closed status.

Pure stdlib (`zoneinfo`) — no market-calendar dependency. Regular cash-session hours per
exchange in local time; status is computed against the exchange's own timezone. Public
holidays are *not* modelled (weekends are), so a status on a holiday reads "open" — the UI
labels this as regular-session hours, not a trading calendar.
"""
from __future__ import annotations

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

# Canonical exchanges keyed by the Yahoo symbol suffix ("" = bare = US).
# hours are (open, close) in local exchange time, 24h.
EXCHANGES: dict[str, dict] = {
    "": {"code": "US", "name": "US (NYSE/Nasdaq)", "tz": "America/New_York",
         "open": time(9, 30), "close": time(16, 0), "country": "US"},
    "SW": {"code": "SIX", "name": "SIX Swiss Exchange", "tz": "Europe/Zurich",
           "open": time(9, 0), "close": time(17, 30), "country": "CH"},
    "VX": {"code": "SIX", "name": "SIX Swiss Exchange", "tz": "Europe/Zurich",
           "open": time(9, 0), "close": time(17, 30), "country": "CH"},
    "L": {"code": "LSE", "name": "London Stock Exchange", "tz": "Europe/London",
          "open": time(8, 0), "close": time(16, 30), "country": "GB"},
    "DE": {"code": "XETRA", "name": "Deutsche Börse Xetra", "tz": "Europe/Berlin",
           "open": time(9, 0), "close": time(17, 30), "country": "DE"},
    "F": {"code": "FRA", "name": "Frankfurt Börse", "tz": "Europe/Berlin",
          "open": time(8, 0), "close": time(20, 0), "country": "DE"},
    "PA": {"code": "EPA", "name": "Euronext Paris", "tz": "Europe/Paris",
           "open": time(9, 0), "close": time(17, 30), "country": "FR"},
    "AS": {"code": "AMS", "name": "Euronext Amsterdam", "tz": "Europe/Amsterdam",
           "open": time(9, 0), "close": time(17, 30), "country": "NL"},
    "MI": {"code": "MIL", "name": "Borsa Italiana", "tz": "Europe/Rome",
           "open": time(9, 0), "close": time(17, 30), "country": "IT"},
    "MC": {"code": "BME", "name": "Bolsa de Madrid", "tz": "Europe/Madrid",
           "open": time(9, 0), "close": time(17, 30), "country": "ES"},
    "T": {"code": "TSE", "name": "Tokyo Stock Exchange", "tz": "Asia/Tokyo",
          "open": time(9, 0), "close": time(15, 0), "country": "JP"},
    "HK": {"code": "HKEX", "name": "Hong Kong Exchange", "tz": "Asia/Hong_Kong",
           "open": time(9, 30), "close": time(16, 0), "country": "HK"},
    "TO": {"code": "TSX", "name": "Toronto Stock Exchange", "tz": "America/Toronto",
           "open": time(9, 30), "close": time(16, 0), "country": "CA"},
    "AX": {"code": "ASX", "name": "Australian Securities Exchange", "tz": "Australia/Sydney",
           "open": time(10, 0), "close": time(16, 0), "country": "AU"},
    "ST": {"code": "OMX", "name": "Nasdaq Stockholm", "tz": "Europe/Stockholm",
           "open": time(9, 0), "close": time(17, 30), "country": "SE"},
}

# The exchanges shown in the portfolio's market-hours strip, in display order.
PRIMARY_EXCHANGES = ["SW", "", "L", "DE"]


def exchange_for_symbol(symbol: str) -> str:
    """Return the EXCHANGES key for a Yahoo symbol ("" for a bare US ticker)."""
    parts = (symbol or "").split(".")
    if len(parts) > 1:
        suffix = parts[-1].upper()
        if suffix in EXCHANGES:
            return suffix
    return ""


def _status_for(meta: dict, now_utc: datetime) -> dict:
    tz = ZoneInfo(meta["tz"])
    local = now_utc.astimezone(tz)
    weekday = local.weekday()  # 0=Mon .. 6=Sun
    is_weekday = weekday < 5
    open_dt = local.replace(hour=meta["open"].hour, minute=meta["open"].minute,
                            second=0, microsecond=0)
    close_dt = local.replace(hour=meta["close"].hour, minute=meta["close"].minute,
                             second=0, microsecond=0)
    is_open = is_weekday and open_dt <= local < close_dt

    # minutes until the next state change (open→close, or →next weekday open)
    if is_open:
        next_change = close_dt
        next_label = "closes"
    else:
        next_label = "opens"
        # scan forward day by day to the next weekday session open
        cand = open_dt
        for _ in range(8):
            if cand > local and cand.weekday() < 5:
                break
            cand = (cand + timedelta(days=1)).replace(
                hour=meta["open"].hour, minute=meta["open"].minute, second=0, microsecond=0)
        next_change = cand

    secs = int((next_change - local).total_seconds())
    utc = ZoneInfo("UTC")
    return {
        "code": meta["code"],
        "name": meta["name"],
        "country": meta["country"],
        "tz": meta["tz"],
        "localTime": local.strftime("%H:%M"),
        "localDate": local.strftime("%Y-%m-%d"),
        "open": meta["open"].strftime("%H:%M"),
        "close": meta["close"].strftime("%H:%M"),
        "isOpen": is_open,
        "nextChange": next_label,
        "minutesToNextChange": max(secs // 60, 0),
        # Absolute instants so the client can tick a live HH:MM:SS countdown
        # against its own clock without polling every second.
        "secondsToNextChange": max(secs, 0),
        "nextChangeAt": next_change.astimezone(utc).isoformat(),
        "serverNowUtc": now_utc.astimezone(utc).isoformat(),
    }


def status_for_symbol(symbol: str, now_utc: datetime | None = None) -> dict:
    now = now_utc or datetime.now(ZoneInfo("UTC"))
    meta = EXCHANGES[exchange_for_symbol(symbol)]
    return _status_for(meta, now)


def all_statuses(keys: list[str] | None = None, now_utc: datetime | None = None) -> list[dict]:
    now = now_utc or datetime.now(ZoneInfo("UTC"))
    seen: set[str] = set()
    out: list[dict] = []
    for k in (keys or PRIMARY_EXCHANGES):
        meta = EXCHANGES.get(k)
        if not meta or meta["code"] in seen:
            continue
        seen.add(meta["code"])
        out.append(_status_for(meta, now))
    return out

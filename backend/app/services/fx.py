"""FX service — ECB reference rates via frankfurter.app, cached in SQLite (port of fx.ts).

1 unit of `from` = rate `to`. Same currency -> 1. Falls back over a small window for
weekends/holidays, then to the latest rate, then to 1 (graceful degrade)."""
from __future__ import annotations

import httpx
import pandas as pd

from ..core import db
from ..core.config import settings
from ..core.logging import get_logger

log = get_logger("fx")

BASE_URL = "https://api.frankfurter.app"


def _client() -> httpx.Client:
    return httpx.Client(timeout=settings.yf_timeout_s)


def _cache_get(base: str, quote: str, date: str) -> float | None:
    row = db.q("SELECT rate FROM fx_cache WHERE base = ? AND quote = ? AND date = ?").get((base, quote, date))
    return row["rate"] if row else None


def _cache_get_nearest(base: str, quote: str, date: str) -> float | None:
    floor = (pd.Timestamp(date) - pd.Timedelta(days=6)).strftime("%Y-%m-%d")
    row = db.q(
        "SELECT rate FROM fx_cache WHERE base = ? AND quote = ? AND date <= ? AND date >= ? "
        "ORDER BY date DESC LIMIT 1"
    ).get((base, quote, date, floor))
    return row["rate"] if row else None


def _put(base: str, quote: str, date: str, rate: float) -> None:
    db.execute(
        "INSERT OR REPLACE INTO fx_cache (base, quote, date, rate) VALUES (?, ?, ?, ?)",
        (base, quote, date, rate),
    )


def ensure_fx_range(currencies: list[str], from_date: str, to: str) -> None:
    """Pre-populate fx_cache with the full ECB business-day series for a range."""
    start = (pd.Timestamp(from_date) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    end = pd.Timestamp(to).strftime("%Y-%m-%d")
    for cur in currencies:
        if cur == "CHF":
            continue
        cov = db.q(
            "SELECT COUNT(*) AS c FROM fx_cache WHERE base = ? AND quote = ? AND date >= ? AND date <= ?"
        ).get((cur, "CHF", start, end))
        business_days = (pd.Timestamp(end) - pd.Timestamp(start)).days * (5 / 7)
        if cov and cov["c"] > business_days * 0.6:
            continue
        try:
            with _client() as client:
                res = client.get(f"{BASE_URL}/{start}..{end}", params={"from": cur, "to": "CHF"})
            if res.status_code != 200:
                continue
            data = res.json()
            rows = (data.get("rates") or {})

            def _tx(conn, _rows=rows, _cur=cur):
                for d, r in _rows.items():
                    if isinstance(r.get("CHF"), (int, float)):
                        conn.execute(
                            "INSERT OR REPLACE INTO fx_cache (base, quote, date, rate) VALUES (?, ?, ?, ?)",
                            (_cur, "CHF", d, r["CHF"]),
                        )

            db.transaction(_tx)
        except Exception:  # noqa: BLE001
            # ignore; per-date fallback still works
            pass


def get_fx_rate(from_cur: str, to: str, date: str) -> float:
    if from_cur == to:
        return 1.0
    iso = pd.Timestamp(date).strftime("%Y-%m-%d")
    cached = _cache_get(from_cur, to, iso)
    if cached is not None:
        return cached
    near = _cache_get_nearest(from_cur, to, iso)
    if near is not None:
        _put(from_cur, to, iso, near)
        return near

    start = (pd.Timestamp(iso) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    try:
        with _client() as client:
            res = client.get(f"{BASE_URL}/{start}..{iso}", params={"from": from_cur, "to": to})
        if res.status_code == 200:
            data = res.json()
            rates = data.get("rates") or {}
            dates = sorted(rates.keys())
            if dates:
                last = dates[-1]
                rate = rates[last].get(to)
                if isinstance(rate, (int, float)):
                    _put(from_cur, to, iso, rate)
                    return rate
    except Exception:  # noqa: BLE001
        pass

    try:
        with _client() as client:
            res = client.get(f"{BASE_URL}/latest", params={"from": from_cur, "to": to})
        if res.status_code == 200:
            rate = (res.json().get("rates") or {}).get(to)
            if isinstance(rate, (int, float)):
                _put(from_cur, to, iso, rate)
                return rate
    except Exception:  # noqa: BLE001
        pass

    return 1.0  # unknown FX: degrade gracefully (flagged stale upstream)


def to_chf(amount: float, currency: str, date: str) -> float:
    if not amount:
        return 0.0
    return amount * get_fx_rate(currency, "CHF", date)


def latest_fx_to_chf(currency: str) -> float:
    return get_fx_rate(currency, "CHF", pd.Timestamp.utcnow().strftime("%Y-%m-%d"))

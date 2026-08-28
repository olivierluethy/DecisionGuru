"""FX service — ECB reference rates via frankfurter.app, cached in SQLite (port of fx.ts).

1 unit of `from` = rate `to`. Same currency -> 1. Falls back over a small window for
weekends/holidays, then to the latest rate, then to 1 (graceful degrade)."""
from __future__ import annotations

from typing import NamedTuple

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


class FxResult(NamedTuple):
    """A resolved rate plus HOW it was resolved, so callers can flag data quality.

    `rate is None` (source 'unresolved') means no rate could be found — the caller must
    decide whether to degrade or abstain, rather than a silent 1:1 being assumed for it."""
    rate: float | None
    source: str  # 'same' | 'cache' | 'nearest' | 'range' | 'latest' | 'unresolved'


def resolve_fx(from_cur: str, to: str, date: str) -> FxResult:
    """Resolve `from`→`to` on `date`, reporting the resolution stage. Never fabricates a
    rate: an unresolvable pair returns (None, 'unresolved') — see AUDIT §3 F-3."""
    if from_cur == to:
        return FxResult(1.0, "same")
    iso = pd.Timestamp(date).strftime("%Y-%m-%d")
    cached = _cache_get(from_cur, to, iso)
    if cached is not None:
        return FxResult(cached, "cache")
    near = _cache_get_nearest(from_cur, to, iso)
    if near is not None:
        _put(from_cur, to, iso, near)
        return FxResult(near, "nearest")

    start = (pd.Timestamp(iso) - pd.Timedelta(days=7)).strftime("%Y-%m-%d")
    try:
        with _client() as client:
            res = client.get(f"{BASE_URL}/{start}..{iso}", params={"from": from_cur, "to": to})
        if res.status_code == 200:
            rates = (res.json().get("rates") or {})
            dates = sorted(rates.keys())
            if dates:
                rate = rates[dates[-1]].get(to)
                if isinstance(rate, (int, float)):
                    _put(from_cur, to, iso, rate)
                    return FxResult(rate, "range")
    except Exception:  # noqa: BLE001
        pass

    try:
        with _client() as client:
            res = client.get(f"{BASE_URL}/latest", params={"from": from_cur, "to": to})
        if res.status_code == 200:
            rate = (res.json().get("rates") or {}).get(to)
            if isinstance(rate, (int, float)):
                _put(from_cur, to, iso, rate)
                return FxResult(rate, "latest")
    except Exception:  # noqa: BLE001
        pass

    return FxResult(None, "unresolved")


def get_fx_rate(from_cur: str, to: str, date: str, *, strict: bool = False) -> float | None:
    """Resolved FX rate. On an unresolvable pair this **warns** (never silent) and returns
    None in ``strict`` mode, or 1.0 as a flagged graceful degrade otherwise. Existing
    callers pass no ``strict`` and keep the historical float contract; new/critical callers
    pass ``strict=True`` to abstain instead of mis-valuing on a fabricated 1:1 (AUDIT §3 F-3)."""
    r = resolve_fx(from_cur, to, date)
    if r.rate is not None:
        return r.rate
    log.warning(
        "FX unresolved for %s→%s on %s — no rate available%s",
        from_cur, to, date, "" if strict else " (degrading to 1.0)",
    )
    return None if strict else 1.0


def to_chf(amount: float, currency: str, date: str) -> float:
    if not amount:
        return 0.0
    return amount * get_fx_rate(currency, "CHF", date)


def latest_fx_to_chf(currency: str) -> float:
    return get_fx_rate(currency, "CHF", pd.Timestamp.utcnow().strftime("%Y-%m-%d"))

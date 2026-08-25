"""ISO-8601 timestamps matching JS Date.toISOString(): 'YYYY-MM-DDTHH:MM:SS.sssZ'."""
from __future__ import annotations

from datetime import datetime, timezone


def _fmt(dt: datetime) -> str:
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def iso_now() -> str:
    return _fmt(datetime.now(timezone.utc))


def iso_from_ms(ms: int) -> str:
    return _fmt(datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc))

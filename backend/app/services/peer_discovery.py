"""Autonome Wettbewerber-Erkennung — Peers einer Firma aus ihrer eigenen Yahoo-Industry,
nicht aus einer handgepflegten Liste. ``provider.industry_peers(industryKey)`` liefert die
gerankten Konstituenten der Industry des Subjekts (z. B. EA/RBLX für TTWO). Ergebnisse werden
kurz gecacht, damit erneutes Öffnen einer Aktie den rate-limitierten Provider nicht erneut
trifft; jeder Fehler degradiert zu einer leeren Liste, sodass ``competitors()`` auf die
kuratierte Universe zurückfallen kann."""
from __future__ import annotations

import time

from ..core.logging import get_logger
from ..providers.yfinance_provider import provider

log = get_logger("peer_discovery")

# Industry-Zusammensetzung ändert sich selten → großzügiger In-Memory-TTL.
_TTL_S = 24 * 3600
_cache: dict[str, tuple[float, list[str]]] = {}


def discover_peers(industry_key: str | None) -> list[str]:
    """Peer-Ticker für die Industry des Subjekts. Leere Liste bei fehlendem Key/Fehler."""
    if not industry_key:
        return []
    now = time.monotonic()
    hit = _cache.get(industry_key)
    if hit is not None and (now - hit[0]) < _TTL_S:
        return hit[1]
    peers = provider.industry_peers(industry_key)
    _cache[industry_key] = (now, peers)
    return peers

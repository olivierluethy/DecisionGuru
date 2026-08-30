# Autonome Wettbewerber-Erkennung — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wettbewerber in der „Market Analysis" autonom pro Unternehmen ermitteln — über die
Yahoo-Industry der Aktie selbst statt über eine handgepflegte Liste.

**Architecture:** `competitors()` ermittelt Peers künftig primär über
`yf.Industry(<industryKey der Aktie>).top_companies`. Die Fundamentaldaten neu gefundener
Peers werden on-demand live geholt und gecacht. Der bestehende `same_market`-Filter bleibt als
Qualitäts-Guard, `UNIVERSE_SEED` bleibt als Fallback bei Discovery-Ausfall.

**Tech Stack:** Python, FastAPI, yfinance 1.6.0, SQLite-Cache.

## Global Constraints

- Keine automatisierten Tests in diesem Umfang (Nutzer-Vorgabe) — Verifikation manuell.
- Jeder Provider-Zugriff läuft über den bestehenden gedrosselten `_call`-Gate im
  `YFinanceProvider` (Rate-Limit-/Retry-/Timeout-Garantien).
- Discovery darf nie hart failen: bei Fehler/leerem Ergebnis leere Liste → Fallback-Pool.
- On-Demand-Live-Fetch nur für Discovery-Peers; alle übrigen Pool-Mitglieder bleiben
  cache-only (kein Massen-Fan-out).
- Spec: `docs/superpowers/specs/2026-08-30-autonomous-peer-discovery-design.md`.

---

### Task 1: Provider — `industryKey` im Snapshot + `industry_peers()`

**Files:**
- Modify: `backend/app/providers/yfinance_provider.py`

**Interfaces:**
- Produces: `provider.industry_peers(industry_key: str) -> list[str]` (Ticker-Symbole,
  Yahoo-Ranking; leere Liste bei jedem Fehler).
- Produces: Fundamentals-Snapshot enthält zusätzlich `snapshot["industryKey"]` (kebab-case
  Yahoo-Key, z. B. `"electronic-gaming-multimedia"`, oder `None`).

- [ ] **Step 1: `industryKey` in den Snapshot aufnehmen**

In `fundamentals()`, im `snapshot`-Dict direkt nach der `"industry"`-Zeile (aktuell
`yfinance_provider.py:230`) ergänzen:

```python
                "industry": info.get("industry"),
                "industryKey": info.get("industryKey"),
```

- [ ] **Step 2: Provider-Methode `industry_peers()` hinzufügen**

Nach der `search()`-Methode (vor `provider = YFinanceProvider()`, aktuell `yfinance_provider.py:437`)
einfügen:

```python
    # ---- industry peers (autonomous competitor discovery) ----
    def industry_peers(self, industry_key: str) -> list[str]:
        """Ticker symbols in a Yahoo industry (kebab-case key, e.g.
        'electronic-gaming-multimedia'), ranked by Yahoo's market weight. This is the
        autonomous peer source: keyed off the subject's own industryKey, no curated list.
        Returns [] on any failure so callers can fall back to the curated universe."""
        if not industry_key:
            return []

        def _fetch() -> list[str]:
            ind = yf.Industry(industry_key)
            tc = ind.top_companies
            if tc is None or tc.empty:
                return []
            return [str(s) for s in tc.index]

        try:
            return self._call(f"industry_peers {industry_key}", _fetch) or []
        except Exception as exc:  # noqa: BLE001
            log.warning("industry_peers failed for %s: %s", industry_key, exc)
            return []
```

- [ ] **Step 3: Commit**

```bash
git add backend/app/providers/yfinance_provider.py
git commit -m "feat(provider): expose industry_peers() and industryKey in snapshot"
```

---

### Task 2: Service — `peer_discovery.py`

**Files:**
- Create: `backend/app/services/peer_discovery.py`

**Interfaces:**
- Consumes: `provider.industry_peers(industry_key)` (aus Task 1).
- Produces: `discover_peers(industry_key: str | None) -> list[str]` — kurz gecachte
  Peer-Liste; `[]` wenn kein Key oder Provider nichts liefert.

- [ ] **Step 1: Datei anlegen**

```python
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
```

- [ ] **Step 2: Commit**

```bash
git add backend/app/services/peer_discovery.py
git commit -m "feat(peers): add autonomous peer_discovery service"
```

---

### Task 3: `competitors()` auf Discovery umstellen

**Files:**
- Modify: `backend/app/services/competitors.py`

**Interfaces:**
- Consumes: `discover_peers(...)` (Task 2), `get_fundamentals(...)` (bestehend in
  `fundamentals.py`), `provider`-Snapshot mit `industryKey` (Task 1).
- Produces: unveränderte Rückgabestruktur von `competitors()` (`peers`, `peerCount`,
  `subjectRank`) — nur der Kandidaten-Pool wird autonom befüllt.

- [ ] **Step 1: Imports erweitern**

`competitors.py:22` von

```python
from .fundamentals import get_cached_fundamentals
```

ändern zu

```python
from .fundamentals import get_cached_fundamentals, get_fundamentals
from .peer_discovery import discover_peers
```

- [ ] **Step 2: Subjekt bei fehlendem `industryKey` on-demand auffrischen**

In `competitors()` den Kopf (aktuell `competitors.py:46-52`) ersetzen durch:

```python
    subject = get_cached_fundamentals(symbol)
    subj_snap = (subject or {}).get("snapshot")
    # industryKey treibt die autonome Discovery. Ältere Cache-Einträge kennen das Feld noch
    # nicht → Subjekt einmal on-demand nachladen, damit Discovery greifen kann.
    if subj_snap is not None and not subj_snap.get("industryKey"):
        subject = get_fundamentals(symbol) or subject
        subj_snap = (subject or {}).get("snapshot")
    sector = (subj_snap or {}).get("sector")
    industry = (subj_snap or {}).get("industry")
    if not subj_snap or not sector:
        return {"symbol": symbol, "sector": sector, "industry": industry,
                "peers": [], "peerCount": 0, "subjectRank": None}
```

- [ ] **Step 3: Discovery in den Pool aufnehmen**

Den Pool-Aufbau (aktuell `competitors.py:54-56`) ersetzen durch:

```python
    # Autonome Peers aus der Industry des Subjekts; Fallback-Quellen dahinter.
    discovered = discover_peers((subj_snap or {}).get("industryKey"))
    discovered_set = set(discovered)

    holdings = [i["symbol"] for i in repo.list_instruments() if i.get("symbol")]
    watch = [w["symbol"] for w in list_watchlist() if w.get("symbol")]
    # Discovery zuerst, dann Holdings/Watchlist, dann die kuratierte Liste als Fallback.
    pool = list(dict.fromkeys([symbol, *discovered, *holdings, *watch, *UNIVERSE_SEED]))
```

- [ ] **Step 4: On-Demand-Fetch für Discovery-Peers**

In der Peer-Schleife die Datenbeschaffung (aktuell `competitors.py:76`) ersetzen von

```python
        data = get_cached_fundamentals(sym)
```

zu

```python
        # Discovery-Peers on-demand live holen (+ cachen); alle übrigen bleiben cache-only,
        # damit die kuratierte Universe nicht in hunderte rate-limitierte Calls ausfächert.
        data = get_fundamentals(sym) if sym in discovered_set else get_cached_fundamentals(sym)
```

- [ ] **Step 5: Commit**

```bash
git add backend/app/services/competitors.py
git commit -m "feat(peers): source competitors from autonomous industry discovery"
```

---

### Task 4: Manuelle Verifikation

**Files:** keine Änderung.

- [ ] **Step 1: Backend starten** (projektüblicher Weg, z. B. `uv run uvicorn app.main:app` im
  `backend/`-Verzeichnis) und Endpoint prüfen:

```bash
curl -s "http://localhost:8000/research/competitors/TTWO" | python -m json.tool
```

Erwartet: `peerCount > 0`, `peers` enthält u. a. `EA` (Electronic Arts). Erster Aufruf kann
durch den On-Demand-Fetch einige Sekunden dauern; Folgeaufrufe sind schnell (Cache).

- [ ] **Step 2:** In der App über „Overview" → TTWO → „Market Analysis" öffnen und prüfen, dass
  die Wettbewerber-Tabelle jetzt Peers zeigt (statt der Empty-State-Meldung).

- [ ] **Step 3: Regression** — eine Aktie, die heute schon Peers zeigt (z. B. ein SMI-Wert wie
  `NESN.SW`), öffnen und prüfen, dass die Peers weiterhin plausibel sind.

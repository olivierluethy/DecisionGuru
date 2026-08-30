# Autonome Wettbewerber-Erkennung (Autonomous Peer Discovery)

**Datum:** 2026-08-30
**Status:** Entwurf genehmigt, bereit für Implementierungsplanung
**Betrifft:** „Market Analysis" / Wettbewerber-Vergleich

## Problem

Die „Market Analysis" zeigt für viele Aktien keine Wettbewerber. Beispiel: Take-Two
Interactive (TTWO) zeigt nur sich selbst, obwohl EA, Roblox, Activision etc. offensichtliche
Peers sind.

Ursache (verifiziert): Wettbewerber werden heute rein aus einer **fest kuratierten lokalen
Liste** (`UNIVERSE_SEED` in `backend/app/reference/universe.py`) ∪ Holdings ∪ Watchlist
gebildet. Ein Kandidat zählt nur, wenn `same_market()` (gleicher Sektor UND gleiche Industry)
zutrifft *und* seine Fundamentaldaten bereits im Cache liegen. TTWO ist nicht in der Liste,
und die Liste enthält keinen einzigen Gaming-Titel — also null Peers.

Die kuratierte Liste existiert, weil der einzige Provider (yfinance/Yahoo) die IP hart
rate-limitet; die gesamte Analyse ist deshalb bewusst *cache-only*.

## Ziel

Wettbewerber sollen **autonom pro Unternehmen** ermittelt werden, ohne dass die kuratierte
Liste ständig manuell ergänzt werden muss — für jede Aktie, die der Nutzer öffnet.

## Verifizierte Erkenntnisse (Feasibility)

Getestet mit yfinance 1.6.0 in diesem Projekt:

- `Ticker.recommendations` = Analysten-Empfehlungen (Buy/Hold/Sell), **nicht** Peers.
- Yahoo `recommendationsbysymbol`-Endpoint liefert für TTWO Co-Viewing-Rauschen
  (TWLO, ADSK, TTD, OKTA, ETSY) — **keine** Wettbewerber. **Verworfen.**
- **`yf.Industry(<industryKey>).top_companies`** liefert für
  `industryKey="electronic-gaming-multimedia"` (TTWOs eigenes Feld) autonom:
  **EA, TTWO, RBLX, GDEV, FIRY** — echte Gaming-Peers. **Gewählte Quelle.**
- Der Schlüssel kommt direkt aus dem Fundamentals-Feld `industryKey` des Subjekts
  (Yahoo `get_info()`), also **kein manuelles Mapping** nötig.

### Bekannte Grenze

`yf.Industry(...).top_companies` ist tendenziell US-/Large-Cap-lastig und liefert eine
begrenzte Liste. **EA und Roblox** kommen zuverlässig; **Ubisoft (UBI.PA, Paris)** taucht
dort *nicht* auf. Wir bekommen die großen echten Peers autonom, aber nicht jeden
Nischen-/Auslandstitel. Erweiterung dafür siehe „Spätere Erweiterung (C)".

## Entwurfsentscheidungen (vom Nutzer bestätigt)

1. **Verhalten:** On-Demand live holen. Beim Öffnen einer Aktie ohne gecachte Peers darf die
   App ein paar Live-Calls machen (Peers ermitteln + deren Fundamentaldaten), kurze
   Wartezeit; Ergebnisse werden gecacht.
2. **Peer-Filter:** `same_market` (Sektor + Industry) bleibt als Qualitäts-Guard bestehen.
   Industry-gescreente Titel bestehen ihn per Konstruktion.
3. **Alte Liste:** `UNIVERSE_SEED` bleibt als **Fallback** erhalten (bei Discovery-Ausfall,
   Rate-Limit, fehlendem `industryKey`).

## Architektur

Gewählt: **Ansatz A — Industry-Screener.**

### Datenfluss (competitors)

```
competitors(symbol)
  1. subject = get_cached_fundamentals(symbol)   # wie heute
     └ industryKey = subject.snapshot.industryKey
  2. discovered = discover_peers(industryKey)     # NEU: yf.Industry(key).top_companies
     └ Ausfall / kein Key → discovered = []
  3. pool = discovered ∪ holdings ∪ watchlist ∪ UNIVERSE_SEED(Fallback)
  4. für Discovery-Peers ohne frische Fundamentals:
        get_fundamentals(sym)                     # NEU: On-Demand live-Fetch + Cache
     (für Nicht-Discovery-Kandidaten weiterhin cache-only)
  5. same_market(subject, candidate) Filter       # wie heute
  6. Ranking nach Market Cap in CHF               # wie heute
```

### Komponenten

**Neu: `backend/app/services/peer_discovery.py`**
- `discover_peers(industry_key: str) -> list[str]`: ruft `yf.Industry(industry_key).top_companies`
  über den bestehenden gedrosselten Provider-Gate auf, gibt eine Ticker-Liste zurück.
- Kurzer In-Memory-/DB-Cache (TTL) pro `industry_key`, damit wiederholtes Öffnen keine
  erneuten Calls auslöst.
- Fehlerbehandlung: Rate-Limit / Timeout / leeres Ergebnis / fehlender Key → `[]` zurück
  (nie werfen). Aufrufer fällt dann auf den Fallback-Pool zurück.

**Provider: `backend/app/providers/yfinance_provider.py`**
- Neue Methode, die `yf.Industry(key).top_companies` hinter `self._call(...)` kapselt
  (gleiche Drossel/Retry/Timeout-Garantien wie `chart`/`quote`/`fundamentals`).
- **`industryKey` in den Fundamentals-Snapshot aufnehmen** (heute nur `industry`-Klartext):
  in `fundamentals()` `snapshot["industryKey"] = info.get("industryKey")` ergänzen.

**Umbau: `backend/app/services/competitors.py` (`competitors()`, Zeile 45)**
- Nach dem Lesen von `subject` den `industryKey` bestimmen und `discover_peers()` aufrufen.
- Pool = `discovered ∪ holdings ∪ watch ∪ UNIVERSE_SEED` (Reihenfolge dedupliziert wie heute
  via `dict.fromkeys`).
- Für Discovery-Peers `get_fundamentals(sym)` (On-Demand) statt nur `get_cached_fundamentals`.
  Für die übrigen Pool-Mitglieder cache-only wie bisher (kein Fan-out).
- `same_market`-Filter und Ranking unverändert.

**Snapshot-Migration / Rückwärtskompatibilität**
- Bereits gecachte Fundamentals haben kein `industryKey`. Beim Fehlen: entweder aus dem
  `industry`-Klartext ableiten (kebab-case) *oder* über `get_fundamentals()` neu ziehen,
  wenn ohnehin ein Live-Fetch ansteht. Bevorzugt: On-Demand-Refresh des Subjekts, wenn
  `industryKey` fehlt.

## Fehlerbehandlung & Robustheit

- Discovery wirft nie; leeres Ergebnis → Fallback-Pool. Nutzer sieht schlimmstenfalls das
  heutige Verhalten (kuratierte Liste), nie einen Fehler.
- On-Demand-Fetches laufen durch den bestehenden Rate-Limit-Gate (`_call`), also seriell
  gedrosselt — begrenzt auf die paar Peer-Symbole, kein Massen-Fan-out.
- Discovery-Ergebnis-Cache (TTL) verhindert wiederholte Industry-Calls beim erneuten Öffnen.

## Teststrategie

- Unit: `discover_peers` mit gemocktem `yf.Industry` → TTWO(industryKey) liefert EA/RBLX/…
- Unit: Fallback — Discovery wirft/leer → Pool nutzt `UNIVERSE_SEED`.
- Unit: `same_market`-Guard bleibt wirksam (Fremd-Industry-Peer wird gefiltert).
- Unit: On-Demand-Fetch — Discovery-Peer ohne Cache löst `get_fundamentals` aus und cacht.
- Integration: `GET /research/market/TTWO` (bzw. `/research/competitors/TTWO`) mit gemocktem
  Provider liefert nicht-leere Peers inkl. EA.
- Regression: Titel, die heute schon Peers zeigen (z. B. ein SMI-Wert), bleiben korrekt.

## Nicht im Umfang (YAGNI)

- Kein globaler Voll-Crawl aller Börsen (unmöglich unter dem Rate-Limit).
- Kein LLM-basiertes Peer-Naming.
- Kein Frontend-Redesign — die bestehende Tabelle in `MarketAnalysis.tsx` bleibt; sie füllt
  sich nur, weil der Backend-Pool jetzt Peers liefert.

## Spätere Erweiterung (C) — optional

Um Auslands-/Nischen-Peers wie Ubisoft (UBI.PA) einzufangen: Discovery zusätzlich um einen
Sektor-Screener (`yf.Sector`) oder eine erweiterte Query ergänzen und die Union durch
`same_market` filtern. Mehr Abdeckung, mehr Calls — bewusst als separater Schritt nach A.

# Market Analysis zeigte keine Wettbewerber — Ursache & Lösung

**Datum:** 2026-08-30
**Bereich:** „Market Analysis" · Wettbewerber-Vergleich (`competitors()` / `peer_discovery`)
**Symptom:** Unter „Market Analysis" wurde für eine Aktie (z. B. Take-Two Interactive, TTWO)
nur die Aktie selbst als „Company" angezeigt — keine Peers wie Electronic Arts, obwohl solche
über eine einfache Google-Suche offensichtlich sind.

## Kurzfassung

Zwei aufeinanderfolgende Ursachen mussten behoben werden:

1. **Design:** Peers kamen ursprünglich nur aus einer **handgepflegten Liste** (`UNIVERSE_SEED`),
   die keine Gaming-Titel enthielt → für TTWO null Peers. → gelöst durch **autonome Discovery**
   über die Yahoo-Industry der Aktie.
2. **Bug im Discovery-Rollout:** Der neue Code lief für **vor dem Feature gecachte Aktien**
   nie an, weil der benötigte `industryKey` in alten Cache-Einträgen fehlte und der „Refresh"
   ein wirkungsloser Cache-Treffer war. → gelöst durch **Ableitung des Keys aus dem Klartext-Label**.

Erst nach Fix #2 erschienen die Peers tatsächlich in der laufenden App.

## Warum das Problem mehrfach „gelöst" schien, aber blieb

- Die Analyse ist bewusst **cache-only** (der yfinance/Yahoo-Provider drosselt die IP hart).
- Isolierte Tests der neuen Discovery-Funktion (`discover_peers('electronic-gaming-multimedia')`)
  lieferten korrekt `EA, TTWO, RBLX, …` — der Eindruck „es funktioniert".
- Der **echte Laufzeitpfad** `competitors('TTWO')` gegen die **echte DB** wurde zunächst nicht
  geprüft. Genau dort steckte der Fehler: der gecachte TTWO-Snapshot hatte `industryKey = None`.

Lehre: den **vollständigen Laufzeitpfad mit echten Daten** reproduzieren, nicht nur die neue
Einzelfunktion isoliert.

## Ursachenkette (Root Cause) von Fix #2

1. `competitors(symbol)` rief `discover_peers(subj_snap.get("industryKey"))` auf.
2. `industryKey` wird erst seit dem Feature in den Fundamentals-Snapshot geschrieben.
   TTWO war **vorher** gecacht → `industryKey = None`.
3. Der Versuch, das Subjekt bei fehlendem `industryKey` per `get_fundamentals()` neu zu laden,
   war wirkungslos: `get_fundamentals()` liefert innerhalb der TTL den **bestehenden** Cache
   zurück — also erneut ohne `industryKey`.
4. Folge: `discover_peers(None)` → `[]` → nur das Subjekt → „nur TTWO".

Beobachtet: `competitors('TTWO')` kehrte in 0,2 s mit `peerCount = 0` zurück (Cache-Treffer,
kein Netzwerk) — der Beweis, dass gar keine Discovery lief.

## Die Lösung

**Den Yahoo-Industry-Key aus dem bereits vorhandenen Klartext-`industry`-Label ableiten**, wenn
`industryKey` fehlt — offline, ohne teuren Re-Scrape.

- Neue Funktion `industry_key_from_label()` in `backend/app/services/peer_discovery.py`:
  `"Electronic Gaming & Multimedia"` → `"electronic-gaming-multimedia"`
  (lowercase, `&` entfernen, jede Folge von Nicht-Alphanumerik → ein Bindestrich).
- `competitors()` nutzt `subj_snap.get("industryKey") or industry_key_from_label(industry)`.
- Der erzwungene Live-Fetch bleibt nur noch für **komplett ungecachte** Subjekte (die ohnehin
  einen Fetch brauchen, um Sektor/Industry zu kennen).
- Falscher Slug degradiert sauber: `industry_peers()` gibt bei 404 `[]` zurück → Fallback-Pool.

### Verworfene Alternativen

- **Yahoo „similar tickers" (`recommendationsbysymbol`)**: liefert Co-Viewing-Rauschen
  (für TTWO: TWLO/OKTA/…), keine Wettbewerber.
- **yfinances eigenes `SECTOR_INDUSTY_MAPPING_LC`**: unzuverlässig — enthält Em-Dash-Keys
  (`banks—diversified`), die bei `yf.Industry` **HTTP 404** ergeben. Die ASCII-Slug-Form
  (`banks-diversified`) funktioniert dagegen und entspricht genau der Ableitung oben.
- **Erzwungener Re-Scrape des Subjekts nur wegen `industryKey`**: langsam und
  rate-limit-anfällig; unnötig, da der Key aus dem Label ableitbar ist.

## Verifikation

- **Backend (echte DB):** `competitors('TTWO')` → `peerCount 4`: EA, RBLX, GDEV, FIRY
  (alle „Electronic Gaming & Multimedia"), Erstaufruf ~6 s (Live-Fetch der Peers), danach gecacht.
- **UI (Playwright):** `e2e/market-analysis.spec.ts` grün; Screenshot zeigt EA/RBLX/GDEV/FIRY
  in der Wettbewerber-Tabelle.
- **Regression:** Backend-Suite 109 grün (die 3 roten in `test_market_analysis_bundle.py` sind
  vorbestehend — veralteter `monkeypatch` auf `ma.get_fx_rate` — und auch ohne diesen Fix rot);
  Frontend-Typecheck grün.

## Bekannte Grenzen

- **Auslands-/Nischentitel:** Yahoos Industry-Top-Liste ist US-/Large-Cap-lastig. EA und Roblox
  kommen zuverlässig, **Ubisoft (UBI.PA, Paris)** erscheint dort nicht. Erweiterung: zusätzlicher
  Sektor-Screener (siehe „Ansatz C" in
  `docs/superpowers/specs/2026-08-30-autonomous-peer-discovery-design.md`).
- **Market Cap (CHF):** wird nur angezeigt, wenn ein USD→CHF-Kurs im FX-Cache liegt; sonst „—".

## Playwright-Umgebung (neu)

Für schnellere UI-Verifikation wurde Playwright direkt ins Repo integriert:

- `playwright.config.ts` (bootet den Dev-Stack via `npm run dev`, reuse laufender Server).
- `e2e/` mit dem Market-Analysis-Test; Screenshots/Reports sind git-ignored.
- npm-Skripte: `npm run test:e2e`, `npm run test:e2e:headed`, `npm run e2e:report`.
- Dev-only Store-Handle `window.__app` (in `frontend/src/store.ts`, nur unter
  `import.meta.env.DEV`) zum Deep-Linken direkt auf ein Symbol.

## Betroffene Dateien

- `backend/app/services/peer_discovery.py` — `industry_key_from_label()` + (früher)
  Discovery/Cache-Härtung.
- `backend/app/services/competitors.py` — Key-Ableitung, Refetch nur bei ungecachtem Subjekt.
- `backend/app/providers/yfinance_provider.py` — `industry_peers()`, `industryKey` im Snapshot
  (aus dem vorangegangenen Feature).
- `playwright.config.ts`, `e2e/`, `frontend/src/store.ts`, `package.json` — Playwright-Setup.

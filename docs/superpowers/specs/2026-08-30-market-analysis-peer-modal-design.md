# Market Analysis: Peer-Klick öffnet OpportunityModal statt Research

**Datum:** 2026-08-30
**Status:** Entwurf, zur Umsetzung freigegeben

## Problem / Ziel

Heute springt ein Klick auf eine Firma in der Market-Analysis-Tabelle **direkt** in
die Research-Ansicht. Der Nutzer möchte stattdessen zuerst eine Übersicht als Modal
sehen (dasselbe `OpportunityModal` wie aus Discover/Screener) und erst von dort aus
selbst entscheiden, ob er die Firma zusätzlich in der Research-Ansicht öffnet.

## Aktueller Zustand

- `MarketAnalysis` (`frontend/src/components/MarketAnalysis.tsx`) rendert die
  „Comparable companies"-Tabelle. Sie ist eine geteilte Komponente und erscheint in:
  - Research-Ansicht (`views/Research.tsx`, `AssetView`)
  - Position-Detail (`views/PositionDetail.tsx`)
  - `OpportunityModal` selbst (`modals/OpportunityModal.tsx`)
- Peer-Klick heute: `onClick={() => researchSymbolView(c.symbol)}`
  → Store setzt `researchSymbol` + `view: 'research'` → direkter Sprung nach Research.
- Das `OpportunityModal` existiert bereits und wird bisher nur aus Discover/Screener
  geöffnet. Es zeigt Fair Value, Portfolio-Fit, Market Analysis, Listing-Empfehlung
  und hat im Footer u.a. einen „Open Research"-Button (öffnet die Research-Route in
  neuem Tab).
- Der Store hält immer nur **ein** Modal (`s.modal`); `openModal` ersetzt das aktuelle.

## Gewählte Lösung

Der Peer-Klick in `MarketAnalysis` öffnet künftig das `OpportunityModal` für die
geklickte Firma, statt direkt nach Research zu navigieren.

### Änderungen in `MarketAnalysis.tsx`

- Statt `researchSymbolView` aus dem Store `openModal` beziehen.
- Peer-Button:
  ```tsx
  onClick={() => openModal({ kind: 'opportunity', symbol: c.symbol, name: c.name, currency: c.currency })}
  title={`Open ${c.symbol}`}
  ```
- `price` wird bewusst nicht mitgegeben (Peer-Zeile hat keinen Preis). Der Typ
  `opportunity` hat `price?: number | null`; ein fehlender Preis wird als `null` an
  `ValueAnalysis` durchgereicht, das den Live-Preis selbst lädt.

### Verhalten / Entscheidungen

- **Einheitlich in allen drei Kontexten** (Research, Position-Detail, OpportunityModal).
  Da es eine geteilte Komponente ist, ergibt sich das automatisch.
- **Drill-Down im offenen Modal:** Klick auf einen Peer innerhalb eines offenen
  `OpportunityModal` schaltet das Modal per `openModal` auf die neue Firma um
  (kein Stapeln, da nur ein Modal im Store).
- **Subjekt-Zeile (`c.isSubject`) ist ebenfalls klickbar** — einheitliches Verhalten,
  keine Sonderfall-Logik.
- **„In Research öffnen?":** Keine neue Logik. Das ist der bestehende „Open Research"-
  Button im Modal-Footer. Schließen schließt einfach — genau das bekannte Schema aus
  Discover/Screener. Kein zusätzlicher Bestätigungsdialog beim Schließen.

## Betroffene Dateien

- `frontend/src/components/MarketAnalysis.tsx` — Peer-Klick-Handler + Store-Hook + Title.
- `e2e/market-analysis.spec.ts` — Test anpassen: Zeilenklick öffnet nun das Modal
  (`store.modal.kind === 'opportunity'` bzw. Modal im DOM sichtbar), statt
  `researchSymbol` zu setzen / `view === 'research'`.

## Nicht im Umfang (YAGNI)

- Kein neues, schlankeres Modal.
- Kein separater Ja/Nein-Dialog beim Schließen.
- Keine Änderung am `OpportunityModal`-Inhalt oder -Footer.
- Keine Änderung an `researchSymbolView` (bleibt für andere Aufrufer bestehen).

## Testkriterien

- Klick auf eine Peer-Zeile (inkl. Subjekt) in Research/Position-Detail öffnet das
  `OpportunityModal` mit korrektem Symbol/Name/Currency.
- Klick auf einen Peer im offenen `OpportunityModal` schaltet das Modal auf die neue
  Firma um.
- „Open Research" im Modal-Footer führt weiterhin in die Research-Ansicht.
- e2e-Test grün.

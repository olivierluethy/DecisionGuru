# Alerts — Redesign & Level-Up (Design)

**Date:** 2026-09-06 · **Status:** Approved (brainstorming) · **Scope:** frontend only
**Files:** `frontend/src/views/Alerts.tsx` (+ extract time helpers to `frontend/src/lib/time.ts`; possibly small sub-components).

## Problem
The Alerts view has three weaknesses: (1) the header top row crowds title + a 2-line
scan-info block + two buttons onto one line and overflows; the scan info is passive.
(2) Notifications are grouped by day (Today/Yesterday/Monday/…) but there is **no index or
jump navigation and no filtering** — you must scroll to reach an older day, and can scroll
past a day. (3) Price alerts are a static Triggered/Active split with **no sorting, no
filtering, and no meaningful value comparison** (last price vs target).

All data needed already exists (see below) — **no backend change**.

## Available data (from the API, unchanged)
- `AppNotification`: `id, type ('alert'|'opportunity'|'scan'|'rivalry'), title, body, symbol,
  payload, read, readAt, createdAt`.
- `PriceAlert`: `id, symbol, name, kind ('buy'|'sell'), direction ('below'|'above'),
  targetPrice, currency, status ('active'|'triggered'|'dismissed'), auto, reasoning
  ({basis, fairValue, entryTarget, sellZoneAt, marginOfSafety, currentBand}), lastPrice,
  triggeredPrice, triggeredAt, createdAt, updatedAt`.
- `scanStatus`: `{ lastScan: ScanSummary|null, intervalHours (=6) }`; `ScanSummary` has
  `finishedAt, alertsFired, new, attractive, newSymbols, …`.

## Decisions
1. Header: clean two-tier; scan info leaves the crowded row and becomes a smart banner.
2. Time Navigator behaviour: **combined** — tap a pill = jump (smooth-scroll + scrollspy
   highlight); each pill also has a small "only this period" hard-filter control.
3. Everything client-side.

## 1. Header
- Row 1: `Alerts` title (left) · action cluster (right): `Scan now`, `Mark all read`
  (only when unread>0), `PDF / Word`. No scan-info text here.
- **Smart scan banner** (own strip), progressive/proactive, derived from
  `lastScan.finishedAt` + `intervalHours`:
  - never scanned → "Run your first scan" (primary CTA).
  - stale (`now − finishedAt > intervalHours`) → emphasised "New data may be available —
    Scan now" (button accented).
  - fresh & `new>0` → "Scan found {new} new opportunities" → clicking applies the
    Opportunities type-filter.
  - fresh & `0 new` → "You're up to date · next auto-scan in {countdown}".
  - While scanning → progress state on the button + banner.

## 2. Notifications
- **Time Navigator** (sticky, below header; horizontal-scroll on mobile, large touch
  targets): pills for each bucket at the current granularity, each with a **count**. Tap =
  smooth-scroll to that section; scrollspy highlights the active bucket while scrolling. A
  per-pill "only this period" toggle hard-filters to that bucket; an `All` pill / clearing it
  restores the full list.
- **Granularity switch: Day · Week · Month · Year** — rebuckets the feed and the pills.
  Bucket labels: Day = Today/Yesterday/weekday/`D MMM YYYY`; Week = This week/Last week/
  `Wk of D MMM`; Month = `MMM YYYY` (This month/Last month for the two most recent); Year =
  `YYYY`.
- **Filters:** type chips with counts (All · Price · Opportunities · Rivalry · Scans) +
  Unread toggle + a text **search** (title/body/symbol). Filters compose with the navigator.
- Empty/undated states honest (no fabricated buckets).

## 3. Price alerts
- One **sortable list** (replaces the fixed Triggered/Active split) with a status badge.
- Per row, a **distance-to-target gauge**: from `lastPrice` vs `targetPrice`, show the % gap
  and a mini bar (e.g. "LS 109.30 USD · 18% below buy target 184.72"); for a fired alert show
  the trigger. Use `reasoning.entryTarget`/`fairValue` for context where useful.
- **Sort menu:** Closest to trigger (smallest |gap|) · Deepest discount to buy target ·
  Recently fired · Symbol A–Z · Newest.
- **Filter chips:** All · Buy · Sell · Triggered · Active · Auto. Keep the add-alert composer.

## 4. Look & mobile (frontend-design skill)
Dark app theme + tokens (azure/gold/gain/loss/warn/hairline/surface-2). Calm, premium,
data-dense but uncluttered. Time Navigator + scan banner sticky. Mobile-first: horizontal
pill scroller, ≥40px touch targets, single-column cards, wrap-free header. Respect
`prefers-reduced-motion` for the smooth-scroll/scrollspy.

## Non-goals
- No backend/API changes. No new persistence. No changes to the scan cadence or scan logic.

## Success criteria
- Header fits cleanly at all widths; scan status is proactive, not passive.
- Any day/week/month/year is reachable in one tap (jump or hard-filter) — no hunting scroll.
- Notifications filter by type/unread/text; granularity switch works.
- Price alerts sort and filter; each shows a clear last-price-vs-target comparison.
- Works well on a phone; existing actions (scan, mark read, add/delete/dismiss alert,
  export, row → research) still work.

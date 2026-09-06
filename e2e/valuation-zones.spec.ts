import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Historical fair-value zones (Task 12 visual QA): `PriceBandChart` in
 * `frontend/src/components/ValuationBand.tsx` reconstructs stepped valuation zones + a
 * Fair Value spine per-date from the fundamentals then in force, with a scrub cursor,
 * a snapshot card, a clickable transition detail and honest unavailable/pre-coverage states.
 *
 * Unlike market-analysis.spec / forecast.spec (which stub `/research/asset` + `/research/market`
 * or `/api/forecast` with captured fixtures), this suite exercises the REAL dev backend for the
 * main scenario: AAPL's price + fundamentals are already warm in the backend's SQLite cache
 * (`backend/data/decisionguru.sqlite`), so `/research/asset/AAPL`, `/market/history/AAPL`,
 * `/research/valuation/AAPL` and `/research/valuation/history/AAPL` all resolve instantly from
 * cache with no live yfinance call — deterministic within a test run, and truer to the real
 * reconstruction than a hand-written fixture would be. AAPL currently has 4 annual snapshots
 * (FY2022–FY2025, coverage from 2023-03-31) with 3 transitions, the largest a fair-value jump
 * from ~$70 to ~$119 at the FY2025 (2026-03-31) snapshot — used below as the "large transition".
 *
 * For the one scenario the real cache can't produce on demand — a symbol with a valid
 * *current* band but NO reconstructable history — we mirror the existing suite's stubbing
 * pattern (`page.route`) and override just `/research/valuation/history/AAPL` with an
 * empty-snapshots payload, leaving every other AAPL endpoint on the real cache. This is the
 * same "stub the slow/external endpoint, keep everything else real" technique market-analysis
 * and forecast specs use — not a fabricated screenshot.
 *
 * Deep-linking follows the established pattern: no URL routing in this app, so we reach the
 * page via the dev-only store handle (`window.__app`, exposed under import.meta.env.DEV).
 */

const SCREENSHOT_DIR = path.join(process.cwd(), 'e2e', 'screenshots');
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
const shot = (name: string) => path.join(SCREENSHOT_DIR, name);

// Zone/line colours mirrored from ValuationBand.tsx's `C` / `ZONE_STYLE` constants — recharts
// renders these as literal SVG presentation attributes (`fill="#31D6A0"` etc.), so they double
// as stable, content-based selectors for "is a stepped zone actually drawn" without depending
// on recharts' generated class names.
const ZONE_FILL = { buy: '#31D6A0', fair: '#3DA9FC', over: '#F0B34A', sell: '#FF5D6C' } as const;
const FV_SPINE_STROKE = '#5F6E82';
const TRANSITION_DOT_FILL = '#1A2331'; // unselected transition ReferenceDot (C.surface2)

async function openValueAnalysis(page: Page, symbol: string) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__app), null, { timeout: 30_000 });
  await page.evaluate((sym) => (window as any).__app.getState().researchSymbolView(sym), symbol);

  const heading = page.getByRole('heading', { name: 'Value analysis' });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await heading.scrollIntoViewIfNeeded();

  const chart = page.getByRole('application', { name: /Kursverlauf/ });
  await expect(chart).toBeVisible({ timeout: 30_000 });
  // The "Value analysis" heading sits well above the chart itself (verdict card, confidence,
  // flags, valuation range, owner-earnings stats all come first within the same section) — and
  // sections below (Combinations, etc.) keep resizing asynchronously as their own slow queries
  // land, which can silently scroll the page again. Scroll the CHART itself into view, and do
  // it again before every screenshot below rather than relying on the one scroll here.
  await chart.scrollIntoViewIfNeeded();
  return chart;
}

/** Scrolls the chart back into view and screenshots — layout above/below it (Combinations,
 *  etc.) keeps reflowing asynchronously, so a scroll position captured once at the top of the
 *  test can silently drift by the time a later screenshot is taken. */
async function shootChart(page: Page, chart: Locator, filename: string) {
  await chart.scrollIntoViewIfNeeded();
  await page.screenshot({ path: shot(filename) });
}

/** The scrub-cursor snapshot card — the only element carrying both the responsive `lg:w-60`
 *  width class and the shared snapshot-card styling, distinct from the (similarly styled)
 *  transition detail panel below the chart, which has no `lg:w-60`. */
function snapshotCard(page: Page): Locator {
  return page.locator('div[class*="lg:w-60"]');
}

/** The snapshot card's date header — the only span combining exactly these two classes
 *  (Row labels get `text-text-muted` alone; Row values get `font-medium` alone). */
function snapshotDate(page: Page): Locator {
  return snapshotCard(page).locator('span.text-text-muted.font-medium').first();
}

function zoneAreas(chart: Locator) {
  return {
    buy: chart.locator(`svg path.recharts-area-area[fill="${ZONE_FILL.buy}"]`),
    fair: chart.locator(`svg path.recharts-area-area[fill="${ZONE_FILL.fair}"]`),
    over: chart.locator(`svg path.recharts-area-area[fill="${ZONE_FILL.over}"]`),
    sell: chart.locator(`svg path.recharts-area-area[fill="${ZONE_FILL.sell}"]`),
  };
}

async function expectSteppedZonesVisible(chart: Locator) {
  const areas = zoneAreas(chart);
  for (const key of Object.keys(areas) as (keyof typeof areas)[]) {
    await expect(areas[key], `${key} zone area`).toHaveCount(1);
  }
  // The dashed Fair Value spine (stepAfter Line), distinct from the solid azure price line.
  await expect(chart.locator(`svg path.recharts-line-curve[stroke="${FV_SPINE_STROKE}"]`)).toHaveCount(1);
  // "Stepped" (not flat): a stepAfter path draws horizontal+vertical segments only, so it
  // necessarily has far more path commands than a single flat rectangle would. A flat band
  // would still be one <path>, so the real signal is that the path data contains multiple
  // distinct step corners — cheaply checked via a minimum path-length heuristic.
  const d = await chart.locator(`svg path.recharts-area-area[fill="${ZONE_FILL.buy}"]`).getAttribute('d');
  expect(d?.length ?? 0).toBeGreaterThan(200);
}

test.describe('Valuation zones — historical fair-value chart (AAPL, real cache)', () => {
  test('stepped zones render, timeframes switch, hover + keyboard scrub the snapshot card, transitions pin the detail panel', async ({ page }) => {
    const chart = await openValueAnalysis(page, 'AAPL');

    // --- Default (Max) window: stepped zone areas + FV spine, never a flat band. ------------
    await expectSteppedZonesVisible(chart);
    await expect(page.getByText('Historical valuation unavailable')).toHaveCount(0);
    await shootChart(page, chart, 'valuation-zones-today-default.png');

    // --- Desktop width (1440, the config default) — capture explicitly for the record. ------
    await page.setViewportSize({ width: 1440, height: 900 });
    await shootChart(page, chart, 'valuation-zones-desktop-1440.png');

    // --- Timeframe presets: 5J / 3J / 1J keep zones visible + stepped. -----------------------
    const toolbar = page.getByRole('group', { name: 'Zeitraum' });
    for (const [label, file] of [['5J', '5j'], ['3J', '3j'], ['1J', '1j']] as const) {
      await toolbar.getByRole('button', { name: label, exact: true }).click();
      await expect(toolbar.getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expectSteppedZonesVisible(chart);
      await shootChart(page, chart, `valuation-zones-${file}.png`);
    }

    // --- Hovering a mid-history point updates the snapshot card. "Max" spans back to 1989,
    // mostly BEFORE the earliest reconstructed snapshot (coverageFrom 2023-03-31), so a mid-
    // point there would land pre-coverage. 3J (still entirely within coverage) gives a
    // reliable "reconstructed valuation exists here" point to hover. -------------------------
    await toolbar.getByRole('button', { name: '3J', exact: true }).click();
    await expectSteppedZonesVisible(chart);
    const box = await chart.boundingBox();
    if (!box) throw new Error('chart has no bounding box');
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5);
    await expect(snapshotCard(page)).toContainText('Price');
    await expect(snapshotCard(page)).toContainText('Fair Value');
    await expect(snapshotCard(page)).toContainText('vs Fair Value');
    const hoveredDate = (await snapshotDate(page).textContent())?.trim();
    expect(hoveredDate).toBeTruthy();
    await shootChart(page, chart, 'valuation-zones-hover-snapshot-card.png');

    // --- Keyboard scrub is hover-independent: ArrowLeft steps the snapshot card's date. ------
    await page.mouse.move(10, 10); // move the pointer well away so hover can't drive the cursor
    await chart.focus();
    const beforeKeyDate = (await snapshotDate(page).textContent())?.trim();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowLeft');
    const afterKeyDate = (await snapshotDate(page).textContent())?.trim();
    expect(afterKeyDate).toBeTruthy();
    expect(afterKeyDate).not.toBe(beforeKeyDate);

    // --- A price-moved-while-FV-flat window: still 3J, but scrubbed further left — into the
    // ~flat FY2023→FY2024 step (fair value ~$70.79 → ~$70.38, essentially unchanged) — where
    // the reconstructed Fair Value barely moves while the price keeps trading. ---------------
    await page.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.5);
    await expect(snapshotCard(page)).toContainText('Fair Value');
    await shootChart(page, chart, 'valuation-zones-price-moved-fv-flat.png');

    // Back to Max so every transition marker is on-screen for the click test below.
    await toolbar.getByRole('button', { name: 'Max', exact: true }).click();
    await expectSteppedZonesVisible(chart);

    // --- A specific historical date via scrub (captured for the record). --------------------
    await chart.focus();
    for (let i = 0; i < 40; i += 1) await page.keyboard.press('ArrowLeft');
    await expect(snapshotCard(page)).toContainText('Fair Value');
    await shootChart(page, chart, 'valuation-zones-historical-date-scrub.png');

    // --- Clicking a transition marker pins it and opens the Fundamentals → Models → Fair
    // Value → Zones detail. The LAST transition dot is AAPL's largest reconstructed jump
    // (FY2024 → FY2025, fair value roughly $70 → $119) — the "large transition" case. ---------
    const transitionDots = chart.locator(`svg circle[fill="${TRANSITION_DOT_FILL}"]`);
    const dotCount = await transitionDots.count();
    expect(dotCount).toBeGreaterThan(0);
    await transitionDots.nth(dotCount - 1).click({ force: true });

    await expect(snapshotCard(page)).toContainText('pinned');
    // Both the pinned snapshot card and the transition panel below it carry `border-azure/50`
    // — the panel is the LAST such element (it's appended as a sibling after the chart+card row).
    const panel = page.locator('div[class*="border-azure/50"]', { hasText: 'Fair Value' }).last();
    await expect(panel.getByText('Fundamentals')).toBeVisible();
    await expect(panel.getByText('Model outputs')).toBeVisible();
    await expect(panel.getByText('Result')).toBeVisible();
    await expect(panel.getByText('EPS (reconstructed)')).toBeVisible();
    await expect(panel.getByText('Graham Number')).toBeVisible();
    // Before → after arrows: every driver row renders "<before> → <after>".
    await expect(panel.getByText('→').first()).toBeVisible();
    await shootChart(page, chart, 'valuation-zones-large-transition-pinned.png');

    // Escape clears the pin.
    await chart.focus();
    await page.keyboard.press('Escape');
    await expect(snapshotCard(page)).not.toContainText('pinned');

    // --- Narrow viewport (390w) keeps price + Fair Value visible. ---------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(chart).toBeVisible();
    await expect(page.getByText(/Fair value/i).first()).toBeVisible();
    await shootChart(page, chart, 'valuation-zones-narrow-390.png');
  });

  test('no reconstructable history: "Historical valuation unavailable" caption, no zone fills', async ({ page }) => {
    // AAPL's own asset/quote/valuation/price-history endpoints stay real (all cache hits); we
    // override only the valuation-history endpoint, mirroring the existing fixture-stubbing
    // pattern (market-analysis.spec / forecast.spec) to produce the one state the live cache
    // can't hand us on demand: a valid current-day band with zero reconstructable snapshots.
    await page.route('**/research/valuation/history/AAPL', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ symbol: 'AAPL', currency: 'USD', coverageFrom: null, snapshots: [], note: 'stubbed: no history' }),
      }));

    const chart = await openValueAnalysis(page, 'AAPL');

    // No zone fills at all.
    const areas = zoneAreas(chart);
    for (const key of Object.keys(areas) as (keyof typeof areas)[]) {
      await expect(areas[key], `${key} zone area (should be absent)`).toHaveCount(0);
    }
    await expect(chart.locator(`svg path.recharts-line-curve[stroke="${FV_SPINE_STROKE}"]`)).toHaveCount(0);
    await expect(chart.locator(`svg circle[fill="${TRANSITION_DOT_FILL}"]`)).toHaveCount(0);

    // The honest caption appears both under the chart (italic legend line) and in the
    // snapshot card's default (no reconstructable data at all) state.
    await expect(page.getByText('Historical valuation unavailable', { exact: false }).first()).toBeVisible();
    await expect(snapshotCard(page)).toContainText('Historical valuation unavailable');

    // The price line itself still renders (this isn't the "no price data yet" placeholder).
    await expect(chart.locator(`svg path.recharts-line-curve[stroke="${ZONE_FILL.fair}"]`)).toHaveCount(1);

    await shootChart(page, chart, 'valuation-zones-no-data.png');
  });
});

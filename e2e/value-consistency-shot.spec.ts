import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Visual verification (not a regression guard): capture the Value-analysis headline card and
 * the "Price vs fair-value zones" chart for a normal Swiss name (SRAIL.SW), an ADR
 * (SNY, EUR-reporting/USD-trading) and the EUR ordinary (SAN.PA), to confirm the headline
 * verdict and the chart's current point now agree. All three are warm in the dev SQLite cache.
 */
const DIR = path.join(process.cwd(), 'e2e', 'screenshots');
fs.mkdirSync(DIR, { recursive: true });

async function openValueAnalysis(page: Page, symbol: string) {
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__app), null, { timeout: 30_000 });
  await page.evaluate((sym) => (window as any).__app.getState().researchSymbolView(sym), symbol);
  const heading = page.getByRole('heading', { name: 'Value analysis' });
  await expect(heading).toBeVisible({ timeout: 40_000 });
  const chart = page.getByRole('application', { name: /Kursverlauf/ });
  await expect(chart).toBeVisible({ timeout: 40_000 });
  return chart;
}

for (const symbol of ['SRAIL.SW', 'SNY', 'SAN.PA']) {
  test(`value-analysis consistency shot: ${symbol}`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1600 });
    const chart = await openValueAnalysis(page, symbol);

    // The headline "Fair value (est.)" card — badge + margin-of-safety / premium text.
    const card = page.getByText('Fair value (est.)').locator('xpath=ancestor::div[contains(@class,"card")][1]');
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: path.join(DIR, `consistency-${symbol.replace('.', '_')}-headline.png`) });

    // The chart with its zones / today marker.
    await chart.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400); // let recharts settle
    await chart.screenshot({ path: path.join(DIR, `consistency-${symbol.replace('.', '_')}-chart.png`) });
  });
}

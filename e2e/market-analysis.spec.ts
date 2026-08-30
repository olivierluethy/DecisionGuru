import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * "Market Analysis" competitor table:
 *  - autonomous discovery lists same-industry peers (EA, RBLX, …), not just the subject;
 *  - the table shows market-cap and return numbers;
 *  - each company row is clickable and navigates into Research for that symbol.
 *
 * The research endpoints are stubbed with captured fixtures so the test is deterministic
 * and independent of the rate-limited live provider. The app has no URL routing; we
 * deep-link via the dev-only store handle (window.__app, exposed in store.ts under
 * import.meta.env.DEV). Screenshots land in e2e/screenshots/.
 */
const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', name), 'utf-8');

test('Market Analysis fills the table and rows open Research', async ({ page }) => {
  await page.route('**/research/asset/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: fixture('asset-TTWO.json') }));
  await page.route('**/research/market/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: fixture('market-TTWO.json') }));

  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__app), null, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__app.getState().researchSymbolView('TTWO'));

  const heading = page.getByText('Comparable companies', { exact: false });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await heading.scrollIntoViewIfNeeded().catch(() => {});

  // Discovery: peers appear (EA) and the empty-state is gone.
  await expect(page.getByText('Electronic Arts', { exact: false })).toBeVisible();
  // Market cap shows a value (native-currency fallback when no FX rate → "$ …").
  await expect(page.getByText(/\$\s*\d/).first()).toBeVisible();
  // Returns and the vs-this-stock column are populated for peers (sign char may be − or -).
  await expect(page.getByText(/69\.6\s*%/).first()).toBeVisible(); // RBLX 1Y return
  await expect(page.getByText(/69\.8\s*%/).first()).toBeVisible(); // RBLX vs this stock

  await page.screenshot({ path: 'e2e/screenshots/ttwo-market-analysis.png', fullPage: true });

  // Company rows are clickable → navigate into Research for that symbol.
  await page.getByRole('button', { name: /Electronic Arts/ }).first().click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__app.getState().researchSymbol), { timeout: 10_000 })
    .toBe('EA');
  await expect
    .poll(() => page.evaluate(() => (window as any).__app.getState().view), { timeout: 10_000 })
    .toBe('research');
});

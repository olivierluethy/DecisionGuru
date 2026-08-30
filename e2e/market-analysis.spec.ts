import { test, expect } from '@playwright/test';

/**
 * Verifies the autonomous competitor discovery in "Market Analysis":
 * opening Take-Two Interactive (TTWO) should list same-industry peers
 * (Electronic Arts etc.), not just TTWO itself.
 *
 * The app has no URL routing; we deep-link via the dev-only store handle
 * (window.__app, exposed in store.ts under import.meta.env.DEV) straight to
 * the Research view for a symbol — avoiding the slow full-portfolio valuation
 * on the Overview. Screenshots land in e2e/screenshots/ for visual inspection.
 */
test('Market Analysis lists competitors for Take-Two (TTWO)', async ({ page }) => {
  await page.goto('/');
  // Deep-link Research → TTWO through the exposed store.
  await page.waitForFunction(() => Boolean((window as any).__app), null, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__app.getState().researchSymbolView('TTWO'));

  // The Market Analysis block renders a "Comparable companies" heading.
  const heading = page.getByText('Comparable companies', { exact: false });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  await heading.scrollIntoViewIfNeeded().catch(() => {});

  // First open may trigger an on-demand live fetch of peers; then a real peer
  // (Electronic Arts) must appear and the empty-state must be gone.
  await expect(page.getByText('No comparable companies with cached data yet', { exact: false }))
    .toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText(/\bEA\b/).first()).toBeVisible({ timeout: 60_000 });

  await heading.scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: 'e2e/screenshots/ttwo-market-analysis.png', fullPage: true });
});

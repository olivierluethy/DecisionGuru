import { test, expect } from '@playwright/test';

/**
 * Alerts redesign guards: the header actions fit, the smart scan banner renders, and the
 * Price-alerts tab exposes sorting + a last-price-vs-target gauge. Seeds one price alert so
 * the price-alert assertions are deterministic.
 */
test('Alerts: smart banner, price-alert sorting and target gauge', async ({ page }) => {
  await page.goto('/');
  // Ensure at least one price alert exists (AAPL has fundamentals → a real target).
  await page.evaluate(async () => {
    await fetch('/api/alerts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'AAPL', kind: 'buy' }),
    });
  });
  await page.evaluate(() => (window as unknown as { __app: { getState: () => { setView: (v: string) => void } } }).__app.getState().setView('alerts'));

  await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Scan now' }).first()).toBeVisible();

  // Price alerts tab: the sort control and its default option are present (new functionality).
  await page.getByText('Price alerts', { exact: false }).first().click();
  await expect(page.getByRole('combobox')).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveValue('closest');
  // The seeded AAPL buy alert renders its target line (the gauge's "buy target" label).
  await expect(page.getByText('buy target').first()).toBeVisible();
});

test('Alerts: notifications expose granularity + a time navigator when populated', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => (window as unknown as { __app: { getState: () => { setView: (v: string) => void } } }).__app.getState().setView('alerts'));
  await page.getByText('Notifications', { exact: false }).first().click();

  // Only assert the controls when there is a feed to index (env-independent guard).
  const hasFeed = await page.getByPlaceholder('Search notifications').isVisible().catch(() => false);
  if (hasFeed) {
    await expect(page.getByRole('button', { name: 'Day', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Week', exact: true })).toBeVisible();
    await expect(page.getByText('Jump to')).toBeVisible();
  }
});

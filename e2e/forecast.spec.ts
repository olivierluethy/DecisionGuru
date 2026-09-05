import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Forecasts view (issue #8, "Motivationshebel"):
 *  - the motivation lever shows the per-day cost of inaction, projected to a week/month;
 *  - "Today" lists the immediate actions (deploy cash, sell → reinvest);
 *  - the timeline renders dated predicted events, including a just-happened news entry;
 *  - a Sell action opens the plan builder pre-filled with the reinvest target.
 *
 * The /api/forecast endpoint is stubbed with a captured fixture so the test is deterministic
 * and independent of imported holdings / the live provider. We deep-link via the dev-only
 * store handle (window.__app), the same as the market-analysis spec.
 */
const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', name), 'utf-8');

test('Forecasts shows the motivation lever, today actions and the timeline', async ({ page }) => {
  await page.route('**/api/forecast**', (route) =>
    route.fulfill({ contentType: 'application/json', body: fixture('forecast.json') }));

  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__app), null, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__app.getState().setView('forecasts'));

  // Header + the motivation lever with the per-day cost and its week/month projection.
  await expect(page.getByRole('heading', { name: 'Forecasts' })).toBeVisible();
  await expect(page.getByText('Cost of doing nothing')).toBeVisible();
  await expect(page.getByText(/8\.12\s*\/\s*day/i).first()).toBeVisible();
  await expect(page.getByText('A week of waiting')).toBeVisible();
  await expect(page.getByText('A month of waiting')).toBeVisible();

  // Today section lists the two actions (deploy cash + a sell, each with an "Add to plan").
  await expect(page.getByText(/Today · 2 to act on/)).toBeVisible();
  await expect(page.getByText('Trades in the sell zone', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/8\.12\/day/)).toBeVisible();
  await expect(page.getByText(/3.200 behind so far/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add to plan' })).toHaveCount(2);

  // Timeline: the just-happened news entry and a predicted sell.
  await expect(page.getByText('Timeline · next 30 days')).toBeVisible();
  await expect(page.getByText('just happened')).toBeVisible();
  await expect(page.getByText('Tesla jumps on record quarterly deliveries').first()).toBeVisible();
  await expect(page.getByText('Tomorrow').first()).toBeVisible();

  await page.screenshot({ path: 'e2e/screenshots/forecasts.png', fullPage: true });

  // A Sell action opens the plan builder pre-filled with the reinvest target.
  await page.getByRole('button', { name: 'Add to plan' }).last().click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__app.getState().modal?.kind), { timeout: 10_000 })
    .toBe('create-plan');
});

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Proves the persisted React Query cache: after a full reload with the network
 * blocked, previously-loaded values must still paint (from IndexedDB) instead of
 * showing an all-from-scratch spinner.
 */
const fixture = (name: string) =>
  readFileSync(path.join(process.cwd(), 'e2e', 'fixtures', name), 'utf-8');

const okJson = (body: string) => ({ contentType: 'application/json', body });

test('reload paints persisted values with the network blocked', async ({ page }) => {
  await page.route('**/research/asset/**', (r) => r.fulfill(okJson(fixture('asset-TTWO.json'))));
  await page.route('**/research/market/**', (r) => r.fulfill(okJson(fixture('market-TTWO.json'))));

  // First visit: load TTWO's Market Analysis so the cache fills and persists.
  await page.goto('/');
  await page.waitForFunction(() => Boolean((window as any).__app), null, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__app.getState().researchSymbolView('TTWO'));
  await expect(page.getByText('Electronic Arts', { exact: false })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1500); // let the persister flush to IndexedDB (throttleTime 1s)

  // Reload with the research endpoints blocked — anything visible now came from cache.
  await page.unroute('**/research/asset/**');
  await page.unroute('**/research/market/**');
  await page.route('**/research/asset/**', (r) => r.abort());
  await page.route('**/research/market/**', (r) => r.abort());

  await page.reload();
  await page.waitForFunction(() => Boolean((window as any).__app), null, { timeout: 30_000 });
  await page.evaluate(() => (window as any).__app.getState().researchSymbolView('TTWO'));

  // Rehydrated from IndexedDB despite the aborted network calls.
  await expect(page.getByText('Electronic Arts', { exact: false })).toBeVisible({ timeout: 15_000 });
});

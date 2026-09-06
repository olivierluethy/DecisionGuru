import { test, expect } from '@playwright/test';

/**
 * Regression guard for the Research navigation bug: after opening a company you could not
 * get back to it once you started a new search, and the sidebar "Research" nav never
 * returned you to the search landing. The fix adds a "Recently viewed" memory and makes the
 * sidebar's Research item land on the search page (keeping recents) instead of re-showing
 * the last company.
 */

// A stock that is warm in the dev backend's SQLite cache.
const SYMBOL = 'AAPL';

test.describe('Research navigation', () => {
  test('New search keeps the last company under "Recently viewed"', async ({ page }) => {
    await page.goto(`/#/research/${SYMBOL}`);
    // The asset view is up (the symbol appears as the page heading).
    await expect(page.getByRole('heading', { name: SYMBOL, exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New search' }).click();

    // Landing is shown, and the just-left company is still one click away (the old bug lost it).
    await expect(page.getByText('Recently viewed')).toBeVisible();
    await expect(
      page.getByRole('button', { name: SYMBOL, exact: true }),
    ).toBeVisible();

    // And it actually navigates back.
    await page.getByRole('button', { name: SYMBOL, exact: true }).click();
    await expect(page.getByRole('heading', { name: SYMBOL, exact: true })).toBeVisible();
  });

  test('sidebar "Research" opens the search landing but keeps recents', async ({ page }) => {
    await page.goto(`/#/research/${SYMBOL}`);
    await expect(page.getByRole('heading', { name: SYMBOL, exact: true })).toBeVisible();

    // Clicking the sidebar nav item must return to the search landing, not re-show the company.
    await page.getByRole('button', { name: 'Research', exact: true }).click();

    await expect(page.getByText('Find an asset')).toBeVisible();
    // The company heading is gone (we're on the landing) …
    await expect(page.getByRole('heading', { name: SYMBOL, exact: true })).toHaveCount(0);
    // … but still reachable via a recent chip.
    await expect(page.getByText('Recently viewed')).toBeVisible();
    await expect(page.getByRole('button', { name: SYMBOL, exact: true })).toBeVisible();
  });
});

import { test, expect } from '@playwright/test';

/**
 * The "Compare" feature must be usable without any holdings. It now has a mode toggle:
 * "Holdings vs ETF" (the counterfactual, needs owned positions) and "Securities" (a
 * price-based comparison of arbitrary symbols via the universal-compare engine, no holdings
 * required). This guards the holdings-independent entry path.
 */
test('Compare opens in a securities mode that needs no holdings', async ({ page }) => {
  await page.goto('/');
  // Open the compare modal with no pre-selected holdings (as the sidebar "Comparison" does).
  await page.evaluate(() =>
    (window as unknown as { __app: { getState: () => { openModal: (m: unknown) => void } } })
      .__app.getState()
      .openModal({ kind: 'compare', instrumentIds: [] }),
  );

  // Switch to the securities comparison (available regardless of holdings).
  await page.getByRole('button', { name: 'Securities', exact: true }).click();

  // The securities UI is holdings-independent: it asks for symbols, not holdings.
  await expect(page.getByText('Securities to compare (add two or more)')).toBeVisible();
  await expect(page.getByText('Compare any stocks / ETFs on price — no holdings needed.')).toBeVisible();
  // With a single default selection it prompts for a second — never a "pick a holding" dead end.
  await expect(page.getByText('Add at least two securities to compare.')).toBeVisible();

  await page.screenshot({ path: 'e2e/screenshots/compare-securities-mode.png', fullPage: false });
});

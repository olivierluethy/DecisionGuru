import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E for DecisionGuru. `webServer` boots the full dev stack
 * (`npm run dev` → uvicorn :5178 + vite :5173) and reuses an already-running one.
 * Run: `npm run test:e2e` (headless) · `npm run test:e2e:headed` · `npm run e2e:report`.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: undefined } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});

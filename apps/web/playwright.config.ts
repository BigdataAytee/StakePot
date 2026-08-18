import { defineConfig } from '@playwright/test';

/**
 * §5.1 step 14's end-to-end journeys.
 *
 * Runs against an already-started stack (web on :3000, api on :3001) rather
 * than booting one itself: the journeys are about the product, and the stack
 * they run against should be the same one everything else was verified on.
 *
 *   pnpm --filter @stakeam/web exec playwright test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // The journeys share one database and build on each other's state within a
  // file, so files run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    baseURL: process.env['WEB_URL'] ?? 'http://localhost:3000',
    // The container's Chromium; never downloaded at install time.
    launchOptions: { executablePath: process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium' },
    screenshot: 'only-on-failure',
  },
});

import { existsSync } from 'node:fs';

import { defineConfig } from '@playwright/test';

/**
 * §5.1 step 14's end-to-end journeys.
 *
 * Runs against an already-started stack (web on :3000, api on :3001) rather
 * than booting one itself: the journeys are about the product, and the stack
 * they run against should be the same one everything else was verified on.
 *
 *   pnpm --filter @stakeam/web exec playwright test
 *
 * The browser is whichever one the machine already has. This container ships
 * Chromium at a fixed path and forbids downloading another; a CI runner has
 * none until `playwright install` puts one where Playwright looks by itself.
 * Pinning the container's path unconditionally would break CI, so the path is
 * only supplied when something is actually there.
 */
const chromium = process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';
const havePinnedChromium = existsSync(chromium);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // The journeys share one database and build on each other's state within a
  // file, so files run one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env['WEB_URL'] ?? 'http://localhost:3000',
    ...(havePinnedChromium ? { launchOptions: { executablePath: chromium } } : {}),
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});

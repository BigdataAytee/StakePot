import { execSync } from 'node:child_process';

import { expect, test } from '@playwright/test';

/**
 * §5.1 step 14's end-to-end user journeys, in the browser the users get.
 *
 * One story, told in order: a person signs up, finds a market, stakes with a
 * reason, and their take appears on the thread wearing the position they just
 * opened. Then the surfaces around it — the leaderboard, a challenge link for
 * somebody with no account, the offline shell's manifest.
 *
 * The stack is expected to be running (web :3000, api :3001, Postgres, Redis).
 * The market fixture is written straight into Postgres, because official
 * markets open through an admin's click on an AI draft and community markets
 * need the model's screen — neither of which is what these journeys test.
 */
const API = process.env['API_URL'] ?? 'http://localhost:3001';
const DB =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://stakeam:stakeam@localhost:5432/stakeam_test';

const stamp = Date.now();
let marketId: string;
let yesOutcomeId: string;

function sql(statement: string): string {
  // Fed through stdin so nothing needs shell-quoting.
  return execSync(`psql "${DB}" -tA -f -`, { input: statement }).toString().trim();
}

async function api<T>(path: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} responded ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

test.beforeAll(() => {
  /*
   * Clear this machine's auth rate-limit budget first.
   *
   * These journeys sign up fresh accounts, which is the shape §11's limiter
   * refuses. Per project rather than per file: desktop and phone in one job
   * double the signups from one address, and CI failed exactly that way when
   * the phone viewport was added. The limiter is asserted in
   * walkthrough.spec.ts, so this resets a budget rather than disabling a check.
   */
  try {
    execSync('redis-cli --scan --pattern "rl:auth:*" | xargs -r redis-cli del', {
      stdio: 'ignore',
    });
  } catch {
    // No redis-cli here: the run is then subject to the real budget.
  }

  marketId = `e2e-market-${stamp}`;
  yesOutcomeId = `e2e-yes-${stamp}`;
  const noId = `e2e-no-${stamp}`;
  const eventDate = new Date(Date.now() + 12 * 86_400_000).toISOString();
  const voidDate = new Date(Date.now() + 19 * 86_400_000).toISOString();

  sql(
    `INSERT INTO markets (id, shelf, question, "sourceName", "sourceUrl", "criteriaJson", "edgeCasesJson", "eventDate", "voidDate", "liquidityParam", "feeBps", state, "activationPath", "potTotal", "createdAt") ` +
      `VALUES ('${marketId}', 'official', 'Will the Super Eagles beat Ghana in the e2e qualifier?', 'CAF', 'https://www.cafonline.com/', '{}', '{}', '${eventDate}', '${voidDate}', 50000, 700, 'active', 'organic', 0, NOW())`,
  );
  sql(
    `INSERT INTO outcomes (id, "marketId", label, ordinal, "sharesOutstanding", "priceCurrent", "stakedTotal", "isOther") VALUES ` +
      `('${yesOutcomeId}', '${marketId}', 'Yes', 0, 0, 0.5, 0, false), ` +
      `('${noId}', '${marketId}', 'No', 1, 0, 0.5, 0, false)`,
  );
});

test('a new user signs up, stakes with a reason, and their badge lands on the thread', async ({
  page,
}) => {
  // Signup and verification happen through the API — the app has no signup UI
  // yet (a known gap, tracked in the addendum), and this journey is about
  // everything after the token exists.
  const account = await api<{ accessToken: string; userId: string }>('/auth/signup', {
    email: `journey${stamp}@example.com`,
    password: 'correct-horse-battery',
    ageAttested: true,
  });
  sql(`UPDATE users SET tier = 1, "contactVerified" = true WHERE id = '${account.userId}'`);

  await page.addInitScript((token) => {
    window.localStorage.setItem('stakeam.token', String(token));
  }, account.accessToken);

  // The ticket renders with real prices and the thread below it.
  await page.goto(`/market/${marketId}`);
  await expect(page.getByRole('heading', { name: /Super Eagles beat Ghana/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /takes/i })).toBeVisible();

  // Open the trade ticket, stake, and leave the one-line why.
  await page.getByRole('button', { name: /Buy Yes/i }).click();
  await page.locator('input[inputmode="decimal"]').fill('2000');
  await page
    .getByPlaceholder('One line. It goes on the thread with your position.')
    .fill('Osimhen is back, that changes everything');
  await page.getByRole('button', { name: 'Stake am' }).click();

  // The trade filled and the reason arrived on the thread wearing the badge —
  // §2.15a's whole design, observed from the outside.
  await page.goto(`/market/${marketId}`);
  await expect(page.getByText('Osimhen is back, that changes everything')).toBeVisible();
  await expect(page.getByText(/YES@\d+/)).toBeVisible();
});

test('the leaderboard renders and explains itself to a signed-out visitor', async ({ page }) => {
  await page.goto('/leaderboard');
  await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
  await expect(page.getByText(/markets that have settled/)).toBeVisible();
  // Board and period controls exist even when the board is empty.
  await expect(page.getByRole('button', { name: 'Accuracy' })).toBeVisible();
});

test('a challenge link lands a signed-out recipient on the argument', async ({ page }) => {
  // Mint the challenge as the staker from the first journey.
  const challenger = await api<{ accessToken: string; userId: string }>('/auth/signup', {
    email: `challenger${stamp}@example.com`,
    password: 'correct-horse-battery',
    ageAttested: true,
  });
  sql(`UPDATE users SET tier = 1, "contactVerified" = true WHERE id = '${challenger.userId}'`);
  await api(
    '/trades',
    {
      marketId,
      outcomeId: yesOutcomeId,
      side: 'buy',
      amount: '1500',
      requestId: `e2e-chal-${stamp}`,
    },
    challenger.accessToken,
  );
  const challenge = await api<{ token: string }>(
    `/markets/${marketId}/challenge`,
    {},
    challenger.accessToken,
  );

  // A fresh context with no token — the person §2.15d is written for.
  await page.goto(`/challenge/${challenge.token}`);
  await expect(page.getByText(/says/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Prove them wrong' })).toBeVisible();
});

test('the app shell is installable', async ({ page }) => {
  await page.goto('/');
  const manifest = page.locator('link[rel="manifest"]');
  await expect(manifest).toHaveAttribute('href', '/manifest.json');

  const response = await page.request.get('/manifest.json');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { name: string; display: string };
  expect(body.name).toBe('StakeAm');
  expect(body.display).toBe('standalone');
});

import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page, type TestInfo } from '@playwright/test';

import { resetAuthBudget } from './redis';
import { enterStake, submitStake } from './trade';

/**
 * The whole product, in order, in the browser a user gets — and a screenshot of
 * every step in `docs/walkthrough/`.
 *
 * This is not a unit test wearing a browser: it is the walkthrough that finds
 * the things unit tests structurally cannot — a number that renders as NaN, a
 * fee that is charged but never shown, a page that is unreachable because
 * nothing links to it. Each step asserts the one fact that would make the step
 * a lie if it were false, and photographs the result.
 *
 * Needs the stack up (web :3000, api :3001, Postgres, Redis) and the
 * walkthrough fixtures loaded:
 *
 *   ./scripts/dev/ensure-services.sh
 *   psql "$TEST_DATABASE_URL" -f scripts/dev/seed-walkthrough.sql
 */
const API = process.env['API_URL'] ?? 'http://localhost:3001';
const DB =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://stakeam:stakeam@localhost:5432/stakeam_test';
const SHOTS = join(process.cwd(), '..', '..', 'docs', 'walkthrough');

const stamp = Date.now();
const email = `walk${stamp}@example.com`;
const password = 'correct-horse-battery';

let shot = 0;

/**
 * Photograph the step, into a folder per viewport.
 *
 * Per project because the two runs would otherwise overwrite each other, and
 * the phone screenshots are the ones that answer §5's "full market runs on a
 * phone" — they are worth keeping beside the desktop set, not instead of it.
 */
async function capture(page: Page, name: string, info: TestInfo): Promise<void> {
  shot += 1;
  await page.screenshot({
    path: join(SHOTS, info.project.name, `${String(shot).padStart(2, '0')}-${name}.png`),
    fullPage: true,
    // Settle first. Caught mid-transition, the shelf chips photographed with
    // two of them part-green, which reads as two selected shelves — a
    // documentation image that says something the product does not.
    animations: 'disabled',
  });
}

function sql(statement: string): string {
  return execSync(`psql "${DB}" -tA -f -`, { input: statement }).toString().trim();
}

mkdirSync(SHOTS, { recursive: true });

/**
 * Load the catalogue fixtures.
 *
 * Self-seeding rather than relying on a prior command: the API's integration
 * suite resets this same database, so "I seeded it earlier" is only true until
 * somebody runs `pnpm test`. Re-applying is cheap and the script is idempotent
 * (it deletes its own rows first).
 */
execSync(
  `psql "${DB}" -q -f ${join(process.cwd(), '..', '..', 'scripts', 'dev', 'seed-walkthrough.sql')}`,
);

// One story in order, so the run shares a browser and a session.
test.describe.configure({ mode: 'serial' });

test.describe('the walkthrough', () => {
  // §11's limiter counts signups and logins per IP, and this suite does both
  // by the dozen from one address. Reset per project: two projects in one job
  // share the address, and the second would otherwise meet a budget the first
  // had spent — which is how CI first went red on the phone viewport.
  test.beforeAll(async () => {
    await resetAuthBudget();

    // Clear this viewport's numbered shots before writing new ones.
    //
    // The names carry a step number, so inserting a step renumbers everything
    // after it and the previous run's files are left behind under their old
    // numbers. Three generations had piled up: fifty files in a folder that
    // holds twenty-two, several of them photographs of screens as they were two
    // changes ago. The README claims these images cannot drift from a passing
    // suite — that is only true if the run owns the folder.
    //
    // Numbered files only: `auth-*.png` belongs to auth-screens.spec.ts, which
    // runs before this one and whose work must survive.
    // `test.info()` rather than a hook argument: Playwright insists the first
    // parameter be an object-destructuring pattern, and an empty one is what
    // the lint rules reject. The project name is available either way.
    const folder = join(SHOTS, test.info().project.name);
    mkdirSync(folder, { recursive: true });
    for (const file of readdirSync(folder)) {
      if (/^\d+-.*\.png$/.test(file)) rmSync(join(folder, file));
    }
  });

  test('1 · the front door is the product, not a brochure about it', async ({ page }, testInfo) => {
    await page.goto('/');

    // What a stranger gets in the first screenful: a way to search, the topics,
    // and live questions at live prices. The explaining lives in the footer and
    // the rules, where somebody who wants it goes looking.
    await expect(page.getByRole('searchbox', { name: /search markets/i })).toBeVisible();
    // Scoped to the category row: "Trending" is also the name of the default
    // sort pill, so an unscoped match finds two links and fails on strictness
    // rather than on the page being wrong.
    await expect(
      page.getByRole('navigation', { name: 'Categories' }).getByRole('link', { name: /Trending/ }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Sign up/i })).toBeVisible();

    // At least one real market, and a percentage next to it — the thirty-second
    // explanation §7.6 asks for, delivered by the markets rather than by prose.
    const questions = page.getByRole('article');
    await expect(questions.first()).toBeVisible();
    await expect(page.getByText(/%/).first()).toBeVisible();

    await capture(page, 'landing', testInfo);
  });

  test('2 · signup takes a contact, a password and an age attestation', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    await page.getByRole('link', { name: /^Sign up$/i }).click();
    await expect(page).toHaveURL(/\/signup/);

    await page.getByLabel('Email or phone').fill(email);
    // Exact: the field's accessible name is "Password" and the reveal button's
    // is "Show password", so a loose match catches both.
    await page.getByLabel('Password', { exact: true }).fill(password);
    await capture(page, 'signup', testInfo);

    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Create account' }).click();

    // Tier 0 lands in the markets with money to spend, and nothing on the way
    // in asks it to prove a contact.
    await expect(page).toHaveURL(/localhost:3000\/?$/, { timeout: 15_000 });
    await expect(page.getByRole('link', { name: /your balance/i })).toBeVisible();
    await expect(page.getByText(/verify/i)).toHaveCount(0);
    await capture(page, 'markets-tier0', testInfo);

    // The screen still exists for anyone who goes looking; it is just never
    // put in front of them.
    await page.goto('/verify');
    await expect(page.getByRole('heading', { name: /Confirm your contact/i })).toBeVisible();
    await capture(page, 'verify-prompt', testInfo);
  });

  test('3 · the code verifies the contact and pays the Tier 1 bonus', async ({
    page,
  }, testInfo) => {
    // Sign in as the account from step 2 and read the code the API actually
    // sent — out of the notification it wrote, not out of a test backdoor.
    const token = await signIn(page, email, password);
    await page.goto('/verify');

    const code = await waitForCode(email);
    await page.getByLabel('Six-digit code').fill(code);
    await capture(page, 'verify-code', testInfo);
    await page.getByRole('button', { name: 'Verify' }).click();

    await expect(page).toHaveURL(/localhost:3000\/?$/, { timeout: 15_000 });

    // Starter balance plus the verification bonus, visible in the header.
    const me = await get<{ tier: number; available: string }>('/auth/me', token);
    expect(me.tier).toBe(1);
    expect(Number(me.available)).toBe(15_000);
    await expect(page.getByRole('link', { name: /your balance/i })).toBeVisible();
    await expect(page.getByText('₦15k').first()).toBeVisible();
    await capture(page, 'markets-signed-in', testInfo);
  });

  test('4 · both shelves are on the board, and switchable', async ({ page }, testInfo) => {
    await signIn(page, email, password);
    await page.goto('/');
    await expect(page.getByText(/naira close below/i)).toBeVisible();
    await expect(page.getByText(/BBNaija eviction/i)).toBeVisible();
    await capture(page, 'shelves', testInfo);

    // The shelf lives on the board's pill row now. `/markets` was a second,
    // worse copy of this screen — headed sections of the same cards — and it
    // 301s here, so the filtering it carried is asserted where it actually is.
    const shelf = page.getByRole('group', { name: 'Shelf' });

    // Community alone.
    await shelf.getByRole('link', { name: /^Community/ }).click();
    await expect(page).toHaveURL(/shelf=community/);
    await expect(page.getByText(/BBNaija eviction/i)).toBeVisible();
    await expect(page.getByText(/naira close below/i)).toHaveCount(0);
    await capture(page, 'shelf-community', testInfo);

    // Official alone.
    await shelf.getByRole('link', { name: /^Official/ }).click();
    await expect(page).toHaveURL(/shelf=official/);
    await expect(page.getByText(/naira close below/i)).toBeVisible();
    await expect(page.getByText(/BBNaija eviction/i)).toHaveCount(0);

    // And back to everything. The choice is in the URL, so it can be linked and
    // survives a reload.
    await shelf.getByRole('link', { name: /^All/ }).click();
    await expect(page.getByText(/naira close below/i)).toBeVisible();
    await expect(page.getByText(/BBNaija eviction/i)).toBeVisible();
  });

  test('4b · the shelf chips carry counts and are reachable with a thumb', async ({ page }) => {
    await signIn(page, email, password);
    await page.goto('/');

    const chips = page.getByRole('group', { name: 'Shelf' }).getByRole('link');
    await expect(chips).toHaveCount(3);

    // A count is what makes an empty shelf answerable without tapping into it.
    for (const chip of await chips.all()) {
      await expect(chip).toHaveText(/\d+$/);
      const box = await chip.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
    }

    // Deep-linkable, and the selected chip says so to a screen reader.
    await page.goto('/?shelf=community');
    await expect(
      page.getByRole('group', { name: 'Shelf' }).getByRole('link', { name: /^Community/ }),
    ).toHaveAttribute('aria-current', 'true');

    // A shelf name that means nothing falls back to showing everything rather
    // than to an empty screen.
    await page.goto('/?shelf=nonsense');
    await expect(page.getByText(/naira close below/i)).toBeVisible();
    await expect(page.getByText(/BBNaija eviction/i)).toBeVisible();
  });

  test('5 · the ticket shows the chart, the argument bar and the money', async ({
    page,
  }, testInfo) => {
    await signIn(page, email, password);
    await page.goto('/market/wt-naira');
    await expect(page.getByRole('heading', { name: /naira close below/i })).toBeVisible();
    // Exact, because the risk line above the trade button now ends "…paid from
    // the pot" and a substring match finds both. The quote strip's cell label
    // is the thing this assertion is actually about.
    await expect(page.getByText('Pot', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Buy Yes/i })).toBeVisible();
    await capture(page, 'ticket', testInfo);
  });

  test('6 · buying opens a position and moves the price', async ({ page }, testInfo) => {
    const token = await signIn(page, email, password);
    await page.goto('/market/wt-naira');

    await enterStake(page, { amount: '2000' });
    await capture(page, 'trade-sheet-buy', testInfo);
    await submitStake(page);

    await expect
      .poll(async () => (await get<unknown[]>('/me/positions', token)).length, {
        timeout: 20_000,
      })
      .toBeGreaterThan(0);

    // A fill reloads the ticket, so wait for that to settle rather than racing
    // it with a navigation of our own.
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Your position' })).toBeVisible({
      timeout: 15_000,
    });
    await capture(page, 'position-open', testInfo);
  });

  test('7 · selling early shows the exit fee before it is charged', async ({ page }, testInfo) => {
    const token = await signIn(page, email, password);
    await page.goto('/market/wt-naira');

    await page.getByRole('button', { name: /Sell/i }).first().click();
    await page.locator('#trade-amount').fill('500');

    // §2.3's early-exit fee, itemised *inside the sheet* where the commitment
    // is made. Scoped to the dialog deliberately: an earlier version of this
    // assertion matched the position panel's prose above and passed while the
    // sheet quoted gross proceeds under the words "You receive".
    // The sheet's figure rows are a <dl> of dt/dd pairs; read each dd by its dt
    // so the assertion survives styling changes.
    const money = async (label: string | RegExp): Promise<number> => {
      const row = page.locator('div').filter({ has: page.getByText(label, { exact: false }) });
      const text = await row.last().locator('dd').last().innerText();
      return Number.parseFloat(text.replace(/[^0-9.]/g, ''));
    };

    await expect(page.getByText(/Early-exit fee/i)).toBeVisible();
    await expect(page.getByText('Proceeds', { exact: true })).toBeVisible();
    await expect(page.getByText('You receive', { exact: true })).toBeVisible();

    const gross = await money('Proceeds');
    const fee = await money(/Early-exit fee/i);
    const net = await money('You receive');

    // The arithmetic is the platform's, not decoration: net is proceeds less
    // the fee, to the kobo.
    expect(gross).toBeGreaterThan(0);
    expect(fee).toBeGreaterThan(0);
    expect(Math.abs(gross - fee - net)).toBeLessThan(0.02);

    await capture(page, 'trade-sheet-sell-fee', testInfo);

    const before = await get<{ available: string }>('/auth/me', token);
    await page
      .getByRole('button', { name: /Sell|Cash out/i })
      .last()
      .click();
    await expect
      .poll(async () => (await get<{ available: string }>('/auth/me', token)).available, {
        timeout: 20_000,
      })
      .not.toBe(before.available);
    await capture(page, 'after-sell', testInfo);
  });

  test('7b · the context panel answers what this market is, under one frame', async ({
    page,
  }, testInfo) => {
    await page.goto('/market/wt-naira');

    // Rules leads, because it is the tab that changes whether to trade at all.
    await expect(page.getByRole('tab', { name: 'Rules' })).toHaveAttribute('aria-selected', 'true');
    // The settlement source, and — the part every reference leaves out — how
    // often anybody actually reads it.
    //
    // Asserted on the clause that holds whether or not the research pipeline
    // has found a figure for this market. The first version matched copy that
    // only appeared in the no-reading branch, so the test passed on an empty
    // database and failed the moment the panel had something to show.
    await expect(page.getByText(/Read at settlement, not continuously/)).toBeVisible();

    await page.getByRole('tab', { name: /^News/ }).click();
    await expect(page.getByText(/CBN resumes dollar sales/)).toBeVisible();
    await expect(page.getByText(/Pinned by/).first()).toBeVisible();

    await page.getByRole('tab', { name: 'Stats' }).click();
    // Lifetime, not the last day: a market that opened ten days ago has an
    // opening price, and the panel has to have gone and got it.
    await expect(page.getByRole('columnheader', { name: 'Opened' })).toBeVisible();
    await expect(page.getByText('Biggest move')).toBeVisible();

    // Placed after the buy and the sell rather than beside the ticket's other
    // assertions, and deliberately: an activity feed with nothing in it proves
    // only that the tab renders. By here this account has bought and sold, so
    // the feed has something to be right or wrong about.
    await page.getByRole('tab', { name: 'Activity' }).click();
    await expect(page.getByText(/shown under a code, not a name/)).toBeVisible();
    // `.first()`: the two Playwright projects share a database, so by the phone
    // run the same fixture market carries the desktop run's sells as well.
    await expect(page.getByText('sold').first()).toBeVisible();

    await capture(page, 'context-panel', testInfo);
  });

  test('8 · the wallet history agrees with the ledger', async ({ page }, testInfo) => {
    const token = await signIn(page, email, password);
    await page.goto('/wallet');

    await expect(page.getByRole('heading', { name: 'Wallet' })).toBeVisible();
    await expect(page.getByText('Available', { exact: true })).toBeVisible();
    await expect(page.getByText('In open markets', { exact: true })).toBeVisible();
    // The events actually performed above, each named for what it was — the
    // two bonuses are distinct rows, not two lines both reading "Bonus".
    // The first row waits for the history fetch; the rest are already there
    // once it has landed.
    await expect(page.getByText('Starter balance').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Verification bonus').first()).toBeVisible();
    await expect(page.getByText('Stake').first()).toBeVisible();

    const rows = await get<{ amount: string }[]>('/me/wallet/history', token);
    const sum = rows.reduce((total, row) => total + Number(row.amount), 0);
    const me = await get<{ available: string }>('/auth/me', token);
    // The history is the balance: every available-fund movement, nothing else.
    expect(Math.abs(sum - Number(me.available))).toBeLessThan(0.000001);
    await capture(page, 'wallet-history', testInfo);
  });

  test('9 · the leaderboard explains itself', async ({ page }, testInfo) => {
    await signIn(page, email, password);
    await page.goto('/leaderboard');
    await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
    await capture(page, 'leaderboard', testInfo);
  });

  test('10 · the rules page is reachable and says how money moves', async ({ page }, testInfo) => {
    await page.goto('/rules');
    await expect(page.getByRole('heading', { name: 'The rules' })).toBeVisible();
    await expect(page.getByText(/held in escrow/i).first()).toBeVisible();
    await capture(page, 'rules', testInfo);
  });

  test('12 · the creation wizard renders, and refuses honestly when review is down', async ({
    page,
  }, testInfo) => {
    await signIn(page, email, password);
    await page.goto('/create');
    await expect(page.getByRole('heading', { name: 'Talk your own' })).toBeVisible({
      timeout: 15_000,
    });
    // The co-pilot and the reviewer both need the question engine, which has no
    // key in this environment — so the wizard is walked as far as it goes here,
    // and the create → fund → resolve arc for a *community* market is proven at
    // the API level in the integration suite until staging has a key.
    await capture(page, 'create-wizard', testInfo);
  });

  test('13 · settling a market pays the winners and writes their receipt', async ({
    page,
  }, testInfo) => {
    // A market of this run's own, so the step is repeatable: settlement is a
    // one-way door, and re-running against an already-resolved market proves
    // nothing.
    const settleId = `wt-settle-${stamp}`;
    const yes = `${settleId}-yes`;
    sql(
      `INSERT INTO markets (id, shelf, question, "sourceName", "sourceUrl", "criteriaJson", "edgeCasesJson", "eventDate", "voidDate", "liquidityParam", "feeBps", state, "activationPath", "potTotal", "createdAt") ` +
        `VALUES ('${settleId}', 'official', 'Will this walkthrough market settle cleanly?', 'CAF', 'https://www.cafonline.com/', '{}', '{}', NOW() + interval '2 days', NOW() + interval '9 days', 50000, 700, 'active', 'organic', 0, NOW());` +
        `INSERT INTO outcomes (id, "marketId", label, ordinal, "sharesOutstanding", "priceCurrent", "stakedTotal", "isOther") VALUES ` +
        `('${yes}', '${settleId}', 'Yes', 0, 0, 0.5, 0, false), ` +
        `('${settleId}-no', '${settleId}', 'No', 1, 0, 0.5, 0, false)`,
    );

    const token = await signIn(page, email, password);
    const before = Number((await get<{ available: string }>('/auth/me', token)).available);

    await post('/trades', token, {
      marketId: settleId,
      outcomeId: yes,
      side: 'buy',
      amount: '1000',
      requestId: `wt-settle-${stamp}-buy`,
    });

    // Resolution is a two-person, staff-only path (§2.10): whoever proposes a
    // result never finalises it.
    const [proposer, finaliser] = await Promise.all([
      staffAccount(`resolver1-${stamp}@stakeam.ng`, 'resolver'),
      staffAccount(`admin1-${stamp}@stakeam.ng`, 'admin'),
    ]);

    await post(`/admin/markets/${settleId}/resolution/propose`, proposer, {
      outcomeId: yes,
      evidenceUrl: 'https://www.cafonline.com/match/12345',
    });

    // Wind the dispute window back rather than waiting two days for it. The
    // window itself is real and enforced — finalising before it closes is
    // refused, which is why this line exists at all.
    sql(
      `UPDATE markets SET "disputeClosesAt" = NOW() - interval '1 minute' WHERE id = '${settleId}'`,
    );

    await post(`/admin/markets/${settleId}/resolution/finalize`, finaliser, {
      outcomeId: yes,
      reasoning: 'The source published the result; this outcome is the one it names.',
    });

    // The trader's side of it: paid from the pot, and the payout is on the
    // wallet history as winnings.
    const after = Number((await get<{ available: string }>('/auth/me', token)).available);
    expect(after).toBeGreaterThan(before - 1000);

    const history = await get<{ type: string }[]>('/me/wallet/history', token);
    expect(history.some((row) => row.type === 'payout')).toBe(true);

    await page.goto(`/market/${settleId}`);
    await expect(page.getByText(/settled/i).first()).toBeVisible({ timeout: 15_000 });
    await capture(page, 'market-settled', testInfo);

    await page.goto('/wallet');
    // "Returns on settlement", not "Winnings" — the wallet labels a settled
    // position by what it is rather than by what a betting shop would call it.
    await expect(page.getByText('Returns on settlement').first()).toBeVisible();
    await capture(page, 'wallet-after-settlement', testInfo);
  });

  test('14 · the leaderboard counts the settled market', async ({ page }, testInfo) => {
    await signIn(page, email, password);
    await page.goto('/leaderboard');
    // Boards are built from settled markets only, so one existing is the
    // precondition for the board meaning anything at all.
    await expect(page.getByRole('heading', { name: 'Leaderboard' })).toBeVisible();
    await capture(page, 'leaderboard-after-settlement', testInfo);
  });

  test('11 · the auth rate limit refuses a burst, in words a person can act on', async ({
    request,
  }, info) => {
    // Once, not once per viewport: this asserts an API control, which has no
    // opinion about screen size — and the burst deliberately spends the whole
    // per-IP budget, so running it twice would starve the other project.
    test.skip(info.project.name !== 'desktop', 'API-level control; viewport-independent');

    // §11: "Rate limiting per user/IP". Fired straight at the API because this
    // is about the control, not the screen — and asserted on the message as
    // well as the status, since a limiter that says "Error 429" to somebody who
    // mistyped a password twice is a support ticket waiting to happen.
    let refusal: { status: number; message: string } | null = null;

    for (let attempt = 0; attempt < 40 && refusal === null; attempt += 1) {
      const response = await request.post(`${API}/auth/login`, {
        data: { contact: `burst${attempt}@example.com`, password: 'wrong-password' },
        failOnStatusCode: false,
      });
      if (response.status() === 429) {
        const body = (await response.json()) as { message: string };
        refusal = { status: response.status(), message: body.message };
      }
    }

    expect(refusal).not.toBeNull();
    expect(refusal?.message).toMatch(/too many/i);
  });
});

/**
 * Put the session token where the app looks for it.
 *
 * Logged in once and cached for the run, because a person signs in once and
 * because §11's auth rate limit is real: a login per step trips it, which is
 * the limiter doing its job and the walkthrough misusing it.
 */
let cachedToken: string | null = null;

async function signIn(page: Page, contact: string, secret: string): Promise<string> {
  if (cachedToken === null) {
    const response = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contact, password: secret }),
    });
    if (!response.ok) throw new Error(`login failed: ${await response.text()}`);
    cachedToken = ((await response.json()) as { accessToken: string }).accessToken;
  }

  const token = cachedToken;
  await page.addInitScript((value) => {
    window.localStorage.setItem('stakeam.token', String(value));
  }, token);
  return token;
}

async function get<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${path} responded ${response.status}`);
  return (await response.json()) as T;
}

/**
 * Read the verification code out of the notification the API wrote.
 *
 * The code is never returned by the endpoint that sends it, so this is how a
 * test gets one without the API growing a development backdoor.
 */
async function waitForCode(contact: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const body = sql(
      `SELECT "payloadJson"->>'body' FROM notifications n
         JOIN users u ON u.id = n."userId"
        WHERE n.type = 'contact_verification' AND u.email = '${contact}'
        ORDER BY n."createdAt" DESC LIMIT 1`,
    );
    const match = /\b(\d{6})\b/.exec(body);
    if (match?.[1] !== undefined) return match[1];
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('no verification code was ever sent');
}

/** Create an account through the API and promote it to a staff role in the DB. */
async function staffAccount(contact: string, role: string): Promise<string> {
  const response = await fetch(`${API}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: contact, password: 'correct-horse-battery', ageAttested: true }),
  });
  if (!response.ok) throw new Error(`staff signup failed: ${await response.text()}`);
  const { accessToken, userId } = (await response.json()) as {
    accessToken: string;
    userId: string;
  };
  // Roles are not self-serve, so the fixture grants them the way an
  // administrator would — directly, and never through an API surface.
  sql(
    `UPDATE users SET role = '${role}', tier = 1, "contactVerified" = true WHERE id = '${userId}'`,
  );
  // The role lives in the token, so it has to be minted after the promotion.
  const relogin = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contact, password: 'correct-horse-battery' }),
  });
  if (!relogin.ok) return accessToken;
  return ((await relogin.json()) as { accessToken: string }).accessToken;
}

async function post(path: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`${path} responded ${response.status}: ${await response.text()}`);
  return response.json();
}

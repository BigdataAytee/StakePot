import { expect, test, type Page } from '@playwright/test';

import { resetAuthBudget } from './redis';

/**
 * The three screens standing between a stranger and an account, checked at
 * whatever viewport the project runs at.
 *
 * These exist because "it renders" is not the same as "a thumb can use it".
 * Every assertion below corresponds to something that was wrong when the
 * screens were first looked at on a phone: a 16px checkbox gating the only
 * button, no way back, no way to see what you had typed, and a password field
 * you could only fill blind.
 */
const stamp = Date.now();

test.beforeAll(async () => {
  await resetAuthBudget();
});

/** Everything a finger has to hit must clear the 44px it needs to hit it. */
async function tapTargetsAreReachable(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const tooSmall: string[] = [];
    for (const element of document.querySelectorAll('button, input[type="checkbox"]')) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      // A checkbox is allowed to be small if its label row is the real target,
      // which is how a well-built one works — so measure the label instead.
      const target =
        element instanceof HTMLInputElement && element.type === 'checkbox'
          ? (element.closest('label') ?? element)
          : element;
      const rect = target.getBoundingClientRect();
      if (rect.height < 44) {
        tooSmall.push(
          `${element.tagName} "${(element.textContent ?? '').trim()}" ${rect.height}px`,
        );
      }
    }
    return tooSmall;
  });
}

test.describe('the auth screens', () => {
  test('signup is usable with a thumb and says where you are', async ({ page }) => {
    await page.goto('/signup');

    // Branding and a way back: the form used to be anonymous, which on a phone
    // arriving from a shared link means a password box belonging to nobody.
    await expect(page.getByRole('link', { name: /StakeAm/ })).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
    expect(await tapTargetsAreReachable(page)).toEqual([]);

    // Nothing scrolls sideways — the commonest way a mobile layout is broken.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(overflows).toBe(false);
  });

  test('the age gate can be ticked by tapping the row, not just the box', async ({ page }) => {
    await page.goto('/signup');
    const box = page.getByRole('checkbox');
    await expect(box).not.toBeChecked();

    // Tap the words, which is where a thumb lands.
    await page.getByText('I am 18 or older').click();
    await expect(box).toBeChecked();
  });

  test('the password can be revealed before it is submitted', async ({ page }) => {
    await page.goto('/signup');
    // Exact, and it must be exact: the accessible name is "Password" and
    // nothing else, which is the point of binding the label by id rather than
    // wrapping the toggle button inside it.
    const field = page.getByLabel('Password', { exact: true });
    await field.fill('correct-horse-battery');

    await expect(field).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(field).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(field).toHaveAttribute('type', 'password');
  });

  test('a whole signup goes through from the phone-sized screen', async ({ page }) => {
    await page.goto('/signup');
    await page.getByLabel('Email or phone').fill(`mobile${stamp}@example.com`);
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
    await page.getByText('I am 18 or older').click();
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/verify/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: /Confirm your contact/i })).toBeVisible();
  });

  test('login is reachable, usable, and admits it cannot reset a password yet', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    expect(await tapTargetsAreReachable(page)).toEqual([]);

    // §2.18's recovery flow does not exist. Saying so beats a dead link on the
    // one screen where somebody is already stuck.
    await expect(page.getByText(/Forgotten your password/i)).toBeVisible();

    // And the two screens link to each other, so neither is a dead end.
    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(page).toHaveURL(/\/signup/);
    await page.getByRole('link', { name: 'Log in' }).click();
    await expect(page).toHaveURL(/\/login/);
  });
});

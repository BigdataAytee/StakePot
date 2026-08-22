import { expect, type Page } from '@playwright/test';

/**
 * Staking on a market detail page, from the outside, on either screen.
 *
 * The page deliberately offers two different surfaces for the same act, and a
 * journey that knows about only one of them tests half the product:
 *
 *   * At 860px and up the right column holds the trade panel. The amount is
 *     `#panel-amount`, the reason sits under it, and "Buy Yes" is the button
 *     that *commits* — it is disabled until there is an amount to commit.
 *   * Below 860px there is no right column. A pinned bar carries "Buy Yes" as
 *     the button that *opens* the bottom sheet, and the amount, reason and
 *     "Place trade" live inside it.
 *
 * The same accessible name therefore means "submit this" on a laptop and
 * "start this" on a phone, which is what made the desktop journeys sit on a
 * disabled button until they timed out. These helpers pick the surface that is
 * actually on screen rather than assuming either one.
 */

const PANEL_AMOUNT = '#panel-amount';
const SHEET_AMOUNT = '#trade-amount';

/** The panel's reason field, and the sheet's. Same prompt, different words. */
const PANEL_REASON = 'Why? One line, optional.';
const SHEET_REASON = 'One line. It goes on the thread with your position.';

/**
 * Which surface this viewport is showing. Waits for one of them to arrive.
 *
 * Keyed off the panel being rendered rather than off a "Buy" button existing:
 * signed out, the panel's primary action reads "Sign in to stake", so a wait
 * for `/^Buy /` waits forever on the exact journey that most needs testing.
 */
async function surface(page: Page): Promise<'panel' | 'sheet'> {
  await page.locator('aside[aria-label^="Trade "]').first().waitFor({ state: 'attached' });
  return (await page.locator(PANEL_AMOUNT).isVisible()) ? 'panel' : 'sheet';
}

/**
 * Open whatever needs opening and fill in the stake, stopping short of
 * committing it so a caller can screenshot or assert on the quote first.
 */
export async function enterStake(
  page: Page,
  { amount, reason }: { amount: string; reason?: string },
): Promise<void> {
  if ((await surface(page)) === 'panel') {
    await page.locator(PANEL_AMOUNT).fill(amount);
    if (reason !== undefined) await page.getByPlaceholder(PANEL_REASON).fill(reason);
    return;
  }

  await page.getByRole('button', { name: /^Buy /i }).first().click();
  await page.locator(SHEET_AMOUNT).fill(amount);
  if (reason !== undefined) await page.getByPlaceholder(SHEET_REASON).fill(reason);
}

/** Commit it. */
export async function submitStake(page: Page): Promise<void> {
  if (await page.locator(SHEET_AMOUNT).isVisible()) {
    await page.getByRole('button', { name: 'Place trade' }).click();
    return;
  }
  await page.getByRole('button', { name: /^Buy /i }).first().click();
}

/**
 * Wait for the fill to be *confirmed*, not merely sent.
 *
 * Navigating on the click abandons an in-flight submit, which measures the
 * test's own timing rather than the product. The sheet closes when the trade
 * confirms; the panel stays put and empties its fields instead, so each
 * surface is waited on for the thing it actually does.
 */
export async function stakeConfirmed(page: Page, timeout = 30_000): Promise<void> {
  // The sheet first, because on a laptop both can be on screen at once — the
  // panel sits in the right column while a sheet opened from a card or from a
  // returning sign-in covers it. The panel's field is empty either way, so
  // checking it first would pass instantly and prove nothing.
  if (await page.locator(SHEET_AMOUNT).isVisible()) {
    await expect(page.locator(SHEET_AMOUNT)).toBeHidden({ timeout });
    return;
  }
  await expect(page.locator(PANEL_AMOUNT)).toHaveValue('', { timeout });
}

/**
 * Whichever of the two surfaces is on screen — see `surface` above.
 *
 * Decided by which amount field is *visible*, not by which element carries the
 * label. Both surfaces are in the DOM on both viewports — the panel is hidden
 * with `display:none` below 860px, the sheet simply is not mounted until it
 * opens — and a label query matches hidden elements happily, so asking for the
 * label alone finds two and fails on strictness.
 */
async function tradeSurface(page: Page) {
  return (await page.locator(SHEET_AMOUNT).isVisible())
    ? page.getByRole('dialog')
    : page.locator('aside[aria-label^="Trade "]');
}

/**
 * Take the sign-in route out of a trade, from either surface.
 *
 * Scoped rather than page-wide because the prompt and the button exist in both
 * the panel and the sheet, and a bare `getByText` matches whichever is merely
 * in the DOM as readily as the one the person is looking at.
 */
export async function signInFromTrade(page: Page): Promise<void> {
  const scope = await tradeSurface(page);
  await expect(scope.getByText(/You need an account to stake/)).toBeVisible();
  await scope.getByRole('button', { name: 'Sign in to stake' }).click();
}

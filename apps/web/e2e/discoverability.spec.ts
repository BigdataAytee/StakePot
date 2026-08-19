import { expect, test } from '@playwright/test';

/**
 * The parts of a website that are not the product.
 *
 * Robots, a sitemap, unique titles, the pages that answer a question before
 * somebody stakes, a 404 that is not a dead end, and a link preview that says
 * what the link is. None of it shows up in a feature demo and all of it decides
 * whether anybody arrives.
 *
 * Asserted rather than eyeballed because these fail silently: a missing
 * `<title>`, a sitemap that 500s, a page nothing links to — the app looks
 * perfect and the front door is shut.
 */
test.describe('discoverability', () => {
  test('every public page names itself in its title', async ({ page }) => {
    const pages: [string, RegExp][] = [
      ['/', /StakeAm/],
      ['/leaderboard', /^Leaderboard · StakeAm$/],
      ['/rules', /^Rules · StakeAm$/],
      ['/faq', /^FAQ · StakeAm$/],
      ['/privacy', /^Privacy · StakeAm$/],
      ['/support', /^Support · StakeAm$/],
      ['/login', /^Log in · StakeAm$/],
      ['/signup', /^Create an account · StakeAm$/],
    ];

    const seen = new Set<string>();
    for (const [path, pattern] of pages) {
      await page.goto(path);
      await expect(page).toHaveTitle(pattern);

      // A description a search result can show, and a distinct one — nine
      // pages sharing a blurb is nine pages competing to be the same result.
      const description = await page.locator('meta[name="description"]').getAttribute('content');
      expect(description ?? '', `${path} has no description`).not.toHaveLength(0);
      expect(seen.has(description ?? ''), `${path} reuses another page's description`).toBe(false);
      seen.add(description ?? '');
    }
  });

  test('robots.txt points at the sitemap and closes the private routes', async ({ page }) => {
    const response = await page.request.get('/robots.txt');
    expect(response.ok()).toBe(true);
    const body = await response.text();

    expect(body).toMatch(/Sitemap:\s*http/);
    // One person's money, staff tooling, and single-use tokens: indexing a
    // challenge link publishes it.
    for (const path of ['/admin', '/account', '/wallet', '/studio', '/challenge']) {
      expect(body, `${path} is not disallowed`).toContain(`Disallow: ${path}`);
    }
  });

  test('the sitemap lists the pages and the markets themselves', async ({ page }) => {
    const response = await page.request.get('/sitemap.xml');
    expect(response.ok()).toBe(true);
    const body = await response.text();

    for (const path of ['/leaderboard', '/faq', '/privacy', '/rules']) {
      expect(body, `${path} missing from the sitemap`).toContain(`${path}</loc>`);
    }
    // A market is what somebody actually searches for. Listing only the shelf
    // hides every question behind it.
    expect(body).toMatch(/\/market\/[^<]+<\/loc>/);
  });

  test('a bad URL gets a way out rather than a dead end', async ({ page }) => {
    const response = await page.goto('/this-page-does-not-exist');
    expect(response?.status()).toBe(404);

    await expect(page.getByRole('heading', { name: /nothing here/i })).toBeVisible();
    await page.getByRole('link', { name: 'Open markets' }).click();
    // The board is the front page now — `/markets` was a second copy of it and
    // 301s here.
    await expect(page).toHaveURL(/localhost:3000\/?$/);
  });

  test('the legal and help pages are reachable without typing a URL', async ({ page }) => {
    // They existed and nothing linked to them, which is the same as not
    // existing. The footer is the fix, so the footer is what is checked.
    await page.goto('/');
    const footer = page.getByRole('navigation', { name: 'Site' });

    await footer.getByRole('link', { name: 'FAQ' }).click();
    await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Site' })
      .getByRole('link', { name: 'Privacy' })
      .click();
    await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Site' })
      .getByRole('link', { name: 'Rules' })
      .click();
    await expect(page.getByRole('heading', { name: 'The rules' })).toBeVisible();
  });

  test('the FAQ answers are readable by a machine as well as a person', async ({ page }) => {
    await page.goto('/faq');

    const raw = await page.locator('script[type="application/ld+json"]').innerText();
    const data = JSON.parse(raw) as {
      '@type': string;
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };

    expect(data['@type']).toBe('FAQPage');
    expect(data.mainEntity.length).toBeGreaterThan(5);

    // The markup and the visible list come from one array, so every question in
    // the structured data has to be on the page.
    for (const entry of data.mainEntity) {
      await expect(page.getByText(entry.name, { exact: true })).toBeVisible();
    }
  });

  test('a shared market link previews as the question, with an image that has alt text', async ({
    page,
  }) => {
    await page.goto('/');
    const first = page.locator('a[href^="/market/"]').first();
    await expect(first).toBeVisible();
    await first.click();
    await expect(page).toHaveURL(/\/market\//);

    // The title is the question, not the product name — this is the link that
    // gets pasted into a group chat.
    const title = await page.title();
    expect(title).not.toMatch(/^StakeAm/);
    expect(title).toContain('StakeAm');

    const image = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(image ?? '').toContain('/api/share/');

    // A preview is a picture of a question and a number. Somebody who cannot
    // see it is owed the same sentence.
    const alt = await page.locator('meta[property="og:image:alt"]').getAttribute('content');
    expect(alt ?? '').not.toHaveLength(0);
  });
});

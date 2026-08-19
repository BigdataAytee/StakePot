import type { MetadataRoute } from 'next';

import { api } from '@/lib/api';
import { SITE_URL } from '@/lib/site';

/**
 * Every page worth finding, including the markets themselves.
 *
 * The static pages are the front door and the ones that answer a question
 * before somebody stakes. The markets are listed individually because each one
 * is a real page about a real question — "will the naira close below ₦1,500?"
 * is what a person searches for, and a sitemap listing only `/markets` hides
 * every one of them behind a shelf.
 *
 * Regenerated per request rather than at build time: markets open and settle
 * daily, and a sitemap baked into an image is a list of yesterday's.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATIC: {
  path: string;
  priority: number;
  frequency: MetadataRoute.Sitemap[number]['changeFrequency'];
}[] = [
  { path: '', priority: 1, frequency: 'hourly' },
  { path: '/markets', priority: 0.9, frequency: 'hourly' },
  { path: '/leaderboard', priority: 0.7, frequency: 'daily' },
  { path: '/rules', priority: 0.6, frequency: 'monthly' },
  { path: '/faq', priority: 0.6, frequency: 'monthly' },
  { path: '/privacy', priority: 0.4, frequency: 'monthly' },
  { path: '/support', priority: 0.4, frequency: 'monthly' },
  { path: '/status', priority: 0.3, frequency: 'daily' },
  { path: '/signup', priority: 0.5, frequency: 'monthly' },
  { path: '/login', priority: 0.3, frequency: 'monthly' },
];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const pages: MetadataRoute.Sitemap = STATIC.map(({ path, priority, frequency }) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency: frequency,
    priority,
  }));

  // Best-effort: a sitemap is worth having with the static pages alone, and an
  // API that is briefly down must not turn it into a 500.
  try {
    const markets = await api.markets();
    for (const market of markets) {
      pages.push({
        url: `${SITE_URL}/market/${market.id}`,
        lastModified: now,
        changeFrequency: 'hourly',
        priority: 0.8,
      });
    }
  } catch {
    // Static pages only this time round.
  }

  return pages;
}

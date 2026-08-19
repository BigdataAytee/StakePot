import type { MetadataRoute } from 'next';

import { SITE_URL } from '@/lib/site';

/**
 * What a crawler may read.
 *
 * Everything public is open, because the whole product is a public argument
 * about what will happen and it is no use if nobody can find it. What is closed
 * is closed for a reason, not out of caution:
 *
 *   /admin, /studio   staff and creator tooling; authenticated, and nothing a
 *                     search result should ever land somebody on
 *   /account, /wallet one person's money
 *   /verify           a screen that only means anything mid-signup
 *   /challenge, /c    single-use tokens — indexing one publishes it
 *   /api, /version    machine surfaces, and /version answers "what is running"
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/admin',
        '/studio',
        '/account',
        '/wallet',
        '/verify',
        '/challenge',
        '/c',
        '/api',
        '/version',
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}

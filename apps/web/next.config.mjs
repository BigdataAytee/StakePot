import withSerwistInit from '@serwist/next';
import createNextIntlPlugin from 'next-intl/plugin';

// Localisation scaffolding without locale routing — see src/i18n/request.ts for
// why the app is not behind `/[locale]/` yet.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// The offline shell (§5.1, step 12). Disabled in development so a stale worker
// cannot serve yesterday's bundle while somebody is editing the app.
const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output keeps the runtime image small — see apps/web/Dockerfile.
  output: 'standalone',
  // The monorepo root, so tracing picks up the workspace's node_modules.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  experimental: {
    optimizePackageImports: ['lucide-react', 'date-fns'],
  },
  /**
   * `/markets` was a second, worse copy of the front page.
   *
   * The board of open questions is the landing page — that is the whole
   * argument for not putting a brochure there — so a separate "all markets"
   * screen listed the same cards with a different toolbar, and the footer link
   * to it invited people to leave the page they were already on. 301 rather
   * than a soft redirect because the URL is in the sitemap and has been linked:
   * the move is permanent and search engines should be told so once.
   */
  async redirects() {
    return [{ source: '/markets', destination: '/', statusCode: 301 }];
  },
};

export default withSerwist(withNextIntl(nextConfig));

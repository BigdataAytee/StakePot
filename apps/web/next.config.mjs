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
};

export default withSerwist(withNextIntl(nextConfig));

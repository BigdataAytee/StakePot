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

export default nextConfig;

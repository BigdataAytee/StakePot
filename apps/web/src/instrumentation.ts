/**
 * Sentry is wired but inert until a DSN is present, so local and CI runs stay
 * quiet and no build step depends on an auth token.
 */
export async function register(): Promise<void> {
  const dsn = process.env['NEXT_PUBLIC_SENTRY_DSN'] ?? process.env['SENTRY_DSN'];
  if (dsn === undefined || dsn.length === 0) return;

  if (process.env['NEXT_RUNTIME'] === 'nodejs' || process.env['NEXT_RUNTIME'] === 'edge') {
    const Sentry = await import('@sentry/nextjs');
    Sentry.init({
      dsn,
      environment: process.env['NODE_ENV'],
      tracesSampleRate: 0.1,
    });
  }
}

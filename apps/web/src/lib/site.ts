/**
 * The site's own origin.
 *
 * Needed by anything that has to emit an absolute URL — the sitemap, robots,
 * and every Open Graph tag, none of which can be relative. Next resolves
 * `metadataBase` from this too.
 *
 * Inlined at build time like every `NEXT_PUBLIC_*` value, so it is set as a
 * build argument in the Docker image rather than at runtime. Wrong here, and
 * shared links point somewhere that is not this site while every page still
 * renders — the same failure mode `NEXT_PUBLIC_API_URL` had.
 */
export const SITE_URL = (process.env['NEXT_PUBLIC_SITE_URL'] ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

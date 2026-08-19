import localFont from 'next/font/local';

/**
 * Open Sauce, the one typeface on the site.
 *
 * The files are the four weights lifted out of docs/design-reference.html,
 * which is the authority on how this product looks. They are served from our
 * own origin rather than fetched from a font CDN — the reference embeds them
 * for the same reason, and on a Nigerian mobile connection a blocking request
 * to a third-party host is the difference between text at 400ms and text at
 * two seconds.
 *
 * `swap` so the fallback renders immediately and is replaced in place; the
 * fallback stack is the reference's own (Inter, then whatever the system calls
 * its UI face), so the substitution costs a weight change rather than a
 * reflow of the whole page.
 */
export const openSauce = localFont({
  src: [
    { path: '../fonts/OpenSauce-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/OpenSauce-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/OpenSauce-600.woff2', weight: '600', style: 'normal' },
    { path: '../fonts/OpenSauce-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-sauce',
  display: 'swap',
  // Written out rather than referenced: the font loader is a compile-time
  // transform and only accepts literals here.
  fallback: ['Inter', 'system-ui', 'sans-serif'],
});

/**
 * The same face again, under the name the figures ask for.
 *
 * The reference sets prices, pots and percentages in Open Sauce like
 * everything else — there is no second typeface in this system. The variable
 * exists so that `font-mono`, which ~180 places already use to mean "this is a
 * live number", keeps meaning that: the preset points it here and pairs it
 * with tabular numerals, so a ticking price still holds its column without any
 * of those files needing to change.
 */
export const openSauceNumeric = openSauce;

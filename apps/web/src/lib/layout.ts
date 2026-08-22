/**
 * How wide the page is allowed to get.
 *
 * The reference pins this at 1200px, which is right for a laptop and wrong for
 * a 27" monitor: the grid stops at three columns and the content becomes a
 * narrow strip with a third of the screen empty either side — a phone-shaped
 * page on a desktop. So the cap grows in two steps, and because the grid is
 * `auto-fill minmax(300px, 1fr)` the extra width becomes more columns on its
 * own.
 *
 * A plain class string rather than a CSS custom property injected through the
 * Tailwind plugin: that was tried, and `addBase` did not emit the declaration,
 * so every container silently lost its `max-width` and ran full-bleed. This
 * cannot fail that way — the utilities either exist in the stylesheet or the
 * build does not compile.
 *
 * Every container on the site imports this. They have to agree, or the header,
 * the tabs, the grid and the footer visibly misalign against each other.
 */
export const PAGE_WIDTH =
  'mx-auto w-full max-w-[1200px] min-[1400px]:max-w-[1400px] min-[1800px]:max-w-[1600px]';

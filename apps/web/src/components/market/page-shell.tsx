'use client';

import { Suspense } from 'react';

import { MobileNav } from '@/components/market/mobile-nav';
import { SiteHeader } from '@/components/market/site-header';
import { PAGE_WIDTH } from '@/lib/layout';

/**
 * The frame every screen that is not the market grid sits in.
 *
 * Before this existed, each secondary screen carried its own header decision
 * and its own container width: the wizard had no header at all, the studio had
 * a different one, and the wallet had a third. That is the "second visual
 * style" problem — not a wrong colour anywhere, but four pages that each
 * decided independently what a page is. There is one answer now and it lives
 * here, so a new screen gets it by importing rather than by remembering.
 *
 * It also owns the suspense boundaries. `SiteHeader` and `MobileNav` both read
 * the query string, and a page that renders either one outside a boundary
 * cannot be prerendered — `next build` fails on it while the dev server stays
 * perfectly happy. Putting the boundaries here means a screen cannot get that
 * wrong by forgetting, which is exactly how the wallet got it wrong.
 *
 * `pb-[72px]` on the main clears the phone nav; `md:pb-10` gives it back on a
 * laptop where there is no nav to clear.
 */
export function PageShell({
  children,
  /** Extra classes for the `<main>` — padding overrides, mostly. */
  className = '',
  /**
   * How wide the body runs. `wide` is the catalogue width the header and grid
   * share; `narrow` is for reading and for forms, where a 1200px line length
   * is simply unusable. Not a class override, because two competing
   * `max-w-*` utilities resolve by stylesheet order and the loser is
   * whichever Tailwind happened to emit second.
   */
  width = 'wide',
  /** Set false on screens that should not offer the phone nav. */
  nav = true,
}: {
  children: React.ReactNode;
  className?: string;
  width?: 'wide' | 'narrow';
  nav?: boolean;
}) {
  return (
    <>
      <Suspense fallback={<div className="h-[60px] border-b border-border" />}>
        <SiteHeader />
      </Suspense>

      <main
        className={`px-4 pb-[72px] pt-5 sm:px-5 md:pb-10 ${
          width === 'wide' ? PAGE_WIDTH : 'mx-auto w-full max-w-[760px]'
        } ${className}`}
      >
        {children}
      </main>

      {nav && (
        <Suspense>
          <MobileNav />
        </Suspense>
      )}
    </>
  );
}

/**
 * A screen's title block. One `h1`, one line saying what the screen is for.
 *
 * Separate from `PageShell` because some screens replace their whole body —
 * the wizard's sent-for-review state — while keeping the frame.
 */
export function PageTitle({ title, blurb }: { title: string; blurb?: string }) {
  return (
    <header className="mb-5">
      <h1 className="text-xl font-bold leading-tight">{title}</h1>
      {blurb !== undefined && <p className="mt-1.5 text-base text-text-muted">{blurb}</p>}
    </header>
  );
}

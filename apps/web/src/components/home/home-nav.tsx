'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { money } from '@/lib/format';
import { useSession } from '@/lib/session';

/**
 * The bar across the top of the front page.
 *
 * Three jobs in one row: say whose site this is, let somebody find a question,
 * and say where they stand. On a phone the search sits on its own line below
 * the wordmark, because a 44px tap target and a wordmark do not both fit in
 * 360px and shrinking the search is the same as removing it.
 *
 * The balance is in the bar for signed-in visitors for the same reason it is in
 * the app header: a person deciding whether to stake ₦2,000 should never have
 * to leave the question to find out whether they can.
 */
export function HomeNav() {
  const params = useSearchParams();
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(params.get('q') ?? '');
  const { me, loading } = useSession();

  // The URL is the source of truth for the query — a back button that leaves
  // the box full of a search the page is no longer showing is a lie about
  // what is on screen.
  useEffect(() => {
    setQuery(params.get('q') ?? '');
  }, [params]);

  // "/" focuses search, the way every list-shaped site works. Ignored while
  // the caret is already in a field, or somebody typing a slash into their
  // question loses it.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      input.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams(params.toString());
    if (query.trim() === '') next.delete('q');
    else next.set('q', query.trim());
    // A new search starts at the top of the list, not on page four of the old one.
    next.delete('topic');
    router.push(next.toString() === '' ? '/' : `/?${next.toString()}`);
  }

  return (
    <div className="sticky top-0 z-40 border-b border-border bg-surface/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1350px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 md:min-h-[68px] md:flex-nowrap">
        <Link href="/" className="text-xl font-black leading-none tracking-tight">
          Stake<span className="text-rise">Am</span>
        </Link>

        <form
          role="search"
          onSubmit={submit}
          className="relative order-last w-full md:order-none md:mx-2 md:max-w-md md:flex-1"
        >
          <label htmlFor="market-search" className="sr-only">
            Search markets
          </label>
          <MagnifierIcon className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
          <input
            id="market-search"
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            placeholder="Search markets…"
            className="h-10 w-full rounded-md border border-border bg-surface pl-10 pr-11 text-sm outline-none placeholder:text-text-muted focus:border-rise"
          />
          <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-sm border border-border px-1.5 py-0.5 font-mono text-xs text-text-muted md:block">
            /
          </kbd>
        </form>

        <nav aria-label="Account" className="ml-auto flex shrink-0 items-center gap-3">
          {loading ? (
            // A skeleton rather than nothing, so the row does not jump when the
            // session resolves a beat after the markets have painted.
            <span className="h-9 w-28 animate-pulse rounded-md bg-text/5" aria-hidden />
          ) : me === null ? (
            <>
              <Link href="/login" className="hidden text-sm font-bold hover:underline sm:block">
                Log in
              </Link>
              <Link
                href="/signup"
                className="rounded-md bg-rise px-3.5 py-2 text-sm font-black text-paper transition-transform active:scale-press"
              >
                Sign up
              </Link>
            </>
          ) : (
            <>
              <Link href="/wallet" className="text-right leading-tight">
                <span className="block font-mono text-[11px] text-text-muted">Balance</span>
                <span className="block font-mono text-sm font-black tabular-nums text-money">
                  {money(me.available)}
                </span>
              </Link>
              <Link
                href="/markets"
                className="hidden rounded-md border border-border px-3 py-2 text-sm font-bold hover:border-rise sm:block"
              >
                Portfolio
              </Link>
            </>
          )}
        </nav>
      </div>
    </div>
  );
}

export function MagnifierIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden className={className}>
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.8" />
      <path d="m13.5 13.5 3.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { money } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useLiveMode } from '@/store/live-mode';

/**
 * The bar across the top of every market screen.
 *
 * Four things in one 60px row, in the reference's order: whose site this is, a
 * way to find a question, whether the prices are moving, and what you have to
 * spend. Nothing else earns a place there — everything else on the site is one
 * of those four things away.
 */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-surface/[.94] backdrop-blur-[8px]">
      <div className="mx-auto flex h-[60px] max-w-[1200px] items-center gap-[14px] px-5">
        <Logo />
        <SearchField />
        <div className="flex-1" />
        <LiveSwitch />
        <CashChip />
      </div>
    </header>
  );
}

function Logo() {
  return (
    <Link
      href="/"
      className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[17px] font-bold tracking-[-.02em]"
    >
      <svg viewBox="0 0 24 24" className="size-[22px]" aria-hidden>
        <rect x="2" y="2" width="20" height="20" rx="4" className="fill-text" />
        <path
          d="M7 17V7l5 6 5-6v10"
          className="stroke-surface"
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      StakeAm
    </Link>
  );
}

/**
 * Search, which filters the real catalogue rather than a client-side copy.
 *
 * The query lives in the URL so a search is a link somebody can send, and so
 * the grid stays on the server. Submitting rather than filtering per keystroke
 * is deliberate: each change is a round trip, and a request per character is a
 * request per character.
 */
function SearchField() {
  const params = useSearchParams();
  const router = useRouter();
  const [value, setValue] = useState(params.get('q') ?? '');

  // The URL is the truth: a back button that leaves the box holding a search
  // the page is no longer showing is a lie about what is on screen.
  useEffect(() => {
    setValue(params.get('q') ?? '');
  }, [params]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams(params.toString());
    const trimmed = value.trim();
    if (trimmed === '') next.delete('q');
    else next.set('q', trimmed);
    // A new search starts from the whole catalogue, not inside the last filter.
    next.delete('cat');
    router.push(next.toString() === '' ? '/' : `/?${next.toString()}`);
  }

  return (
    <form role="search" onSubmit={submit} className="relative max-w-[440px] flex-1">
      <label htmlFor="market-search" className="sr-only">
        Search markets
      </label>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="2"
        aria-hidden
        className="pointer-events-none absolute left-[11px] top-[10px] size-[17px] stroke-text-muted"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-4-4" />
      </svg>
      <input
        id="market-search"
        type="search"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Search markets"
        className="h-[38px] w-full rounded-lg border border-border bg-chip pl-9 pr-3 text-base outline-none placeholder:text-text-muted focus:border-brand focus:bg-surface"
      />
    </form>
  );
}

/**
 * The switch that decides whether the numbers move.
 *
 * It does not fade a simulation in and out — it subscribes to and unsubscribes
 * from the price stream, so switching it off stops the traffic rather than
 * hiding it. That matters on the connections this is built for.
 */
function LiveSwitch() {
  const live = useLiveMode((state) => state.live);
  const ready = useLiveMode((state) => state.ready);
  const setLive = useLiveMode((state) => state.set);
  const hydrate = useLiveMode((state) => state.hydrate);

  // Read the stored choice after mount. Reading it during render would make
  // the first client paint disagree with the server's.
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const on = ready && live;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => setLive(!live)}
      title={on ? 'Live prices are on' : 'Prices are held still'}
      className={`flex shrink-0 select-none items-center gap-[7px] whitespace-nowrap text-sm font-semibold ${
        on ? 'text-rise' : 'text-text-muted'
      }`}
    >
      <span
        className={`relative h-[19px] w-[34px] rounded-xl transition-colors duration-toggle ${
          on ? 'bg-rise' : 'bg-[#cfd6de]'
        }`}
      >
        <span
          className={`absolute top-[2px] size-[15px] rounded-full bg-paper shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-[left] duration-toggle ${
            on ? 'left-[17px]' : 'left-[2px]'
          }`}
        />
      </span>
      <span className="hidden sm:inline">Live</span>
    </button>
  );
}

/** What you have to spend, and a way to the wallet that holds it. */
function CashChip() {
  const { me, loading } = useSession();

  if (loading) {
    return (
      <span className="h-[34px] w-[76px] shrink-0 animate-pulse rounded-md bg-chip" aria-hidden />
    );
  }

  if (me === null) {
    return (
      <div className="flex shrink-0 items-center gap-3">
        <Link href="/login" className="hidden text-base font-semibold hover:underline sm:block">
          Log in
        </Link>
        <Link
          href="/signup"
          className="rounded-md bg-brand px-3 py-2 text-base font-bold text-paper transition-transform active:scale-press"
        >
          Sign up
        </Link>
      </div>
    );
  }

  return (
    <Link
      href="/wallet"
      className="flex shrink-0 flex-col items-end rounded-md px-2 py-1 leading-[1.15] hover:bg-chip"
    >
      <span className="font-mono text-base font-bold text-money">{money(me.available)}</span>
      <span className="hidden text-[10px] font-medium text-text-muted sm:block">Balance</span>
    </Link>
  );
}

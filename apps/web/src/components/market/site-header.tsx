'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AccountMenu } from '@/components/market/account-menu';
import { money } from '@/lib/format';
import { PAGE_WIDTH } from '@/lib/layout';
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
      {/*
        One row on a laptop, two on a phone.
        
        The reference puts all four things on a single 60px line, which works
        at 1200px and does not work at 390: the search is the flexible one, so
        it is what collapses, and a search field squeezed to forty pixels is
        not a search field. Wrapping it onto its own full-width line below
        costs one row of height and gives back a control somebody can actually
        type in. `flex-wrap` with `order-last` does it in one element, so the
        field is rendered once and keeps one id.
      */}
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 sm:h-[60px] sm:flex-nowrap sm:gap-x-[14px] sm:px-5 sm:py-0 ${PAGE_WIDTH}`}
      >
        <Logo />
        <SearchField />
        <div className="hidden flex-1 sm:block" />
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
      className="flex shrink-0 items-center gap-2 whitespace-nowrap text-lg font-bold tracking-[-.02em]"
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
    <form
      role="search"
      onSubmit={submit}
      className="relative order-last w-full sm:order-none sm:w-auto sm:max-w-[440px] sm:flex-1"
    >
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
        className="h-[38px] w-full rounded-lg border border-border bg-chip pl-9 pr-3 text-base placeholder:text-text-muted focus:border-brand focus:bg-surface"
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
      className={`ml-auto flex shrink-0 select-none items-center gap-[7px] whitespace-nowrap text-sm font-semibold sm:ml-0 ${
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
        {/*
          No link to the marketing page from here.
          
          It was here for one commit and it was wrong: the landing page is the
          board of open questions, and a header link offering to explain the
          product instead of letting somebody read it is an invitation to
          leave the only screen that sells it. A stranger who lands on live
          prices with Buy Yes and Buy No under them has already understood
          more than the explainer would have told them.
          
          `/welcome` still exists for anyone who wants the long version, from
          the footer, where an About page belongs.
        */}
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
    <div className="flex shrink-0 items-center gap-1">
      {/*
        Everything that is not one of the five tabs — the account screen, the
        studio, the wizard, support, and the ops console for staff.

        It used to be a bare link to `/account`, hidden below `sm`, which is the
        breakpoint most of this traffic never reaches. So on a phone there was
        no route at all to two thirds of the product. The menu is on every
        width for that reason.
      */}
      <AccountMenu me={me} />

      {/*
        Named for screen readers, and for anything else that has to find it.
        Its visible content is a number and the word "Balance" beside it is
        `sm:block` — hidden on a phone, where the figure has to carry the whole
        meaning on its own. A link whose entire accessible name is "₦4,821" is
        opaque, and the phone is where most of this traffic arrives.
      */}
      <Link
        href="/wallet"
        aria-label="Your balance"
        className="flex flex-col items-end rounded-md px-2 py-1 leading-[1.15] hover:bg-chip"
      >
        <span className="font-mono text-base font-bold text-money">{money(me.available)}</span>
        <span className="hidden text-fine font-medium text-text-muted sm:block">Balance</span>
      </Link>
    </div>
  );
}

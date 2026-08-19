import Link from 'next/link';
import type { Metadata } from 'next';

import { MarketCard } from '@/components/market-card';
import { SiteFooter } from '@/components/site-footer';
import { api, API_URL, type MarketSummary } from '@/lib/api';
import { money } from '@/lib/format';
import { PAGE_WIDTH } from '@/lib/layout';

/**
 * §7.6's public landing page.
 *
 * **Where this lives, and why it is not at `/`.** §7.6 puts a marketing page
 * at the root domain. The design reference makes the markets grid the front
 * door, and that is the direction the product took deliberately — a stranger
 * who lands on a wall of live arguments with real prices moving has already
 * seen the demo the marketing page is trying to describe. So the marketing
 * page is here, linked from the logged-out header and from the footer, and
 * §7.6 in the architecture doc records the divergence rather than pretending
 * it does not exist.
 *
 * Everything on it is real. The teaser cards are the actual trending markets
 * at the actual prices, the week's staked total is the sum of real pots, and
 * the Top Call is whichever bold call a person actually featured. A landing
 * page with invented numbers on it is the one page of a prediction market
 * that must not have invented numbers on it.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'StakePot — arguments settled with receipts',
  description:
    'Nigeria argues about everything. StakePot is where arguments get settled — with receipts. Pick a question, stake your side, winners share the pot.',
};

interface TopCall {
  handle: string | null;
  displayName: string | null;
  marketId: string;
  question: string;
  entryPrice: string;
  resolvedOutcome: string;
}

export default async function WelcomePage() {
  let markets: MarketSummary[] = [];
  let topCalls: TopCall[] = [];

  try {
    markets = await api.markets();
  } catch {
    // The page still has a job to do without the API: a stranger reading it
    // needs to understand the product, and the teaser is the one part that
    // degrades rather than the whole page.
  }

  try {
    const response = await fetch(`${API_URL}/top-calls`, { cache: 'no-store' });
    if (response.ok) topCalls = (await response.json()) as TopCall[];
  } catch {
    // Same.
  }

  const live = markets
    .filter((market) => market.state === 'active')
    .sort((a, b) => Number.parseFloat(b.pot) - Number.parseFloat(a.pot));

  const staked = live.reduce((sum, market) => sum + Number.parseFloat(market.pot), 0);

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-border bg-surface/[.94] backdrop-blur-[8px]">
        <div className={`flex h-[60px] items-center gap-3 px-4 sm:px-5 ${PAGE_WIDTH}`}>
          <Link href="/" className="text-lg font-bold tracking-tight">
            Stake<span className="text-brand">Pot</span>
          </Link>
          <div className="flex-1" />
          <Link href="/login" className="text-sm font-semibold text-text-muted hover:text-text">
            Log in
          </Link>
          <Link
            href="/signup"
            className="h-9 rounded-md bg-brand px-3.5 text-sm font-bold leading-9 text-paper"
          >
            Sign up
          </Link>
        </div>
      </header>

      <main>
        {/* ------------------------------------------------------------ hero */}
        <section className={`px-4 pb-10 pt-12 sm:px-5 sm:pt-16 ${PAGE_WIDTH}`}>
          <div className="grid items-center gap-8 lg:grid-cols-[1.1fr_1fr]">
            <div>
              <h1 className="text-[34px] font-bold leading-[1.1] sm:text-[44px]">
                Nigeria argues about everything.
                <span className="block text-brand">
                  This is where arguments get settled — with receipts.
                </span>
              </h1>
              <p className="mt-4 max-w-xl text-lg text-text-muted">
                Pick a question. Stake your side. When the result lands, winners share the pot — and
                everybody can see the maths.
              </p>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href="/signup"
                  className="h-12 rounded-lg bg-brand px-6 text-md font-bold leading-[48px] text-paper transition-transform active:scale-press"
                >
                  Start with ₦0 — 10 seconds
                </Link>
                <Link
                  href="/"
                  className="h-12 rounded-lg border border-border px-6 text-md font-semibold leading-[46px] hover:border-text"
                >
                  Look around first
                </Link>
              </div>

              {live.length > 0 && (
                <p className="mt-4 font-mono text-sm text-text-muted">
                  <span className="font-bold text-money">{money(staked.toFixed(2))}</span> staked
                  across <span className="font-bold text-text">{live.length}</span> live
                  {live.length === 1 ? ' argument' : ' arguments'} right now.
                </p>
              )}
            </div>

            {/*
              §7.6: "a live animated market card (real prices from the API) so
              the product demos itself before signup". It is the real card
              component on real data, not a picture of one — the prices tick
              because they are the prices.
            */}
            {live[0] !== undefined && (
              <div className="lg:justify-self-end lg:pl-6">
                <p className="mb-2 font-mono text-xs uppercase tracking-widest text-text-muted">
                  Live right now
                </p>
                <MarketCard market={live[0]} />
              </div>
            )}
          </div>
        </section>

        {/* --------------------------------------------------- how it works */}
        <section className="border-y border-border bg-chip/40">
          <div className={`px-4 py-12 sm:px-5 ${PAGE_WIDTH}`}>
            <h2 className="text-xl font-bold">How it works</h2>
            <ol className="mt-6 grid gap-6 sm:grid-cols-3">
              <Step
                n="1"
                title="Pick a question"
                body="Real questions with one named source that settles them. No vibes, no “the admin decides”."
              />
              <Step
                n="2"
                title="Stake your side"
                body="The price is what the crowd currently believes. Back the side you think is wrong-priced."
              />
              <Step
                n="3"
                title="Winners share the pot"
                body="When the source publishes, the pot is split among the people who were right. The maths is on the receipt."
              />
            </ol>
          </div>
        </section>

        {/* -------------------------------------------------- live teaser */}
        {live.length > 1 && (
          <section className={`px-4 py-12 sm:px-5 ${PAGE_WIDTH}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-xl font-bold">Open right now</h2>
              <Link href="/" className="text-sm font-semibold text-brand underline">
                See all {live.length}
              </Link>
            </div>
            <div className="mt-5 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
              {live.slice(0, 4).map((market) => (
                <MarketCard key={market.id} market={market} />
              ))}
            </div>
          </section>
        )}

        {/* ------------------------------------------------------- trust */}
        <section className="border-y border-border">
          <div className={`px-4 py-12 sm:px-5 ${PAGE_WIDTH}`}>
            <h2 className="text-xl font-bold">Where your money sits</h2>
            <div className="mt-6 grid gap-6 sm:grid-cols-3">
              <Trust
                title="In the pot, not with us"
                body="Your stake sits in escrow until the result. Winners are paid only from the pot — we cannot pay company costs out of it, and the ledger is append-only so nothing can be quietly rewritten."
              />
              <Trust
                title="One named source"
                body="Every market names the source that settles it before anybody stakes. If it does not publish, the market voids and every stake comes back in full — no fees."
              />
              <Trust
                title="You can argue back"
                body="After a result is proposed there is a dispute window. Anyone holding a position can challenge it with evidence, and a person reviews it."
              />
            </div>
            <p className="mt-6 text-sm text-text-muted">
              Points mode — no cash deposits or withdrawals. Set your own limits or take a break any
              time from{' '}
              <Link href="/account/limits" className="font-semibold text-brand underline">
                your limits page
              </Link>
              . Read the{' '}
              <Link href="/rules" className="font-semibold text-brand underline">
                rulebook
              </Link>{' '}
              before you stake anything.
            </p>
          </div>
        </section>

        {/* --------------------------------------------------- community */}
        {topCalls.length > 0 && (
          <section className={`px-4 py-12 sm:px-5 ${PAGE_WIDTH}`}>
            <h2 className="text-xl font-bold">Being right, on the record</h2>
            <p className="mt-1 text-base text-text-muted">
              The boldest correct calls of the week. Every one of them is a real position somebody
              held before the result was known.
            </p>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {topCalls.slice(0, 4).map((call) => (
                <li
                  key={`${call.marketId}:${call.handle}`}
                  className="rounded-xl border border-border p-4"
                >
                  <p className="text-base font-semibold">{call.question}</p>
                  <p className="mt-2 text-sm text-text-muted">
                    <span className="font-semibold text-text">
                      {call.handle === null ? (call.displayName ?? 'Someone') : `@${call.handle}`}
                    </span>{' '}
                    bought{' '}
                    <span className="font-mono font-bold text-money">
                      {Math.round(Number.parseFloat(call.entryPrice) * 100)}%
                    </span>{' '}
                    — it resolved {call.resolvedOutcome}.
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ----------------------------------------------------- closing CTA */}
        <section className="border-t border-border bg-chip/40">
          <div className={`px-4 py-14 text-center sm:px-5 ${PAGE_WIDTH}`}>
            <h2 className="text-2xl font-bold">Got an opinion? Put it on the record.</h2>
            <p className="mx-auto mt-2 max-w-lg text-base text-text-muted">
              Email or phone, ten seconds, and a starter balance to argue with. No card, nothing to
              deposit.
            </p>
            <Link
              href="/signup"
              className="mt-6 inline-block h-12 rounded-lg bg-brand px-8 text-md font-bold leading-[48px] text-paper transition-transform active:scale-press"
            >
              Create an account
            </Link>
          </div>
        </section>
      </main>

      {/*
        The footer carries no padding of its own — every other caller renders
        it inside an already-padded `main`. This page ends its last section at
        the viewport edge, so it needs the container here or the links sit
        flush against the left of the screen.
      */}
      <div className={`px-4 sm:px-5 ${PAGE_WIDTH}`}>
        <SiteFooter />
      </div>
    </>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <li className="rounded-xl border border-border bg-surface p-5">
      <span className="flex size-8 items-center justify-center rounded-full bg-brand font-mono text-sm font-bold text-paper">
        {n}
      </span>
      <h3 className="mt-3 text-md font-bold">{title}</h3>
      <p className="mt-1.5 text-base text-text-muted">{body}</p>
    </li>
  );
}

function Trust({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-md font-bold">{title}</h3>
      <p className="mt-1.5 text-base text-text-muted">{body}</p>
    </div>
  );
}

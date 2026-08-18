import Link from 'next/link';

import { api, type MarketSummary } from '@/lib/api';
import { ArgumentBar } from '@/components/argument-bar';
import { MarketCard } from '@/components/market-card';
import { SignedInRedirect } from '@/components/signed-in-redirect';
import { kobo, money } from '@/lib/format';

// Live prices on the front door, so the demo is the product and not a mockup.
export const dynamic = 'force-dynamic';

/**
 * §7.6 — the public landing page.
 *
 * "A marketing-grade page at the root domain, built on the same tokens (§7.4)
 * but louder — its job: a stranger understands and signs up in under 30
 * seconds."
 *
 * The hero card is a real market at real prices rather than a screenshot,
 * which is the one decision that makes the rest of the page believable: the
 * argument bar a visitor sees moving is the same component, fed by the same
 * API, that they will trade on thirty seconds later.
 */
export default async function LandingPage() {
  let markets: MarketSummary[] = [];
  try {
    markets = await api.markets();
  } catch {
    // The front door must still open when the API is down. It loses the live
    // cards and keeps everything that explains what this is.
  }

  // Busiest first. §7.6 wants "3–4 real trending cards" and a hero that demos
  // the product — and a front door leading with an untouched market shows a
  // ₦0 pot to the one visitor who has never seen the product work.
  const live = markets
    .filter((market) => market.state === 'active')
    .sort((a, b) => Number(b.pot) - Number(a.pot));
  const hero = live[0];
  const teaser = live.slice(1, 5);
  const totalPot = markets.reduce((sum, market) => sum + Number(market.pot), 0);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <SignedInRedirect />

      {/* Hero */}
      <section className="pb-10 pt-6">
        <p className="font-mono text-xs uppercase tracking-widest text-text-muted">StakeAm</p>
        <h1 className="mt-3 text-3xl font-black leading-none sm:text-4xl">
          Nigeria argues about everything.
          <br />
          This is where arguments get settled — with receipts.
        </h1>
        <p className="mt-4 max-w-xl text-lg text-text-muted">
          Pick a side on the questions people are already shouting about. Winners split the pot.
          There is no house, and no house edge.
        </p>

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="rounded-md bg-rise px-5 py-3 text-md font-black text-paper transition-transform active:scale-press"
          >
            Start with a free balance
          </Link>
          <Link href="/login" className="text-sm font-bold underline">
            I already have an account
          </Link>
        </div>

        {hero !== undefined && (
          <div className="mt-8 rounded-lg border border-border bg-surface-raised p-5">
            <p className="font-mono text-xs uppercase tracking-widest text-text-muted">
              Live right now
            </p>
            <h2 className="mt-2 text-lg font-bold leading-snug">{hero.question}</h2>
            <div className="mt-4">
              <ArgumentBar
                segments={hero.outcomes.map((outcome) => ({
                  id: outcome.id,
                  label: outcome.label,
                  price: outcome.price,
                  ordinal: outcome.ordinal,
                  isOther: outcome.isOther,
                }))}
                showLabels={hero.outcomes.length === 2}
              />
            </div>
            <p className="mt-4 font-mono text-sm text-text-muted">
              {hero.outcomes[0]?.label} at{' '}
              <span className="font-black text-text">{kobo(hero.outcomes[0]?.price ?? '0')}</span>{' '}
              per share · pot <span className="text-money">{money(hero.pot)}</span>
            </p>
          </div>
        )}
      </section>

      {/* How it works */}
      <section className="border-t border-border py-10">
        <h2 className="text-xl font-black">How it works</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          <Step
            n="1"
            title="Pick a question"
            body="Elections, the naira, the Super Eagles, BBNaija. Every market settles against one named source, decided before it opens."
          />
          <Step
            n="2"
            title="Stake your side"
            body="The price is what the crowd thinks right now. Stake ₦500 or ₦50,000 — the odds move as people pile in."
          />
          <Step
            n="3"
            title="Winners share the pot"
            body="When the result lands, everyone who called it right splits the pot in proportion to what they staked. Receipts forever."
          />
        </div>
      </section>

      {/* Live markets teaser */}
      {teaser.length > 0 && (
        <section className="border-t border-border py-10">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-xl font-black">Open now</h2>
            {totalPot > 0 && (
              <p className="font-mono text-xs text-text-muted">
                <span className="text-money">{money(totalPot)}</span> staked across all markets
              </p>
            )}
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {teaser.map((market) => (
              <MarketCard key={market.id} market={market} />
            ))}
          </div>
        </section>
      )}

      {/* Trust block */}
      <section className="border-t border-border py-10">
        <h2 className="text-xl font-black">Why you can trust the result</h2>
        <dl className="mt-5 flex flex-col gap-5">
          <Trust term="One named source, agreed up front">
            Every market says exactly what will settle it — INEC, CBN, CAF — before anybody can
            stake. The rules cannot change after the fact, because they are written into the market.
          </Trust>
          <Trust term="Your stake sits in the pot, not with us">
            Money you stake is held in escrow against that market. Winners are paid only from the
            pot. We take a stated fee on the losing side and nothing else — there is no house
            position on the other side of your trade.
          </Trust>
          <Trust term="A dispute window before anyone is paid">
            Results are posted with their evidence, and there is a window to challenge them before
            payouts settle. Disputes are decided by people, in public.
          </Trust>
          <Trust term="Built to be walked away from">
            Set your own limits, take a cool-off, or self-exclude at any time — and the app tells
            you how long you have been in a session whether or not you asked.
          </Trust>
        </dl>
        <p className="mt-5 text-sm text-text-muted">
          <Link href="/rules" className="underline">
            Read the rules
          </Link>{' '}
          ·{' '}
          <Link href="/status" className="underline">
            Platform status
          </Link>
        </p>
      </section>

      {/* Closing CTA */}
      <section className="border-t border-border py-10">
        <h2 className="text-xl font-black">Ten seconds to start</h2>
        <p className="mt-2 max-w-lg text-md text-text-muted">
          Email or phone, a password, and you are in — with a free balance to trade. No card, no
          deposit, nothing to lose while you learn how it works.
        </p>
        <Link
          href="/signup"
          className="mt-5 inline-block rounded-md bg-rise px-5 py-3 text-md font-black text-paper transition-transform active:scale-press"
        >
          Create your account
        </Link>
      </section>

      <footer className="border-t border-border py-8 text-sm text-text-muted">
        <p>18+. Play responsibly — StakeAm is entertainment, not income.</p>
        <p className="mt-2">
          <Link href="/rules" className="underline">
            Rules
          </Link>{' '}
          ·{' '}
          <Link href="/support" className="underline">
            Support
          </Link>{' '}
          ·{' '}
          <Link href="/status" className="underline">
            Status
          </Link>
        </p>
      </footer>
    </main>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-4">
      <span className="font-mono text-xs font-black text-rise">{n}</span>
      <h3 className="mt-1.5 text-md font-bold">{title}</h3>
      <p className="mt-1.5 text-sm text-text-muted">{body}</p>
    </div>
  );
}

function Trust({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-md font-bold">{term}</dt>
      <dd className="mt-1 text-sm text-text-muted">{children}</dd>
    </div>
  );
}

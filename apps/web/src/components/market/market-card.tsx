'use client';

import Link from 'next/link';

import type { MarketSummary } from '@/lib/api';
import { STATE_LABEL, money, settlesOn } from '@/lib/format';
import { binaryPair } from '@/lib/home';
import { FreezeCountdown, useFreeze } from './freeze-notice';
import { LiveChanceGauge, LivePercent } from './live-percent';
import { PriceChange } from './price-change';
import { MarketIcon } from './market-icon';
import { SideButton } from './side-button';
import { WatchStar } from './watch-star';

/**
 * One market in the grid.
 *
 * Two body shapes, because two kinds of question read differently. A Yes/No
 * market has a single number that is the whole story, so it gets that number as
 * a dial and a pair of full-width buttons. A market with candidates has no such
 * number, so it lists the leaders with their own prices and their own way in.
 *
 * The card is an `<article>` rather than one big `<a>`: a link may not contain
 * the outcome buttons, and a div with a click handler is not a link at all.
 * The question's link is stretched over the whole card with `after:inset-0`,
 * and the buttons sit above it — so the card is clickable everywhere, the
 * buttons still work, and the keyboard gets one tab stop per destination.
 */
export function MarketCard({ market }: { market: MarketSummary }) {
  // Not `state === 'active'` alone. The sweep that flips the column runs on a
  // schedule and a card can sit on screen through the freeze, so the buttons
  // answer the clock — otherwise the grid offers a Buy the API refuses.
  const freeze = useFreeze(market);
  const tradeable = market.state === 'active' && !freeze.frozen;
  const settled = market.state === 'resolved' || market.state === 'voided';
  /** Inside the final hour, where a clock is the fact worth carrying. */
  const closingSoon = freeze.phase === 'closing' || freeze.phase === 'final';
  // A Yes/No pair keeps its own order so that green always means Yes; anything
  // else is ranked, because there the leader is the story.
  const binary = binaryPair(market);
  const ranked = [...market.outcomes].sort((left, right) => {
    if (left.isOther !== right.isOther) return left.isOther ? 1 : -1;
    return Number.parseFloat(right.price) - Number.parseFloat(left.price);
  });

  return (
    <article className="group relative isolate flex cursor-pointer flex-col gap-2.5 rounded-xl border border-border bg-surface-raised p-3.5 shadow-soft transition-[transform,box-shadow] duration-lift hover:-translate-y-0.5 hover:shadow-lifted">
      <div className="flex items-start gap-2.5">
        <MarketIcon id={market.id} question={market.question} size={40} radius={8} />

        <h3 className="flex-1 text-md font-semibold">
          <Link
            href={`/market/${market.id}`}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-brand"
          >
            {market.question}
          </Link>
        </h3>

        {binary !== null && (
          <div className="ml-auto flex shrink-0 flex-col items-center">
            <LiveChanceGauge
              marketId={market.id}
              outcomeId={binary[0].id}
              fallback={binary[0].price}
              size={62}
            />
            <PriceChange change={market.change24h} className="-mt-0.5" />
          </div>
        )}
      </div>

      {!tradeable ? (
        /* Where the buttons would be, because that is the question a reader
           is asking when they find none. Said once: this line replaced a
           duplicate FROZEN pill on the footer row below. */
        <p className="flex-1 text-sm font-semibold uppercase tracking-wide text-text-muted">
          {freeze.frozen && !settled
            ? 'Frozen — trading closed'
            : (STATE_LABEL[market.state] ?? market.state)}
        </p>
      ) : binary !== null ? (
        <div className="flex gap-2">
          <SideButton market={market} outcome={binary[0]} tone="yes" size="big" />
          <SideButton market={market} outcome={binary[1]} tone="no" size="big" />
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-1.5">
          {ranked.slice(0, 3).map((outcome) => (
            <div key={outcome.id} className="flex items-center gap-2 text-base">
              <span className="flex-1 truncate font-medium">{outcome.label}</span>
              <LivePercent
                marketId={market.id}
                outcomeId={outcome.id}
                fallback={outcome.price}
                className="w-10 text-right font-bold"
              />
              <SideButton market={market} outcome={outcome} tone="yes" size="mini" />
            </div>
          ))}
          {ranked.length > 3 && (
            <span className="text-xs font-medium text-text-muted">
              +{ranked.length - 3} more outcome{ranked.length - 3 === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}

      {/*
        Two facts and the star, and the second one changes rather than stacks.
        The reference's footer carries volume alone; a settle date earned its
        place because a reader scanning a grid needs to know whether a question
        pays out this week or in six. A freeze time then made it three, which
        at 390px wrapped "₦0 Vol." onto two lines — and three time-ish facts on
        one line is not information, it is a data dump the eye slides off.

        So the time slot holds whichever fact is actually live: the countdown
        once trading is about to stop, the settle date the rest of the time.
        They answer the same question at different distances.
      */}
      <div className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
        <span className="whitespace-nowrap">{money(market.volume24h)} Vol.</span>
        <span aria-hidden>·</span>
        {closingSoon ? (
          <FreezeCountdown market={market} className="whitespace-nowrap" />
        ) : (
          <span className="whitespace-nowrap">Settles {settlesOn(market.eventDate)}</span>
        )}
        <WatchStar marketId={market.id} question={market.question} />
      </div>
    </article>
  );
}

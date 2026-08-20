import Link from 'next/link';

import type { MarketSummary } from '@/lib/api';
import { STATE_LABEL, money, settlesOn } from '@/lib/format';
import { binaryPair } from '@/lib/home';
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
  const tradeable = market.state === 'active';
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
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-brand"
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
        <p className="flex-1 text-sm font-semibold uppercase tracking-wide text-text-muted">
          {STATE_LABEL[market.state] ?? market.state}
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

      <div className="mt-0.5 flex items-center gap-2 text-xs text-text-muted">
        {money(market.volume24h)} Vol.
        {/* When it pays out. The one fact a reader needs to know whether this
            question is worth a view today or in six weeks, and it was not on
            the card at all. */}
        <span aria-hidden>·</span>
        <span className="whitespace-nowrap">Settles {settlesOn(market.eventDate)}</span>
        <WatchStar marketId={market.id} question={market.question} />
      </div>
    </article>
  );
}

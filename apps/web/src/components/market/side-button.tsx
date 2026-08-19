'use client';

import type { MarketSummary, OutcomeView } from '@/lib/api';
import { kobo } from '@/lib/format';
import { useTradeIntent } from '@/store/trade-intent';

/**
 * A price button on a card.
 *
 * Pressing it opens the trade sheet over the grid rather than navigating: the
 * price is the decision, and somebody who has made it should not have to load
 * a page before they can act on it. The card itself still goes to the market,
 * for the reader who wants the chart and the rules first.
 *
 * It is a button, not a link, and it stops the click reaching the card's
 * stretched link underneath.
 */
export function SideButton({
  market,
  outcome,
  tone,
  size,
}: {
  market: MarketSummary;
  outcome: OutcomeView;
  tone: 'yes' | 'no';
  size: 'big' | 'mini';
}) {
  const open = useTradeIntent((state) => state.open);

  const skin =
    tone === 'no'
      ? 'bg-fall-bg text-fall hover:bg-fall hover:text-paper'
      : 'bg-rise-bg text-rise hover:bg-rise hover:text-paper';

  const shape =
    size === 'big' ? 'flex-1 rounded-md py-2.5 text-base' : 'rounded-sm px-2.5 py-1 text-xs';

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open(market, outcome);
      }}
      aria-label={`Buy ${outcome.label} on ${market.question} at ${kobo(outcome.price)}`}
      className={`relative z-10 font-bold transition-colors ${shape} ${skin}`}
    >
      {size === 'big' ? `Buy ${outcome.label} ${kobo(outcome.price)}` : 'Buy'}
    </button>
  );
}

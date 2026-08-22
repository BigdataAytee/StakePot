'use client';

import type { MarketSummary, OutcomeView } from '@/lib/api';
import { kobo } from '@/lib/format';
import { useFreeze } from './freeze-notice';
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
 *
 * The label is "Buy Yes", not "Buy Yes 50k". The price was on it because §7.2d
 * says "prices live on the buttons" — but with the dial beside it saying 50%
 * and the sheet's price-per-share row saying 50k, the button was the third
 * place the same fact appeared, in the one spot where it competed with the
 * verb. The accessible name still carries the price, because a screen reader
 * has no dial to glance at.
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
  // A card can sit on screen through the freeze — the grid does not reload every
  // second — so the button has to answer the clock rather than the state column
  // it was rendered from.
  const { frozen } = useFreeze(market);

  const skin =
    tone === 'no'
      ? 'bg-fall-bg text-fall hover:bg-fall hover:text-paper'
      : 'bg-rise-bg text-rise hover:bg-rise hover:text-paper';

  /*
   * Sizes read straight off the reference: `.ynbig` is 13px/700 at an 8px
   * radius, `.minibtn` 11px/700 at 6px. Ours had drifted up to 14px, and a
   * pair of full-width tinted blocks a size too large is what made every card
   * read as two buttons with a question attached rather than a question with
   * two ways in.
   *
   * The heights are ours, and only where a thumb is involved: a 38px primary
   * action is a coin-toss to hit, so `min-h-11` puts the big pair on the 44px
   * floor — then releases it at `sm:`, where a pointer is precise and the
   * reference's tighter button is the right one. The mini chip keeps its small
   * mark while a pseudo-element carries the target out to 44, the same trick
   * the star uses, for the same reason.
   */
  const shape =
    size === 'big'
      ? 'flex-1 inline-flex min-h-11 items-center justify-center rounded-md py-2.5 text-note sm:min-h-0'
      : "relative rounded-sm px-2.5 py-1 text-fine before:absolute before:left-1/2 before:top-1/2 before:h-11 before:min-w-[44px] before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

  return (
    <button
      type="button"
      disabled={frozen}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open(market, outcome);
      }}
      aria-label={
        frozen
          ? `Trading closed on ${market.question}`
          : `Buy ${outcome.label} on ${market.question} at ${kobo(outcome.price)}`
      }
      className={`relative z-10 font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${shape} ${skin}`}
    >
      {frozen ? 'Closed' : size === 'big' ? `Buy ${outcome.label}` : 'Buy'}
    </button>
  );
}

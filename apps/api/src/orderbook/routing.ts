import { Decimal } from '@stakeam/engine';

import { KOBO_PER_SHARE, type Side } from './matching';

/**
 * How a binary market's two buttons become one book.
 *
 * A book per outcome sounds right and is wrong for a binary market. "Buy No at
 * 38" and "sell Yes at 62" are the *same trade* — one person taking the side
 * that pays if Yes does not happen — and putting them in two books means two
 * pools of liquidity that can never match each other while both screens show a
 * spread. Every serious binary book resolves this the same way: one book, on
 * one outcome, with the complement expressed as the short side of it.
 *
 * So the market's first outcome by ordinal is the book's outcome, and a buy of
 * the second is a short of the first at the mirrored price. The trader never
 * sees this — they press "Buy No" and get a No position — but underneath there
 * is one order book and one spread.
 *
 * **This is also why the flag refuses a market with more than two outcomes.**
 * "Short of X" is well defined for any number of outcomes, but nothing in the
 * interface offers it: a three-way market's buttons buy A, B or C, and there is
 * no button that means "not B". A book only those three buttons can reach would
 * have three one-sided books and never a match. Multi-outcome matching needs
 * complete-set minting, which is a different feature — so those markets stay
 * pot-only and say so, rather than displaying a book that cannot fill.
 */
export interface BookRoute {
  /** The outcome the book is kept on — always the market's first. */
  readonly bookOutcomeId: string;
  /** Which side of that book this trade takes. */
  readonly side: Side;
  /**
   * The limit, in the book's price space. A limit of 38 on the second outcome
   * is a limit of 62 on the book.
   */
  readonly limitKobo: number | null;
}

export function routeFor(input: {
  readonly outcomes: readonly { id: string; ordinal: number }[];
  readonly outcomeId: string;
  /** The trader's limit, in the price space of the outcome they chose. */
  readonly limitKobo: number | null;
}): BookRoute | null {
  const ordered = [...input.outcomes].sort((left, right) => left.ordinal - right.ordinal);
  if (ordered.length !== 2) return null;

  const [first, second] = ordered;
  if (first === undefined || second === undefined) return null;

  if (input.outcomeId === first.id) {
    return { bookOutcomeId: first.id, side: 'buy', limitKobo: input.limitKobo };
  }
  if (input.outcomeId === second.id) {
    return {
      bookOutcomeId: first.id,
      side: 'sell',
      limitKobo: input.limitKobo === null ? null : KOBO_PER_SHARE - input.limitKobo,
    };
  }
  return null;
}

/**
 * The average price a pot fill would work out at, in kobo.
 *
 * The marginal price is what the ticket displays, but a size that walks the
 * curve pays more than it on the way up — so the limit is compared against what
 * the trader would actually pay per share, not against the number on the
 * button. Comparing against the marginal price would let a limit order fill
 * above its own limit, which is the one thing a limit is for.
 */
export function averageKobo(spend: Decimal, shares: Decimal): Decimal | null {
  if (shares.lte(0)) return null;
  return spend.div(shares).times(KOBO_PER_SHARE);
}

/** Whether a fill at this average respects a limit given in the same space. */
export function withinLimit(averageKoboPrice: Decimal | null, limitKobo: number | null): boolean {
  if (limitKobo === null) return true;
  if (averageKoboPrice === null) return false;
  return averageKoboPrice.lte(limitKobo);
}

/**
 * Tighten a trader's limit so the book can never fill worse than the pot.
 *
 * This is the correction that makes a hybrid honest, and it is not obvious
 * until you watch it go wrong.
 *
 * "Match the book first, then the pot" is the natural reading of a hybrid, and
 * it is wrong here — because the pot is not a passive venue, it is a market
 * maker quoting *both sides at once with no spread*. Yes at 50 and No at 50
 * always sum to ₦1. So the moment a resting ask is worse than the pot's price,
 * book-first would fill a taker at that worse price while a better one sat
 * right there on the curve. The trader would have been charged for the
 * privilege of using the new feature.
 *
 * So the pot's price becomes a ceiling on what the book may charge: a buyer
 * matches asks at or below it, a seller matches bids at or above it. Below the
 * ceiling the book is a genuine improvement and takes the flow; above it the
 * pot is better and keeps it.
 *
 * The consequence is worth stating plainly, because it shapes what the book
 * looks like in practice: **two resting orders on opposite sides of a
 * zero-spread pot can never cross.** One side's better-than-pot price is the
 * other side's worse-than-pot price, exactly. What actually fills is an order
 * that rested when the pot was somewhere else and has since become the better
 * quote — somebody who bought No at 40 while the pot said 50, matched later by
 * somebody buying Yes at 60 while the pot says 65. Both beat the pot at the
 * moment they traded, which is the only kind of match worth having.
 *
 * Rounded in the trader's favour on both sides, so a fractional pot price
 * never lets the book undercut it by a rounding artefact.
 */
export function tightenToPot(
  side: Side,
  limitKobo: number | null,
  potKobo: number | null,
): number | null {
  if (potKobo === null || !Number.isFinite(potKobo)) return limitKobo;

  if (side === 'buy') {
    const ceiling = Math.floor(potKobo);
    return limitKobo === null ? ceiling : Math.min(limitKobo, ceiling);
  }
  // A short's cost is ₦1 less the long price, so a *higher* long price is the
  // cheaper short — the ceiling is a floor in this direction.
  const floor = Math.ceil(potKobo);
  return limitKobo === null ? floor : Math.max(limitKobo, floor);
}

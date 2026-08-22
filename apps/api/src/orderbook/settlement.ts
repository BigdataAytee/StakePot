import { Decimal } from '@stakeam/engine';
import type { MatchSide } from '@prisma/client';

import type { Posting } from '../ledger/posting';

/**
 * How the matched pool settles, as arithmetic with no database in it.
 *
 * The property this file exists to make checkable:
 *
 *   **Every outcome's matched escrow settles inside that outcome.** The longs
 *   and shorts on one outcome escrowed ₦1 a share between them, and exactly one
 *   of the two sides is paid that ₦1. The money paid out equals the money that
 *   was put in, per outcome, with nothing left over and nothing missing — so
 *   the pot funds none of it and the platform funds none of it.
 *
 * That is why this returns postings rather than writing them: an arithmetic
 * claim about money should be provable without a transaction, and the fuzz test
 * that hammers it does exactly that.
 */

export class MatchedSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchedSettlementError';
  }
}

export interface MatchedHolding {
  readonly userId: string;
  readonly outcomeId: string;
  readonly side: MatchSide;
  readonly shares: Decimal;
  readonly escrowed: Decimal;
}

/** Whether this holding is the one that gets paid. */
export function wins(holding: MatchedHolding, winningOutcomeId: string): boolean {
  const onWinner = holding.outcomeId === winningOutcomeId;
  return holding.side === 'long' ? onWinner : !onWinner;
}

/**
 * The postings that settle a market's matched positions.
 *
 * Two legs per holder at most: their escrow leaves, and if they were right,
 * ₦1 a share arrives in their available balance. A loser's escrow leaves and
 * goes to the winner it was posted against — which is what it was for from the
 * moment the pair was minted.
 *
 * The pairing check is not defensive politeness. If longs and shorts on an
 * outcome ever disagreed on size, the postings would not balance and the ledger
 * would refuse the whole resolution — correct, but the market would simply stop
 * settling with an arithmetic error nobody could read. Throwing here names the
 * outcome and the two figures.
 */
export function settleMatched(input: {
  readonly marketId: string;
  readonly winningOutcomeId: string;
  readonly holdings: readonly MatchedHolding[];
}): { postings: Posting[]; paid: Decimal; released: Decimal } {
  const postings: Posting[] = [];
  let paid = new Decimal(0);
  let released = new Decimal(0);

  const byOutcome = new Map<string, MatchedHolding[]>();
  for (const holding of input.holdings) {
    if (holding.shares.lte(0)) continue;
    byOutcome.set(holding.outcomeId, [...(byOutcome.get(holding.outcomeId) ?? []), holding]);
  }

  for (const [outcomeId, holdings] of byOutcome) {
    const sized = (side: MatchSide): Decimal =>
      holdings
        .filter((holding) => holding.side === side)
        .reduce((total, holding) => total.plus(holding.shares), new Decimal(0));

    const long = sized('long');
    const short = sized('short');
    if (!long.equals(short)) {
      throw new MatchedSettlementError(
        `outcome ${outcomeId} has ${long.toString()} long shares against ` +
          `${short.toString()} short — every matched share is minted with a ` +
          'counterparty, so these cannot differ',
      );
    }

    const escrowed = holdings.reduce(
      (total, holding) => total.plus(holding.escrowed),
      new Decimal(0),
    );
    if (!escrowed.equals(long)) {
      throw new MatchedSettlementError(
        `outcome ${outcomeId} holds ${escrowed.toString()} against ${long.toString()} ` +
          'paired shares — a matched pair escrows exactly ₦1 a share',
      );
    }

    for (const holding of holdings) {
      if (holding.escrowed.gt(0)) {
        postings.push({
          userId: holding.userId,
          marketId: input.marketId,
          type: 'payout',
          fundClass: 'user_escrow',
          amount: holding.escrowed.negated(),
          currency: 'SPC',
        });
        released = released.plus(holding.escrowed);
      }
      if (wins(holding, input.winningOutcomeId)) {
        postings.push({
          userId: holding.userId,
          marketId: input.marketId,
          type: 'payout',
          fundClass: 'user_available',
          // ₦1 a share, exactly. No fee, no division, no estimate — the number
          // was known the moment the pair was minted and it has not moved.
          amount: holding.shares,
          currency: 'SPC',
        });
        paid = paid.plus(holding.shares);
      }
    }
  }

  return { postings, paid, released };
}

/**
 * The postings that refund a voided market's matched positions.
 *
 * Everybody gets back exactly what they put in. A void is not a result, so
 * there is no winner to pay and no reason for one side's stake to move to the
 * other's — which is the whole difference between voiding a market and
 * settling one.
 */
export function refundMatched(input: {
  readonly marketId: string;
  readonly holdings: readonly MatchedHolding[];
}): { postings: Posting[]; refunded: Decimal } {
  const postings: Posting[] = [];
  let refunded = new Decimal(0);

  for (const holding of input.holdings) {
    if (holding.escrowed.lte(0)) continue;
    postings.push(
      {
        userId: holding.userId,
        marketId: input.marketId,
        type: 'refund',
        fundClass: 'user_escrow',
        amount: holding.escrowed.negated(),
        currency: 'SPC',
      },
      {
        userId: holding.userId,
        marketId: input.marketId,
        type: 'refund',
        fundClass: 'user_available',
        amount: holding.escrowed,
        currency: 'SPC',
      },
    );
    refunded = refunded.plus(holding.escrowed);
  }

  return { postings, refunded };
}

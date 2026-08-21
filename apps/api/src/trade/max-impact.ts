import { Decimal, buy, priceOf, type MarketState } from '@stakeam/engine';

/**
 * The max-impact ceiling: how far one trade may move a pot price.
 *
 * A market price is a claim about what a crowd believes. A single stake big
 * enough to reprice the market on its own is not that claim — it is one
 * person's cheque, wearing the crowd's clothes. Everyone who reads the number
 * afterwards, including the people who then trade on it, is reading something
 * that was bought rather than agreed.
 *
 * So there is a ceiling, in basis points of probability, on the move any one
 * trade may cause on the pot leg. It is not a limit on wealth: the same money
 * can go in over several trades, or rest on the book where it needs a
 * counterparty who agrees with it. What it forbids is doing it in one motion,
 * invisibly.
 *
 * Pure, for the same reason `tier-cap.ts` is pure: the screen that says "you
 * can stake up to X" and the path that refuses at X have to be reading one
 * rule. The seed tool's "max sensible stake" column is this function too.
 */

/** Basis points: 10,000 = the whole probability range. */
export const BPS = 10_000;

export interface ImpactVerdict {
  readonly allowed: boolean;
  /** How far the trade moves the price, in basis points. */
  readonly movedBps: number;
  readonly ceilingBps: number;
  readonly priceBefore: Decimal;
  readonly priceAfter: Decimal;
}

/**
 * What one buy would do to the price it is buying.
 *
 * Measured on the outcome being bought. A multi-outcome market moves every
 * price when any one of them is bought, but the others move *down* and by
 * less; the bought side is both the largest move and the one being claimed.
 */
export function impactOf(input: {
  state: MarketState;
  index: number;
  amount: Decimal;
  ceilingBps: number;
}): ImpactVerdict {
  const { state, index, amount, ceilingBps } = input;
  const priceBefore = priceOf(state.q, state.liquidity, index);

  if (amount.lte(0)) {
    return {
      allowed: true,
      movedBps: 0,
      ceilingBps,
      priceBefore,
      priceAfter: priceBefore,
    };
  }

  const after = buy(state, index, amount.toString());
  const priceAfter = priceOf(after.state.q, after.state.liquidity, index);
  const movedBps = priceAfter.minus(priceBefore).abs().times(BPS).toNumber();

  // A ceiling nobody configured is "no ceiling", never "no trading" — the same
  // failure direction `tier-cap.ts` chose, for the same reason.
  const allowed = ceilingBps <= 0 || movedBps <= ceilingBps;
  return { allowed, movedBps, ceilingBps, priceBefore, priceAfter };
}

/**
 * The largest stake that still fits under the ceiling.
 *
 * Binary search over the engine rather than an inverted cost function: the
 * inverse of the LMSR price move is solvable, but it is solvable *differently*
 * for each outcome count, and a closed form that drifts from `buy()` by a
 * rounding step would put the advertised maximum just above the amount the
 * path accepts. Searching the real function cannot disagree with it.
 *
 * Forty iterations halves the range far past the eighteen decimal places money
 * is held at, so the answer is exact for every purpose that spends it.
 */
export function largestWithinImpact(input: {
  state: MarketState;
  index: number;
  ceilingBps: number;
  /** Where to stop looking. The search never returns more than this. */
  upperBound: Decimal;
}): Decimal {
  const { state, index, ceilingBps, upperBound } = input;
  if (ceilingBps <= 0) return upperBound;

  const fits = (amount: Decimal): boolean => impactOf({ state, index, amount, ceilingBps }).allowed;

  if (fits(upperBound)) return upperBound;

  let low = new Decimal(0);
  let high = upperBound;
  for (let step = 0; step < 40; step += 1) {
    const mid = low.plus(high).div(2);
    if (fits(mid)) low = mid;
    else high = mid;
  }
  // Round down: the number shown must be one the trade path accepts, and
  // rounding up by a quantum makes the advertised maximum a refusal.
  return low.toDecimalPlaces(18, Decimal.ROUND_DOWN);
}

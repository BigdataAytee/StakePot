import { Decimal } from '@stakeam/engine';

/**
 * The matching layer's arithmetic, with no database and no Nest in it.
 *
 * Everything about *who* gets filled and *for how much* lives here so it can be
 * tested exhaustively, and so the one property that matters can be stated as a
 * function rather than hoped for across a transaction:
 *
 *   **A matched pair escrows exactly ₦1 per share, split between the two
 *   sides, and exactly one of them is paid that ₦1 at settlement.**
 *
 * That is the whole reason the platform carries no capital and no risk on this
 * path. Nobody underwrites the trade; the counterparty does, in advance, in
 * full. The pot leg is unchanged and still lives in `packages/engine` — this
 * module never touches it.
 *
 * ## A note on the unit
 *
 * A share pays **₦1** — 100 kobo — and prices are quoted in kobo, 1 to 99.
 * The brief says "₦100 per share"; its own worked example is the arbiter and
 * says otherwise: ₦4,000 matched at 60 kobo is quoted as an exact payout of
 * ₦6,667, which is 4000 ÷ 0.60. That is ₦1 a share, and it is also what the
 * pot already pays — `priceCurrent` is a probability in (0, 1) and the buttons
 * read "64k" for a ₦1 share. One unit across both legs is not negotiable: two
 * would be a rounding error waiting for a market to be big enough to show it.
 */

/** What one share is worth at settlement, in kobo. */
export const KOBO_PER_SHARE = 100;

/** `Decimal(38, 18)` on every money column. */
export const MONEY_DP = 18;

/**
 * The scale a matched share is held at.
 *
 * Eighteen places, not the thirty the column allows, and this is load-bearing.
 * A matched share **is** money: it pays exactly ₦1 at settlement. So the
 * number of shares and the naira that settle them have to live on the same
 * grid — quantise shares finer than the money columns and the collateral
 * escrowed (rounded to 18) is a hair less than the payout owed (carried at
 * 30), on every fill, for ever. That shortfall has exactly one place to come
 * from, and it is the platform's pocket.
 *
 * The pot leg is unaffected and still uses the full thirty places: a pot share
 * is a claim on a division, not on a fixed ₦1, so it has no such twin.
 */
export const SHARE_DP = MONEY_DP;

export type Side = 'buy' | 'sell';

/** The other side of a trade. A buy is matched by a sell and vice versa. */
export const opposite = (side: Side): Side => (side === 'buy' ? 'sell' : 'buy');

/**
 * A price a limit order may carry.
 *
 * 1 to 99 inclusive. Zero and 100 are excluded on purpose: at either end one
 * side of the pair escrows nothing, which is not a trade — it is a gift with a
 * settlement date, and it would let somebody rest an order that cannot lose.
 */
export function isValidPrice(priceKobo: number): boolean {
  return Number.isInteger(priceKobo) && priceKobo >= 1 && priceKobo <= KOBO_PER_SHARE - 1;
}

/**
 * What one share costs the given side at this price, in naira.
 *
 * The long side pays the price; the short side pays what is left of the ₦1.
 * Deriving the short's cost by subtraction rather than computing it from
 * `100 − p` directly is what makes the pair sum *exactly* — see `splitStake`.
 */
export function unitCost(side: Side, priceKobo: number): Decimal {
  const long = new Decimal(priceKobo).div(KOBO_PER_SHARE);
  return side === 'buy' ? long : new Decimal(1).minus(long);
}

/**
 * Split ₦1 × shares between the long and the short at this price.
 *
 * The short's stake is the remainder, never a second multiplication. At
 * eighteen decimal places `s × 0.62` and `s × 0.38` can each be a rounded
 * value whose sum is a quantum off `s`, and a quantum off is money invented by
 * a write — `assertBalanced` would refuse the transaction, correctly. Taking
 * one side and subtracting makes the identity hold for every `s` there is.
 */
export function splitStake(
  shares: Decimal,
  priceKobo: number,
): { readonly long: Decimal; readonly short: Decimal; readonly collateral: Decimal } {
  // Quantised first, and everything below is derived from the quantised value
  // rather than the original — so the collateral escrowed and the ₦1-a-share
  // owed are the same number rather than two roundings of one.
  const quantised = shares.toDecimalPlaces(SHARE_DP, Decimal.ROUND_DOWN);
  const collateral = quantised;
  const long = quantised
    .times(priceKobo)
    .div(KOBO_PER_SHARE)
    .toDecimalPlaces(MONEY_DP, Decimal.ROUND_DOWN);
  return { long, short: collateral.minus(long), collateral };
}

/** What `side` pays for `shares` at this price. The pair's other half is the rest of ₦1. */
export function stakeFor(side: Side, shares: Decimal, priceKobo: number): Decimal {
  const split = splitStake(shares, priceKobo);
  return side === 'buy' ? split.long : split.short;
}

/**
 * The smallest amount of anything this layer deals in.
 *
 * One unit at the money scale. Shares and naira share the scale here (see
 * `SHARE_DP`), so one constant covers both.
 */
export const QUANTUM = new Decimal(1).div(new Decimal(10).pow(MONEY_DP));

/**
 * How many shares a budget buys on this side at this price.
 *
 * Rounded **down**, always. The remainder stays with the trader — it moves to
 * the next price level, or comes back to them. Rounding up would hand out a
 * fraction of a share nobody paid for, which on a pool that must settle
 * exactly is the difference between solvent and not.
 *
 * An estimate rather than the final word: what the taker actually pays for a
 * fill is `shares − makerStake`, because the maker's half is drawn from a lock
 * that has to reach exactly zero. See `planMatch`.
 */
export function sharesFor(budget: Decimal, side: Side, priceKobo: number): Decimal {
  const unit = unitCost(side, priceKobo);
  if (unit.lte(0)) return new Decimal(0);
  return budget.div(unit).toDecimalPlaces(SHARE_DP, Decimal.ROUND_DOWN);
}

/**
 * Whether a taker at `takerPrice` will trade with a maker at `makerPrice`.
 *
 * One number describes both sides of the book: `priceKobo` is always the
 * *long* side's price. A buyer willing to pay 65 crosses a seller asking 62; a
 * seller willing to let the long side go at 62 crosses a buyer bidding 65. The
 * comparison is the same inequality read from either end.
 */
export function crosses(takerSide: Side, takerPrice: number, makerPrice: number): boolean {
  return takerSide === 'buy' ? takerPrice >= makerPrice : takerPrice <= makerPrice;
}

export interface RestingOrder {
  readonly id: string;
  readonly userId: string;
  readonly priceKobo: number;
  /** Shares the order was placed for. */
  readonly shares: Decimal;
  /** Shares of it already filled. */
  readonly filled: Decimal;
  readonly createdAt: Date;
}

export const remainingOf = (order: RestingOrder): Decimal => order.shares.minus(order.filled);

/**
 * What a maker has locked against the first `cumulative` shares of their order.
 *
 * Per-fill stakes are **differences of this function**, never independent
 * roundings, and that is the whole trick. A maker's lock has to reach exactly
 * zero when their order is exhausted: if each fill were floored on its own,
 * the sum of the parts would drift from the whole by a quantum per fill, and
 * an order swept across five levels would leave a lock that never empties — or,
 * on the short side, one that empties before the last fill and asks the
 * platform for the difference. Differencing a monotone cumulative makes the
 * parts sum to the whole for free.
 */
export function cumulativeStake(side: Side, cumulative: Decimal, priceKobo: number): Decimal {
  return stakeFor(side, cumulative, priceKobo);
}

/**
 * The book, best price first, then oldest first.
 *
 * Price-time priority, and the *time* half is not decoration: it is what makes
 * resting an order worth doing. A book that broke ties any other way would
 * reward whoever polls fastest rather than whoever committed first, and the
 * liquidity this whole layer depends on would stop showing up.
 *
 * "Best" is from the taker's point of view: a buyer wants the lowest ask, a
 * seller the highest bid.
 */
export function sortForTaker(takerSide: Side, orders: readonly RestingOrder[]): RestingOrder[] {
  return [...orders].sort((left, right) => {
    if (left.priceKobo !== right.priceKobo) {
      return takerSide === 'buy'
        ? left.priceKobo - right.priceKobo
        : right.priceKobo - left.priceKobo;
    }
    const byTime = left.createdAt.getTime() - right.createdAt.getTime();
    // Ids break a dead tie so the same book matched twice fills identically.
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

export interface Fill {
  readonly makerOrderId: string;
  readonly makerUserId: string;
  readonly priceKobo: number;
  readonly shares: Decimal;
  /** What the taker pays. Exactly ₦1 × shares minus the maker's half. */
  readonly takerStake: Decimal;
  /** The maker's half, drawn from the lock their resting order already holds. */
  readonly makerStake: Decimal;
}

export interface MatchPlan {
  readonly fills: readonly Fill[];
  /** Shares acquired across every fill. */
  readonly shares: Decimal;
  /** Money the taker spends on the matched leg. */
  readonly spent: Decimal;
  /** Budget left over — for the pot leg, or to rest on the book. */
  readonly remainingBudget: Decimal;
}

/**
 * Walk the book and decide the fills, spending at most `budget`.
 *
 * The taker pays the **maker's** price, not their own limit. A buyer bidding
 * 65 into an ask of 62 pays 62 — the price improvement belongs to whoever
 * crossed the spread, which is every book's convention and the only one that
 * does not punish naming your real limit.
 *
 * Nothing here writes anything. It returns a plan the caller executes inside
 * the market's row lock, which is what keeps matching on the same concurrency
 * path as every other trade rather than inventing a second one.
 */
export function planMatch(input: {
  readonly takerSide: Side;
  /** The taker's limit, or null for "whatever the book is asking". */
  readonly limitKobo: number | null;
  readonly budget: Decimal;
  readonly book: readonly RestingOrder[];
  /** Nobody trades with themselves. */
  readonly takerUserId: string;
}): MatchPlan {
  const makerSide = opposite(input.takerSide);
  const fills: Fill[] = [];
  let shares = new Decimal(0);
  let spent = new Decimal(0);
  let budget = input.budget;

  for (const maker of sortForTaker(input.takerSide, input.book)) {
    if (budget.lte(0)) break;
    // A wash trade moves no risk and no money — it just prints a price. Skipped
    // rather than refused, so a genuine order does not bounce off the book
    // because the trader happens to have something resting further out.
    if (maker.userId === input.takerUserId) continue;

    const remaining = remainingOf(maker);
    if (remaining.lte(0)) continue;
    if (input.limitKobo !== null && !crosses(input.takerSide, input.limitKobo, maker.priceKobo)) {
      // The book is sorted best-first, so the first level that fails the limit
      // means every level after it fails too.
      break;
    }

    let take = Decimal.min(
      sharesFor(budget, input.takerSide, maker.priceKobo),
      remaining,
    ).toDecimalPlaces(SHARE_DP, Decimal.ROUND_DOWN);

    // The exact stakes, then a shrink if the exactness pushed the taker a
    // quantum past their budget. Bounded: the gap between the estimate and the
    // exact figure is at most one unit at the money scale, so one step of
    // correction is always enough — the loop is belt and braces, not a search.
    let makerStake = new Decimal(0);
    let takerStake = new Decimal(0);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (take.lte(0)) break;
      const before = cumulativeStake(makerSide, maker.filled, maker.priceKobo);
      const after = cumulativeStake(makerSide, maker.filled.plus(take), maker.priceKobo);
      makerStake = after.minus(before);
      takerStake = take.toDecimalPlaces(SHARE_DP, Decimal.ROUND_DOWN).minus(makerStake);
      if (takerStake.lte(budget)) break;
      take = take.minus(QUANTUM);
    }

    if (take.lte(0) || takerStake.lte(0) || takerStake.gt(budget)) break;

    fills.push({
      makerOrderId: maker.id,
      makerUserId: maker.userId,
      priceKobo: maker.priceKobo,
      shares: take,
      takerStake,
      makerStake,
    });
    shares = shares.plus(take);
    spent = spent.plus(takerStake);
    budget = budget.minus(takerStake);
  }

  return { fills, shares, spent, remainingBudget: budget };
}

/**
 * Depth on one side, aggregated to price levels for display.
 *
 * Levels are what a reader can act on — forty orders at 62 kobo is one line
 * saying how much is there, not forty lines saying who. Sorted best-first for
 * the *taker* of that side, which is the order a book is read in.
 */
export function depthLevels(
  takerSide: Side,
  orders: readonly RestingOrder[],
): { priceKobo: number; shares: Decimal; naira: Decimal }[] {
  const byPrice = new Map<number, Decimal>();
  for (const order of orders) {
    const remaining = remainingOf(order);
    if (remaining.lte(0)) continue;
    byPrice.set(order.priceKobo, (byPrice.get(order.priceKobo) ?? new Decimal(0)).plus(remaining));
  }

  return [...byPrice.entries()]
    .map(([priceKobo, shares]) => ({
      priceKobo,
      shares,
      // What it would cost the taker to sweep this level — the figure a trade
      // sheet can put beside a price, the way Polymarket shows what is
      // matching.
      naira: stakeFor(takerSide, shares, priceKobo),
    }))
    .sort((left, right) =>
      takerSide === 'buy' ? left.priceKobo - right.priceKobo : right.priceKobo - left.priceKobo,
    );
}

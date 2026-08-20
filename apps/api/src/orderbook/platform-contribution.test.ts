import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import { sumPostings } from '../ledger/posting';
import {
  QUANTUM,
  cumulativeStake,
  opposite,
  planMatch,
  remainingOf,
  stakeFor,
  type RestingOrder,
  type Side,
} from './matching';
import { settleMatched, type MatchedHolding } from './settlement';

/**
 * The claim, hammered: **the platform contributes nothing.**
 *
 * A deterministic pseudo-random walk builds a book, throws takers at it, and
 * settles whatever pairs come out — a thousand times, over prices from 1 to 99
 * kobo and sizes with awkward tails. After each run three things must hold:
 *
 *   1. Every pair escrowed exactly ₦1 a share between its two sides.
 *   2. Settlement paid out exactly what was escrowed, per outcome.
 *   3. Every posting set summed to zero.
 *
 * If any of them fails, the difference came from somewhere — and there is only
 * one place it could come from.
 *
 * Seeded rather than random. A fuzz test that cannot be re-run on the input
 * that broke it is a slot machine, not a test.
 */

/** A small deterministic generator, so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32 — short, has no dependencies, and its only job is to be varied.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

interface Book {
  orders: RestingOrder[];
  next: number;
}

function restOrder(book: Book, userId: string, priceKobo: number, shares: Decimal): void {
  book.next += 1;
  book.orders.push({
    id: `o${book.next}`,
    userId,
    priceKobo,
    shares,
    filled: new Decimal(0),
    createdAt: new Date(book.next),
  });
}

describe('platform contribution is zero', () => {
  it('holds across a thousand random mixed sequences', () => {
    for (let seed = 1; seed <= 1_000; seed += 1) {
      const random = rng(seed * 2_654_435_761);
      const pick = (n: number): number => Math.floor(random() * n);

      // Two books, one per side, so takers on both sides find liquidity.
      const books: Record<Side, Book> = {
        buy: { orders: [], next: 0 },
        sell: { orders: [], next: 1_000 },
      };
      /** escrow[userId] — every naira anybody has committed. */
      const escrowed = new Map<string, Decimal>();
      const add = (userId: string, amount: Decimal): void =>
        void escrowed.set(userId, (escrowed.get(userId) ?? new Decimal(0)).plus(amount));

      const holdings: MatchedHolding[] = [];
      const creditMatched = (userId: string, side: Side, shares: Decimal, stake: Decimal): void => {
        holdings.push({
          userId,
          outcomeId: 'yes',
          side: side === 'buy' ? 'long' : 'short',
          shares,
          escrowed: stake,
        });
      };

      // Seed the books.
      for (let i = 0; i < 6; i += 1) {
        const side: Side = pick(2) === 0 ? 'buy' : 'sell';
        const price = 1 + pick(99);
        const shares = new Decimal(1 + pick(5_000)).plus(
          new Decimal(pick(1_000_000)).times(QUANTUM).times(1e12),
        );
        restOrder(books[side], `maker${i}`, price, shares);
        add(`maker${i}`, stakeFor(side, shares, price));
      }

      // Throw takers at them.
      for (let round = 0; round < 8; round += 1) {
        const takerSide: Side = pick(2) === 0 ? 'buy' : 'sell';
        const makerBook = books[opposite(takerSide)];
        const budget = new Decimal(1 + pick(20_000)).plus(
          new Decimal(pick(1_000_000)).times(QUANTUM).times(1e12),
        );
        const limit = pick(3) === 0 ? null : 1 + pick(99);
        const taker = `taker${round}`;

        const plan = planMatch({
          takerSide,
          limitKobo: limit,
          budget,
          book: makerBook.orders,
          takerUserId: taker,
        });

        for (const fill of plan.fills) {
          // 1. The pair escrows exactly ₦1 a share.
          expect(fill.takerStake.plus(fill.makerStake).equals(fill.shares)).toBe(true);
          expect(fill.takerStake.gt(0)).toBe(true);
          expect(fill.makerStake.gte(0)).toBe(true);

          const maker = makerBook.orders.find((order) => order.id === fill.makerOrderId);
          expect(maker).toBeDefined();
          if (maker === undefined) continue;

          // The maker's lock is drawn down, never overdrawn.
          const lockLeft = stakeFor(opposite(takerSide), remainingOf(maker), maker.priceKobo);
          expect(fill.makerStake.lte(lockLeft.plus(QUANTUM))).toBe(true);

          add(taker, fill.takerStake);
          creditMatched(taker, takerSide, fill.shares, fill.takerStake);
          creditMatched(maker.userId, opposite(takerSide), fill.shares, fill.makerStake);

          // Advance the maker order the way the service would.
          const advanced = { ...maker, filled: maker.filled.plus(fill.shares) };
          makerBook.orders = makerBook.orders.map((order) =>
            order.id === maker.id ? advanced : order,
          );
        }

        expect(plan.spent.lte(budget)).toBe(true);
      }

      if (holdings.length === 0) continue;

      // 2 and 3. Settle it, both ways round, and check nothing was created.
      for (const winner of ['yes', 'no']) {
        const settled = settleMatched({
          marketId: 'm',
          winningOutcomeId: winner,
          holdings,
        });
        expect(sumPostings(settled.postings).isZero()).toBe(true);
        expect(settled.paid.equals(settled.released)).toBe(true);

        // The platform's own accounts are never touched. Not "net zero" —
        // absent, which is a stronger and much easier thing to check.
        expect(settled.postings.some((posting) => posting.userId.startsWith('sys_'))).toBe(false);
      }
    }
  });

  it('never lets a maker’s lock be over- or under-drawn across partial fills', () => {
    // The narrow version of the same property, isolated so a failure says which
    // half broke. Differences of a cumulative are exact by construction; this
    // is what would catch somebody replacing them with independent roundings.
    for (const side of ['buy', 'sell'] as Side[]) {
      for (const price of [1, 7, 33, 50, 67, 99]) {
        const total = new Decimal('1234.567890123456789012');
        const whole = stakeFor(side, total, price);

        let filled = new Decimal(0);
        let drawn = new Decimal(0);
        // The last slice is the remainder, so the parts sum to the whole
        // exactly — the test's own arithmetic must not be the thing that
        // drifts.
        const head = ['1.000000000000000001', '99.99', '333.333333333333333333'].map(
          (slice) => new Decimal(slice),
        );
        const slices = [...head, total.minus(head.reduce((a, b) => a.plus(b), new Decimal(0)))];
        for (const slice of slices) {
          const before = cumulativeStake(side, filled, price);
          filled = filled.plus(slice);
          drawn = drawn.plus(cumulativeStake(side, filled, price).minus(before));
        }

        expect(filled.toString()).toBe(total.toString());
        expect(drawn.equals(whole)).toBe(true);
      }
    }
  });
});

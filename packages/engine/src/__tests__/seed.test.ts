import { describe, expect, it } from 'vitest';
import {
  Decimal,
  EngineValidationError,
  buy,
  openMarket,
  potIdentityResidual,
  prices,
  resolve,
  seed,
  stakedIdentityResidual,
} from '../index';

/**
 * The symmetric seed (§2.4 Path B, Rulebook Part 3 §2–§3).
 *
 * The claim being tested is narrow and load-bearing: a seed puts money into a
 * market without moving a single price, and the pot it creates is exactly what
 * was paid for it. Everything the community shelf does with seeds — solo
 * creators, syndicates, void refunds — rests on those two facts.
 */

const sum = (values: readonly Decimal[]): Decimal =>
  values.reduce((acc, v) => acc.plus(v), new Decimal(0));

const tiny = new Decimal('1e-25');

describe('seed()', () => {
  it('moves no price at all, for any number of outcomes', () => {
    for (const n of [2, 3, 5, 9]) {
      const market = openMarket({ outcomes: n, liquidity: 5_000 });
      const before = prices(market.q, market.liquidity);
      const result = seed(market, 20_000);
      const after = result.pricesAfter;

      for (const [i, price] of after.entries()) {
        const moved = price.minus(before[i] ?? new Decimal(0)).abs();
        expect(moved.lte(tiny), `outcome ${i} moved by ${moved.toString()}`).toBe(true);
        // A flat market prices every outcome at 1/n, and the seed leaves it there.
        expect(price.minus(new Decimal(1).div(n)).abs().lte(tiny)).toBe(true);
      }
    }
  });

  it('puts exactly perOutcome × n into the pot, split equally', () => {
    const market = openMarket({ outcomes: 4, liquidity: 5_000 });
    const result = seed(market, 20_000);

    expect(result.total.equals(80_000)).toBe(true);
    expect(result.state.pot.equals(80_000)).toBe(true);
    for (const staked of result.state.staked) {
      expect(staked.equals(20_000)).toBe(true);
    }
    expect(sum(result.state.staked).equals(result.state.pot)).toBe(true);
    expect(stakedIdentityResidual(result.state).isZero()).toBe(true);
  });

  it('grants the same share count on every outcome — the seeder holds no side', () => {
    const market = openMarket({ outcomes: 3, liquidity: 1_200 });
    const result = seed(market, 20_000);

    for (const qi of result.state.q) {
      expect(qi.equals(result.sharesPerOutcome)).toBe(true);
    }
    // δ = total, so the seed buys shares at exactly the flat price 1/n.
    expect(result.sharesPerOutcome.equals(result.total)).toBe(true);
  });

  it('keeps the pot identity pot === C(q) − C(q0)', () => {
    for (const [n, liquidity] of [
      [2, 5_000],
      [3, 800],
      [7, 250_000],
    ] as const) {
      const result = seed(openMarket({ outcomes: n, liquidity }), 20_000);
      const residual = potIdentityResidual(result.state);
      expect(residual.abs().lte(new Decimal('1e-20')), residual.toString()).toBe(true);
    }
  });

  it('is order-independent — two seeds compose into one of their sum', () => {
    const market = openMarket({ outcomes: 3, liquidity: 4_000 });
    const twice = seed(seed(market, 8_000).state, 12_000).state;
    const once = seed(market, 20_000).state;

    for (const [i, qi] of twice.q.entries()) {
      expect(
        qi
          .minus(once.q[i] ?? new Decimal(0))
          .abs()
          .lte(tiny),
      ).toBe(true);
    }
    expect(twice.pot.equals(once.pot)).toBe(true);
  });

  it('is worth more than buying each side in turn — no price is paid for the seed', () => {
    // The same money spent as sequential buys hands the last outcome a better
    // price than the first, and leaves the book tilted. This is why the seed is
    // a closed form rather than a loop.
    const market = openMarket({ outcomes: 2, liquidity: 5_000 });
    const sequential = buy(buy(market, 0, 20_000).state, 1, 20_000).state;
    const seeded = seed(market, 20_000).state;

    expect(sequential.pot.equals(seeded.pot)).toBe(true);
    const sequentialPrices = prices(sequential.q, sequential.liquidity);
    const drift = (sequentialPrices[0] ?? new Decimal(0)).minus('0.5').abs();
    expect(drift.gt('0.01'), `sequential buys left prices at ${drift.toString()} off flat`).toBe(
      true,
    );
    for (const price of prices(seeded.q, seeded.liquidity)) {
      expect(price.minus('0.5').abs().lte(tiny)).toBe(true);
    }
  });

  it('refuses a market that has already traded', () => {
    const traded = buy(openMarket({ outcomes: 2, liquidity: 5_000 }), 0, 1_000).state;
    expect(() => seed(traded, 20_000)).toThrow(EngineValidationError);
  });

  it('refuses a non-positive seed', () => {
    const market = openMarket({ outcomes: 2, liquidity: 5_000 });
    expect(() => seed(market, 0)).toThrow(EngineValidationError);
    expect(() => seed(market, -1)).toThrow(EngineValidationError);
  });

  it('resolves conservatively: the seeder is paid out of the pot like anyone else', () => {
    // Rulebook Part 3 §2's worked example, in the engine's terms. Creator seeds
    // 20,000 a side; others stake 30,000 YES and 25,000 NO; YES wins.
    const seeded = seed(openMarket({ outcomes: 2, liquidity: 200_000 }), 20_000);
    const afterYes = buy(seeded.state, 0, 30_000);
    const afterNo = buy(afterYes.state, 1, 25_000);
    const state = afterNo.state;

    const holdings = [
      { holderId: 'creator', shares: seeded.sharesPerOutcome },
      { holderId: 'punter', shares: afterYes.shares },
    ];
    const result = resolve(state, 0, '0.07', holdings);

    // The fee's basis is everything staked on the outcome that lost.
    expect(result.losingPool.minus('45000').abs().lte(new Decimal('1e-20'))).toBe(true);
    const paid = sum(result.payouts.map((p) => p.payout));
    expect(paid.plus(result.fee).minus(state.pot).abs().lte(new Decimal('1e-20'))).toBe(true);

    // The creator's seed comes back with a share of the losing pool. They staked
    // 40,000 in total and get less than that back — the cost of instant launch.
    const creator = result.payouts.find((p) => p.holderId === 'creator');
    expect(creator).toBeDefined();
    expect(creator?.payout.gt(20_000)).toBe(true);
    expect(creator?.payout.lt(40_000)).toBe(true);
  });
});

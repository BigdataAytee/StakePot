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
  sell,
  topUpSymmetric,
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

/**
 * The counterexample fast-check found for `fee ≤ pot`, pinned as a fixed case.
 *
 * It is the answer to a question the Phase 0 addendum left open — "can
 * `staked[i]` go negative?" — and the answer is yes, on an ordinary sequence of
 * trades: buy heavily into one outcome so the other prices near zero, buy a
 * little of that other outcome (which is now cheap by the share), sell the first
 * outcome back down so the book swings, then sell the second. More money leaves
 * through the second outcome than was ever staked on it, and its `staked` goes
 * deeply negative.
 *
 * Left unclamped, `pot − staked[w]` then exceeds the whole pot, the fee exceeds
 * the pot, and every payout comes out negative — the market bills its winners.
 */
describe('a losing pool can never exceed the pot', () => {
  it('survives the swing that drives staked[w] negative', () => {
    let state = openMarket({ outcomes: 2, liquidity: 10_000 });
    const seeded = seed(state, 500_000);
    state = seeded.state;

    const first = buy(state, 0, 37_800_000);
    state = first.state;
    const second = buy(state, 1, 100_000);
    state = second.state;

    let heldZero = first.shares;
    let heldOne = second.shares;
    for (const [outcome, fraction] of [
      [0, '0.9'],
      [0, '0.25'],
      [1, '0.9'],
      [1, '0.5'],
    ] as const) {
      const held = outcome === 0 ? heldZero : heldOne;
      const delta = held.times(fraction);
      state = sell(state, outcome, delta).state;
      if (outcome === 0) heldZero = heldZero.minus(delta);
      else heldOne = heldOne.minus(delta);
    }

    // The bookkeeping figure really is negative — that is not the bug.
    expect((state.staked[1] ?? new Decimal(0)).isNegative()).toBe(true);

    const result = resolve(state, 1, '0.1', [
      { holderId: 'seeder', shares: seeded.sharesPerOutcome },
      { holderId: 'trader', shares: heldOne },
    ]);

    // The fee basis is: it is money, and money is bounded by the pot.
    expect(result.losingPool.lte(state.pot)).toBe(true);
    expect(result.fee.lte(state.pot)).toBe(true);
    for (const payout of result.payouts) {
      expect(
        payout.payout.gte(0),
        `${payout.holderId} was billed ${payout.payout.toString()}`,
      ).toBe(true);
    }
    expect(
      sum(result.payouts.map((p) => p.payout))
        .plus(result.fee)
        .minus(state.pot)
        .abs()
        .lte('1e-20'),
    ).toBe(true);
  });
});

describe('topUpSymmetric', () => {
  it('leaves every price exactly where it was, on a market that has traded', () => {
    // The property the whole operation rests on: C(q + δ·1) = C(q) + δ, so a
    // symmetric top-up takes no side. `seed` refuses this market; the
    // arithmetic never did.
    const opened = openMarket({ outcomes: 3, liquidity: 5_000 });
    const traded = buy(buy(opened, 0, '4000').state, 2, '1500').state;

    const before = prices(traded.q, traded.liquidity);
    const after = topUpSymmetric(traded, '250');

    for (const [index, price] of after.pricesAfter.entries()) {
      expect(price.minus(before[index]!).abs().lt('1e-30')).toBe(true);
    }
  });

  it('costs exactly what it adds to the pot, and adds it to every outcome', () => {
    const traded = buy(openMarket({ outcomes: 2, liquidity: 5_000 }), 0, '3000').state;
    const before = traded.pot;

    const result = topUpSymmetric(traded, '250');

    expect(result.total.toString()).toBe('500');
    expect(result.state.pot.minus(before).toString()).toBe('500');
    // δ shares of every outcome for a cost of δ.
    expect(result.sharesPerOutcome.toString()).toBe('500');
    for (const [index, q] of result.state.q.entries()) {
      expect(q.minus(traded.q[index]!).toString()).toBe('500');
    }
  });

  it('keeps the pot identity, which is what the invariants check', () => {
    const traded = buy(openMarket({ outcomes: 4, liquidity: 9_000 }), 1, '7777.77').state;
    const result = topUpSymmetric(traded, '123.456');

    const staked = result.state.staked.reduce((total, s) => total.plus(s), new Decimal(0));
    expect(staked.minus(result.state.pot).abs().lt('1e-18')).toBe(true);
  });

  it('refuses a top-up of nothing, exactly as a seed does', () => {
    const traded = buy(openMarket({ outcomes: 2, liquidity: 5_000 }), 0, '100').state;
    expect(() => topUpSymmetric(traded, '0')).toThrow();
    expect(() => topUpSymmetric(traded, '-5')).toThrow();
  });

  it('does not relax the precondition `seed` still carries', () => {
    // The two are separate exports so that a caller has to say by name that it
    // means the untraded rule not to apply.
    const traded = buy(openMarket({ outcomes: 2, liquidity: 5_000 }), 0, '100').state;
    expect(() => seed(traded, '250')).toThrow();
  });
});

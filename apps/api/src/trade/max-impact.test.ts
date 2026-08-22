import { Decimal, openMarket, buy, priceOf } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import { BPS, impactOf, largestWithinImpact } from './max-impact';

/**
 * The ceiling on what one trade may do to a price.
 *
 * The property being protected is not "trades are small" — it is that the
 * advertised maximum and the enforced maximum are the same number. A screen
 * that offers a limit the path then refuses is worse than no limit at all.
 */
describe('impactOf', () => {
  it('reports no move for a trade of nothing', () => {
    const market = openMarket({ outcomes: 2, liquidity: 5_000 });
    const verdict = impactOf({ state: market, index: 0, amount: new Decimal(0), ceilingBps: 500 });
    expect(verdict.movedBps).toBe(0);
    expect(verdict.allowed).toBe(true);
  });

  it('measures the move the engine actually makes', () => {
    const market = openMarket({ outcomes: 2, liquidity: 5_000 });
    const amount = new Decimal(2_000);

    const verdict = impactOf({ state: market, index: 0, amount, ceilingBps: BPS });
    const after = buy(market, 0, amount.toString());
    const expected = priceOf(after.state.q, after.state.liquidity, 0)
      .minus(priceOf(market.q, market.liquidity, 0))
      .abs()
      .times(BPS)
      .toNumber();

    expect(Math.abs(verdict.movedBps - expected)).toBeLessThan(1e-9);
  });

  it('refuses a stake that reprices the market on its own', () => {
    // L = 5,000 and a 20,000 stake: this is one person moving a binary market
    // most of the way to certain.
    const market = openMarket({ outcomes: 2, liquidity: 5_000 });
    const verdict = impactOf({
      state: market,
      index: 0,
      amount: new Decimal(20_000),
      ceilingBps: 1_500,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.movedBps).toBeGreaterThan(1_500);
  });

  it('allows the same money into a deeper market', () => {
    // The ceiling is about impact, not about size. A market sized for the
    // volume (rule 24) takes the stake without flinching.
    const deep = openMarket({ outcomes: 2, liquidity: 400_000 });
    const verdict = impactOf({
      state: deep,
      index: 0,
      amount: new Decimal(20_000),
      ceilingBps: 1_500,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('treats an unset ceiling as no ceiling, never as no trading', () => {
    const market = openMarket({ outcomes: 2, liquidity: 100 });
    for (const ceilingBps of [0, -1]) {
      const verdict = impactOf({
        state: market,
        index: 0,
        amount: new Decimal(1_000_000),
        ceilingBps,
      });
      expect(verdict.allowed, `ceiling ${ceilingBps} refused a trade`).toBe(true);
    }
  });
});

describe('largestWithinImpact', () => {
  it('returns an amount the guard actually accepts', () => {
    // The whole point. Anything else and the number on the screen is a lie.
    for (const [outcomes, liquidity, ceilingBps] of [
      [2, 5_000, 1_500],
      [2, 50_000, 500],
      [3, 20_000, 1_000],
      [5, 250_000, 250],
    ] as const) {
      const market = openMarket({ outcomes, liquidity });
      const most = largestWithinImpact({
        state: market,
        index: 0,
        ceilingBps,
        upperBound: new Decimal(10_000_000),
      });

      expect(
        impactOf({ state: market, index: 0, amount: most, ceilingBps }).allowed,
        `L=${liquidity} ceiling=${ceilingBps} offered ${most.toString()}, which the guard refuses`,
      ).toBe(true);
    }
  });

  it('is genuinely the largest — a little more is refused', () => {
    const market = openMarket({ outcomes: 2, liquidity: 5_000 });
    const most = largestWithinImpact({
      state: market,
      index: 0,
      ceilingBps: 1_500,
      upperBound: new Decimal(10_000_000),
    });

    const more = most.times('1.01');
    expect(impactOf({ state: market, index: 0, amount: more, ceilingBps: 1_500 }).allowed).toBe(
      false,
    );
  });

  it('never offers more than the bound it was given', () => {
    const deep = openMarket({ outcomes: 2, liquidity: 5_000_000 });
    const bound = new Decimal(1_000);
    const most = largestWithinImpact({
      state: deep,
      index: 0,
      ceilingBps: 1_500,
      upperBound: bound,
    });
    expect(most.lte(bound)).toBe(true);
  });

  it('grows with liquidity, which is what makes L the right dial', () => {
    const ceilingBps = 1_000;
    let previous = new Decimal(0);
    for (const liquidity of [1_000, 10_000, 100_000, 1_000_000]) {
      const most = largestWithinImpact({
        state: openMarket({ outcomes: 2, liquidity }),
        index: 0,
        ceilingBps,
        upperBound: new Decimal(100_000_000),
      });
      expect(most.gt(previous), `L=${liquidity} did not allow more than the level below`).toBe(
        true,
      );
      previous = most;
    }
  });

  it('holds on a market that has already traded', () => {
    const traded = buy(openMarket({ outcomes: 2, liquidity: 20_000 }), 0, '7500').state;
    const most = largestWithinImpact({
      state: traded,
      index: 0,
      ceilingBps: 800,
      upperBound: new Decimal(10_000_000),
    });
    expect(impactOf({ state: traded, index: 0, amount: most, ceilingBps: 800 }).allowed).toBe(true);
  });
});

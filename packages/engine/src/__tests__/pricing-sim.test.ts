import { describe, expect, it } from 'vitest';
import { Decimal, buy, openMarket, prices, resolve, sell } from '../index';

/**
 * Regression test against `scripts/pricing_sim.py`, the reference simulation
 * §2.3 asks to be kept in the repo.
 *
 * The Python runs its multi-trader scenarios off a numpy PRNG, which cannot be
 * reproduced here — so this ports the deterministic scenarios exactly and
 * asserts the headline claims the simulation makes: platform cost of exactly
 * zero, a pot that never goes negative, and an exact round trip.
 */

const close = (actual: Decimal, expected: string, tolerance = '1e-9'): void => {
  const diff = actual.minus(new Decimal(expected)).abs();
  expect(
    diff.lte(new Decimal(tolerance)),
    `expected ${actual.toString()} ≈ ${expected} (diff ${diff.toString()})`,
  ).toBe(true);
};

const sum = (values: readonly Decimal[]): Decimal =>
  values.reduce((acc, v) => acc.plus(v), new Decimal(0));

describe('pricing_sim.py parity — SIM 3, the whale stress case', () => {
  // Market(2, 5000); whale buys 50,000 alone, then exits the whole position.
  const L = '5000';
  const stake = '50000';

  it('a lone whale moves the price to ~99.998%', () => {
    const opened = openMarket({ outcomes: 2, liquidity: L });
    const bought = buy(opened, 0, stake);
    const p = prices(bought.state.q, bought.state.liquidity)[0]!;

    // Closed form: q = L·ln(2e^10 − 1), p = 1/(1 + e^(−q/L)).
    const expected = new Decimal(1).div(
      new Decimal(1).plus(
        new Decimal(2).times(new Decimal(10).exp()).minus(1).ln().negated().exp(),
      ),
    );
    close(p, expected.toString(), '1e-12');
    expect(p.gt('0.9999')).toBe(true);
    close(bought.state.pot, stake, '1e-18');
  });

  it('the full exit refunds exactly what was paid — the pot keeps nothing', () => {
    const opened = openMarket({ outcomes: 2, liquidity: L });
    const bought = buy(opened, 0, stake);
    const sold = sell(bought.state, 0, bought.shares);

    // The Python prints a "round-trip loss ... stays in pot"; with no other
    // trader on the book there is nothing to lose it to, and §2.3 says as much:
    // "a perfect buy-then-sell round trip otherwise refunds exactly what was
    // paid" — which is why the exit fee exists as the optional friction.
    close(sold.gross, stake, '1e-18');
    close(sold.state.pot, '0', '1e-18');
    expect(sold.state.pot.isNegative()).toBe(false);
  });
});

describe('pricing_sim.py parity — platform cost is exactly zero', () => {
  it('payouts + fee === everything collected, at the sim default 3% fee', () => {
    // A scripted stand-in for the Python's random trader flow: mixed sizes,
    // both outcomes, and a mid-run partial exit.
    const traders = [
      { id: 'u0', outcome: 0, spend: '2000' },
      { id: 'u1', outcome: 1, spend: '800' },
      { id: 'u2', outcome: 0, spend: '15000' },
      { id: 'u3', outcome: 0, spend: '250' },
      { id: 'u4', outcome: 1, spend: '5000' },
      { id: 'u5', outcome: 0, spend: '40000' },
    ];

    let state = openMarket({ outcomes: 2, liquidity: '10000' });
    const held = new Map<string, Decimal[]>();
    let collected = new Decimal(0);

    for (const t of traders) {
      const result = buy(state, t.outcome, t.spend);
      state = result.state;
      collected = collected.plus(t.spend);
      const row = held.get(t.id) ?? [new Decimal(0), new Decimal(0)];
      row[t.outcome] = row[t.outcome]!.plus(result.shares);
      held.set(t.id, row);
      expect(state.pot.isNegative()).toBe(false);
    }

    // u2 exits half, the way 15% of the Python's traders do.
    const u2 = held.get('u2')!;
    const half = u2[0]!.div(2);
    const exit = sell(state, 0, half);
    state = exit.state;
    collected = collected.minus(exit.gross);
    u2[0] = u2[0]!.minus(half);
    expect(state.pot.isNegative()).toBe(false);

    const holdings = [...held.entries()]
      .map(([holderId, row]) => ({ holderId, shares: row[0]! }))
      .filter((h) => h.shares.gt(0));

    const result = resolve(state, 0, '0.03', holdings);
    const paid = sum(result.payouts.map((p) => p.payout));

    // The simulation's headline: platform cost ₦0.00, to the kobo.
    close(paid.plus(result.fee).minus(collected), '0');
    close(result.fee, state.pot.times('0.03').toString());
  });
});

describe('§2.3 liquidity tuning', () => {
  /**
   * §2.3 states the price impact of a stake as `m·p(1−p)/L`, and works it as
   * "₦2,000 stakes → L=50,000 gives ~1-point moves".
   *
   * `p(1−p)/L` is dp/dq — the sensitivity per *share*. Money `m` buys about
   * `m/p` shares, so the money-denominated impact is `m(1−p)/L`, which is twice
   * the doc's figure at even odds. The engine agrees with the latter: the
   * doc's own worked example actually moves the price ~1.96 points, not ~1.
   *
   * Locked in as a test so the discrepancy is visible rather than rediscovered
   * the first time somebody tunes a market and gets double the move they sized
   * for. To land ~1-point moves at even odds, L wants to be ~50× the typical
   * stake, not 25×.
   */
  it('the true money-denominated impact is m(1−p)/L, not m·p(1−p)/L', () => {
    const L = new Decimal(50000);
    const m = new Decimal(2000);

    let state = openMarket({ outcomes: 2, liquidity: L });
    const before = prices(state.q, state.liquidity)[0]!;
    state = buy(state, 0, m).state;
    const after = prices(state.q, state.liquidity)[0]!;

    const actual = after.minus(before);
    const asDocumented = m.times(before).times(new Decimal(1).minus(before)).div(L);
    const perMoney = m.times(new Decimal(1).minus(before)).div(L);

    // Within 2% of m(1−p)/L …
    expect(actual.minus(perMoney).abs().div(perMoney).lt('0.02')).toBe(true);
    // … and roughly double what §2.3's formula predicts.
    expect(actual.div(asDocumented).gt('1.9')).toBe(true);
  });

  it('L is what damps the move: ten times the liquidity, a tenth of the swing', () => {
    const impactAt = (liquidity: string): Decimal => {
      let state = openMarket({ outcomes: 2, liquidity });
      const before = prices(state.q, state.liquidity)[0]!;
      state = buy(state, 0, '2000').state;
      return prices(state.q, state.liquidity)[0]!.minus(before);
    };

    const small = impactAt('50000');
    const large = impactAt('500000');
    expect(large.times(10).minus(small).abs().div(small).lt('0.05')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  Decimal,
  EngineValidationError,
  InsufficientSharesError,
  MarketFrozenError,
  buy,
  cost,
  estimatedPayoutPerShare,
  freeze,
  openMarket,
  potIdentityResidual,
  prices,
  resolve,
  sell,
  splitResolutionFee,
  stakedIdentityResidual,
} from '../index';

const close = (actual: Decimal, expected: string | number, tolerance = '1e-9'): void => {
  const diff = actual.minus(new Decimal(expected)).abs();
  expect(
    diff.lte(new Decimal(tolerance)),
    `expected ${actual.toString()} ≈ ${String(expected)} (diff ${diff.toString()})`,
  ).toBe(true);
};

const sum = (values: readonly Decimal[]): Decimal =>
  values.reduce((acc, v) => acc.plus(v), new Decimal(0));

describe('cost function C(q) = L ln Σ e^(q_j/L)', () => {
  it('is L·ln(n) for a market where every outcome is level', () => {
    const liquidity = new Decimal(100);
    for (const n of [2, 3, 5, 8]) {
      const q = Array.from({ length: n }, () => new Decimal(0));
      close(cost(q, liquidity), liquidity.times(new Decimal(n).ln()).toString());
    }
  });

  it('stays finite when share counts dwarf L (log-sum-exp is shifted)', () => {
    const liquidity = new Decimal(10);
    const q = [new Decimal('50000'), new Decimal(0)];
    const c = cost(q, liquidity);
    expect(c.isFinite()).toBe(true);
    // With q_0/L = 5000 the other term is negligible, so C ≈ q_0.
    close(c, '50000', '1e-12');
  });
});

describe('display prices', () => {
  it('splits evenly across a fresh market and sums to 1', () => {
    for (const n of [2, 3, 4, 8]) {
      const p = prices(
        Array.from({ length: n }, () => new Decimal(0)),
        new Decimal(500),
      );
      close(sum(p), 1, '1e-30');
      for (const pi of p) close(pi, new Decimal(1).div(n).toString(), '1e-30');
    }
  });

  it('moves toward the bought outcome and still sums to 1', () => {
    const market = openMarket({ outcomes: 2, liquidity: '1000' });
    const after = buy(market, 0, '400').state;
    const p = prices(after.q, after.liquidity);
    close(sum(p), 1, '1e-30');
    expect(p[0]?.gt(new Decimal('0.5'))).toBe(true);
    expect(p[1]?.lt(new Decimal('0.5'))).toBe(true);
  });
});

describe('buy', () => {
  it('grows the pot by exactly what was spent — C(q′) − C(q) === m', () => {
    const market = openMarket({ outcomes: 3, liquidity: '2500' });
    const before = cost(market.q, market.liquidity);
    const result = buy(market, 1, '750.25');
    const after = cost(result.state.q, result.state.liquidity);

    close(after.minus(before), '750.25', '1e-20');
    close(result.state.pot, '750.25', '1e-20');
    close(potIdentityResidual(result.state), 0, '1e-20');
  });

  it('matches the closed form Δ = L·ln((e^(m/L) − 1 + p_i)/p_i)', () => {
    const liquidity = new Decimal('1000');
    const market = openMarket({ outcomes: 2, liquidity });
    const m = new Decimal('250');
    const p = new Decimal('0.5');
    const expected = liquidity.times(m.div(liquidity).exp().minus(1).plus(p).div(p).ln());

    close(buy(market, 0, m).shares, expected.toString(), '1e-25');
  });

  it('grants more shares per naira on the cheaper side', () => {
    const market = buy(openMarket({ outcomes: 2, liquidity: '1000' }), 0, '600').state;
    const onFavourite = buy(market, 0, '100').shares;
    const onUnderdog = buy(market, 1, '100').shares;
    expect(onUnderdog.gt(onFavourite)).toBe(true);
  });

  it('rejects non-positive spend and out-of-range outcomes', () => {
    const market = openMarket({ outcomes: 2, liquidity: '1000' });
    expect(() => buy(market, 0, '0')).toThrow(EngineValidationError);
    expect(() => buy(market, 0, '-5')).toThrow(EngineValidationError);
    expect(() => buy(market, 2, '10')).toThrow(EngineValidationError);
  });

  it('refuses to trade once frozen at event start', () => {
    const market = freeze(openMarket({ outcomes: 2, liquidity: '1000' }));
    expect(() => buy(market, 0, '10')).toThrow(MarketFrozenError);
    expect(() => sell(market, 0, '1')).toThrow(MarketFrozenError);
  });
});

describe('sell', () => {
  it('round-trips: buying m then selling every share refunds exactly m', () => {
    const market = openMarket({ outcomes: 4, liquidity: '5000' });
    const bought = buy(market, 2, '1234.56');
    const sold = sell(bought.state, 2, bought.shares);

    close(sold.gross, '1234.56', '1e-20');
    close(sold.state.pot, 0, '1e-20');
    expect(sold.state.pot.isNegative()).toBe(false);
  });

  it('withholds the exit fee from the seller without touching the pot identity', () => {
    const market = openMarket({ outcomes: 2, liquidity: '1000', exitFeeRate: '0.005' });
    const bought = buy(market, 0, '500');
    const sold = sell(bought.state, 0, bought.shares);

    close(sold.gross, '500', '1e-20');
    close(sold.exitFee, '2.5', '1e-20');
    close(sold.net, '497.5', '1e-20');
    // The pot still gave up the full refund — the fee is a platform-side entry.
    close(sold.state.pot, 0, '1e-20');
    close(potIdentityResidual(sold.state), 0, '1e-20');
  });

  it('rejects an exit fee above the 2% ceiling', () => {
    expect(() => openMarket({ outcomes: 2, liquidity: '1000', exitFeeRate: '0.021' })).toThrow(
      EngineValidationError,
    );
  });

  it('charges the 1% early-exit fee by default — it is on, not opt-in', () => {
    const market = openMarket({ outcomes: 2, liquidity: '1000' });
    const bought = buy(market, 0, '500');
    // Buying is always free.
    expect(bought.exitFee.isZero()).toBe(true);
    close(bought.net, '500', '1e-20');

    const sold = sell(bought.state, 0, bought.shares);
    close(sold.exitFee, '5', '1e-18');
    close(sold.net, '495', '1e-18');
  });

  it('will not let shares outstanding fall below where the market opened', () => {
    const market = openMarket({ outcomes: 2, liquidity: '1000' });
    const bought = buy(market, 0, '100');
    expect(() => sell(bought.state, 0, bought.shares.times(2))).toThrow(InsufficientSharesError);
    expect(() => sell(bought.state, 1, '1')).toThrow(InsufficientSharesError);
  });
});

describe('resolution', () => {
  it('conserves the pot: Σpayouts + fee === pot', () => {
    let market = openMarket({ outcomes: 3, liquidity: '4000' });
    const ada = buy(market, 0, '1000');
    market = ada.state;
    const bola = buy(market, 0, '2500');
    market = bola.state;
    const chidi = buy(market, 1, '800');
    market = chidi.state;

    const potBefore = market.pot;
    // Ada and Bola backed outcome 0; only Chidi's ₦800 sits in the losing pool.
    const result = resolve(freeze(market), 0, '0.07', [
      { holderId: 'ada', shares: ada.shares },
      { holderId: 'bola', shares: bola.shares },
    ]);

    close(result.losingPool, '800', '1e-18');
    close(result.fee, new Decimal('800').times('0.07').toString(), '1e-18');
    close(result.residual, 0, '1e-9');
    const paid = sum(result.payouts.map((p) => p.payout));
    close(paid.plus(result.fee), potBefore.toString(), '1e-9');
  });

  it('splits the distributable pot in proportion to shares held', () => {
    let market = openMarket({ outcomes: 2, liquidity: '1000' });
    const first = buy(market, 0, '300');
    market = first.state;
    const second = buy(market, 0, '300');
    market = second.state;

    const result = resolve(market, 0, '0', [
      { holderId: 'first', shares: first.shares },
      { holderId: 'second', shares: second.shares },
    ]);

    const ratio = first.shares.div(second.shares);
    const payoutRatio = result.payouts[0]!.payout.div(result.payouts[1]!.payout);
    close(payoutRatio, ratio.toString(), '1e-20');
    // The earlier buyer got a better price, so they hold more shares and win more.
    expect(result.payouts[0]!.payout.gt(result.payouts[1]!.payout)).toBe(true);
  });

  it('refuses to pay out when holdings do not account for every winning share', () => {
    const market = buy(openMarket({ outcomes: 2, liquidity: '1000' }), 0, '500');
    expect(() =>
      resolve(market.state, 0, '0.02', [{ holderId: 'partial', shares: market.shares.div(2) }]),
    ).toThrow(EngineValidationError);
  });

  it('reports pot / q[w] as the pre-resolution estimate', () => {
    const market = buy(openMarket({ outcomes: 2, liquidity: '1000' }), 0, '500');
    close(
      estimatedPayoutPerShare(market.state, 0),
      market.state.pot.div(market.state.q[0]!).toString(),
      '1e-25',
    );
    expect(estimatedPayoutPerShare(market.state, 1).isZero()).toBe(true);
  });
});

describe('market creation', () => {
  it('rejects fewer than two outcomes and non-positive liquidity', () => {
    expect(() => openMarket({ outcomes: 1, liquidity: '1000' })).toThrow(EngineValidationError);
    expect(() => openMarket({ outcomes: 2, liquidity: '0' })).toThrow(EngineValidationError);
    expect(() => openMarket({ outcomes: 2, liquidity: '-1' })).toThrow(EngineValidationError);
  });

  it('measures the pot identity from a seeded opening vector', () => {
    const market = openMarket({ liquidity: '1000', initialShares: ['250', '100'] });
    expect(market.pot.isZero()).toBe(true);
    close(potIdentityResidual(market), 0, '1e-30');

    const after = buy(market, 1, '400');
    close(after.state.pot, '400', '1e-20');
    close(potIdentityResidual(after.state), 0, '1e-20');
  });
});

describe('staked totals', () => {
  it('reconcile to the pot after buys and sells', () => {
    let market = openMarket({ outcomes: 3, liquidity: '3000' });
    market = buy(market, 0, '1200').state;
    market = buy(market, 2, '450').state;
    const third = buy(market, 1, '700');
    market = third.state;

    close(market.staked[0]!, '1200', '1e-18');
    close(market.staked[1]!, '700', '1e-18');
    close(market.staked[2]!, '450', '1e-18');
    close(stakedIdentityResidual(market), 0, '1e-18');

    const sold = sell(market, 1, third.shares.div(2));
    close(stakedIdentityResidual(sold.state), 0, '1e-18');
    // The gross refund left the pot, so it left outcome 1's stake as well.
    close(sold.state.staked[1]!, new Decimal('700').minus(sold.gross).toString(), '1e-18');
  });

  it('a market with nothing on the losing side pays no fee at all', () => {
    const only = buy(openMarket({ outcomes: 2, liquidity: '1000' }), 0, '900');
    const result = resolve(only.state, 0, '0.07', [{ holderId: 'solo', shares: only.shares }]);

    close(result.losingPool, 0, '1e-18');
    close(result.fee, 0, '1e-18');
    close(result.payouts[0]!.payout, '900', '1e-18');
  });
});

describe('resolution fee split', () => {
  it('divides the community fee 4/3 without losing a kobo', () => {
    // §2.3: community 7% = 4% creator / 3% platform.
    const split = splitResolutionFee('2100', { creatorBps: 400, platformBps: 300 });
    close(split.creator, '1200', '1e-18');
    close(split.platform, '900', '1e-18');
    close(split.creator.plus(split.platform), '2100', '1e-25');
  });

  it('sends the whole official fee to the platform', () => {
    const split = splitResolutionFee('1500', { creatorBps: 0, platformBps: 300 });
    expect(split.creator.isZero()).toBe(true);
    close(split.platform, '1500', '1e-18');
  });

  it('the legs always add back to the fee, even on amounts that do not divide', () => {
    const split = splitResolutionFee('1000', { creatorBps: 400, platformBps: 300 });
    close(split.creator.plus(split.platform), '1000', '1e-30');
  });

  it('rejects a nonsense split', () => {
    expect(() => splitResolutionFee('100', { creatorBps: 0, platformBps: 0 })).toThrow(
      EngineValidationError,
    );
    expect(() => splitResolutionFee('100', { creatorBps: -1, platformBps: 300 })).toThrow(
      EngineValidationError,
    );
  });
});

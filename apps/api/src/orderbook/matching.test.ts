import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import {
  KOBO_PER_SHARE,
  QUANTUM,
  crosses,
  cumulativeStake,
  depthLevels,
  isValidPrice,
  planMatch,
  remainingOf,
  sharesFor,
  sortForTaker,
  splitStake,
  stakeFor,
  unitCost,
  type RestingOrder,
  type Side,
} from './matching';

const d = (v: string | number): Decimal => new Decimal(v);

function order(
  id: string,
  userId: string,
  priceKobo: number,
  shares: string,
  atMs = 0,
  filled = '0',
): RestingOrder {
  return {
    id,
    userId,
    priceKobo,
    shares: d(shares),
    filled: d(filled),
    createdAt: new Date(atMs),
  };
}

describe('prices', () => {
  it('refuses the ends of the range', () => {
    // At 0 or 100 one side escrows nothing. That is not a trade, it is a gift
    // with a settlement date — and an order that cannot lose.
    expect(isValidPrice(0)).toBe(false);
    expect(isValidPrice(100)).toBe(false);
    expect(isValidPrice(1)).toBe(true);
    expect(isValidPrice(99)).toBe(true);
  });

  it('refuses anything that is not a whole kobo', () => {
    expect(isValidPrice(62.5)).toBe(false);
    expect(isValidPrice(Number.NaN)).toBe(false);
  });

  it('reads one price from both ends of the book', () => {
    // A buyer bidding 65 crosses an ask of 62; a seller who will let the long
    // side go at 62 crosses a bid of 65. Same inequality, read from each end.
    expect(crosses('buy', 65, 62)).toBe(true);
    expect(crosses('buy', 60, 62)).toBe(false);
    expect(crosses('sell', 62, 65)).toBe(true);
    expect(crosses('sell', 66, 65)).toBe(false);
  });
});

describe('splitStake', () => {
  it('splits ₦1 a share between the two sides', () => {
    const split = splitStake(d('100'), 62);

    expect(split.long.toString()).toBe('62');
    expect(split.short.toString()).toBe('38');
    expect(split.long.plus(split.short).toString()).toBe(split.collateral.toString());
  });

  it('sums to exactly the collateral at every price, for an awkward size', () => {
    // The property the whole layer rests on. Independent roundings of
    // `s × p/100` and `s × (100−p)/100` are a quantum apart for sizes like
    // this; deriving the short by subtraction is what makes it exact.
    const shares = d('333.333333333333333333');
    for (let price = 1; price < KOBO_PER_SHARE; price += 1) {
      const split = splitStake(shares, price);
      expect(split.long.plus(split.short).equals(split.collateral)).toBe(true);
    }
  });

  it('quantises shares to the money scale before splitting', () => {
    // A matched share IS money — it pays exactly ₦1. Held finer than the money
    // columns, the collateral escrowed would be a hair under the payout owed,
    // on every fill, and the difference has only one place to come from.
    const split = splitStake(d('1.0000000000000000009'), 50);

    expect(split.collateral.decimalPlaces()).toBeLessThanOrEqual(18);
    expect(split.collateral.toString()).toBe('1');
  });

  it('never lets either side escrow nothing at a valid price', () => {
    for (let price = 1; price < KOBO_PER_SHARE; price += 1) {
      const split = splitStake(d('1'), price);
      expect(split.long.gt(0)).toBe(true);
      expect(split.short.gt(0)).toBe(true);
    }
  });
});

describe('unitCost and sharesFor', () => {
  it('prices the long at the quote and the short at the rest', () => {
    expect(unitCost('buy', 62).toString()).toBe('0.62');
    expect(unitCost('sell', 62).toString()).toBe('0.38');
  });

  it('rounds shares down, so nobody is handed a share they did not pay for', () => {
    // ₦100 at 62 kobo is 161.29… shares. The tail stays with the trader.
    const shares = sharesFor(d('100'), 'buy', 62);
    expect(shares.times(d('0.62')).lte(d('100'))).toBe(true);
  });

  it('reproduces the brief’s own arithmetic', () => {
    // "₦4,000 matching (exact payout ₦6,667)" — 4000 ÷ 0.60.
    const shares = sharesFor(d('4000'), 'buy', 60);
    expect(shares.toDecimalPlaces(2, Decimal.ROUND_DOWN).toString()).toBe('6666.66');
    // The brief quotes it rounded: "exact payout ₦6,667".
    expect(shares.toDecimalPlaces(0).toString()).toBe('6667');
  });
});

describe('cumulativeStake', () => {
  it('is monotone, so a fill never takes a negative stake', () => {
    let previous = d('0');
    for (const size of ['0', '1', '7.5', '100', '1000.000000000000000001']) {
      const at = cumulativeStake('sell', d(size), 37);
      expect(at.gte(previous)).toBe(true);
      previous = at;
    }
  });

  it('makes the parts of an order sum to exactly its whole lock', () => {
    // The reason per-fill stakes are differences rather than independent
    // roundings: an order swept across many fills has to leave a lock of
    // exactly zero. Floored separately, the parts drift a quantum per fill.
    for (const side of ['buy', 'sell'] as Side[]) {
      const total = d('997.777777777777777777');
      const whole = stakeFor(side, total, 37);

      const steps = ['111.111111111111111111', '333.333333333333333333', '553.333333333333333333'];
      let cumulative = d('0');
      let summed = d('0');
      for (const step of steps) {
        const before = cumulativeStake(side, cumulative, 37);
        cumulative = cumulative.plus(d(step));
        summed = summed.plus(cumulativeStake(side, cumulative, 37).minus(before));
      }

      expect(cumulative.toString()).toBe(total.toString());
      expect(summed.equals(whole)).toBe(true);
    }
  });
});

describe('sortForTaker', () => {
  const book = [
    order('c', 'u3', 62, '10', 3000),
    order('a', 'u1', 60, '10', 1000),
    order('b', 'u2', 62, '10', 1000),
  ];

  it('gives a buyer the cheapest ask first, oldest first inside a level', () => {
    expect(sortForTaker('buy', book).map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });

  it('gives a seller the highest bid first', () => {
    expect(sortForTaker('sell', book).map((o) => o.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks a dead tie the same way twice', () => {
    const tied = [order('z', 'u1', 50, '1', 5), order('y', 'u2', 50, '1', 5)];
    expect(sortForTaker('buy', tied).map((o) => o.id)).toEqual(['y', 'z']);
    expect(sortForTaker('buy', [...tied].reverse()).map((o) => o.id)).toEqual(['y', 'z']);
  });
});

describe('planMatch', () => {
  const asks = [order('a1', 'maker1', 60, '100', 1000), order('a2', 'maker2', 65, '100', 2000)];

  it('fills at the maker’s price, not the taker’s limit', () => {
    const plan = planMatch({
      takerSide: 'buy',
      limitKobo: 70,
      budget: d('30'),
      book: asks,
      takerUserId: 'taker',
    });

    // Price improvement belongs to whoever crossed the spread.
    expect(plan.fills).toHaveLength(1);
    expect(plan.fills[0]?.priceKobo).toBe(60);
    expect(plan.fills[0]?.shares.toString()).toBe('50');
  });

  it('sweeps levels in order and stops at the limit', () => {
    const plan = planMatch({
      takerSide: 'buy',
      limitKobo: 62,
      budget: d('1000'),
      book: asks,
      takerUserId: 'taker',
    });

    expect(plan.fills.map((f) => f.priceKobo)).toEqual([60]);
    // The 65 level is past the limit, so the rest of the budget survives to be
    // pot-filled or rested — never silently filled at a worse price.
    expect(plan.shares.toString()).toBe('100');
    expect(plan.remainingBudget.toString()).toBe('940');
  });

  it('sweeps past a level when the taker will pay for it', () => {
    const plan = planMatch({
      takerSide: 'buy',
      limitKobo: 70,
      budget: d('1000'),
      book: asks,
      takerUserId: 'taker',
    });

    expect(plan.fills.map((f) => f.priceKobo)).toEqual([60, 65]);
    expect(plan.shares.toString()).toBe('200');
  });

  it('escrows exactly ₦1 a share across the pair, on every fill', () => {
    const plan = planMatch({
      takerSide: 'buy',
      limitKobo: 99,
      budget: d('137.77'),
      book: [order('x', 'maker', 37, '9999', 1)],
      takerUserId: 'taker',
    });

    for (const fill of plan.fills) {
      expect(fill.takerStake.plus(fill.makerStake).equals(fill.shares)).toBe(true);
    }
  });

  it('never spends more than the budget', () => {
    for (const price of [1, 37, 50, 62, 99]) {
      const plan = planMatch({
        takerSide: 'buy',
        limitKobo: 99,
        budget: d('77.777777777777777777'),
        book: [order('x', 'maker', price, '100000', 1)],
        takerUserId: 'taker',
      });
      expect(plan.spent.lte(d('77.777777777777777777'))).toBe(true);
      expect(plan.remainingBudget.gte(0)).toBe(true);
    }
  });

  it('skips the taker’s own resting orders rather than washing', () => {
    const plan = planMatch({
      takerSide: 'buy',
      limitKobo: 99,
      budget: d('1000'),
      book: [order('mine', 'taker', 50, '100', 1), order('theirs', 'other', 55, '100', 2)],
      takerUserId: 'taker',
    });

    expect(plan.fills.map((f) => f.makerUserId)).toEqual(['other']);
  });

  it('takes a partially filled order only for what is left of it', () => {
    const partly = order('p', 'maker', 50, '100', 1, '90');
    expect(remainingOf(partly).toString()).toBe('10');

    const plan = planMatch({
      takerSide: 'buy',
      limitKobo: 99,
      budget: d('1000'),
      book: [partly],
      takerUserId: 'taker',
    });

    expect(plan.shares.toString()).toBe('10');
  });

  it('exhausts a maker’s lock to exactly zero across repeated partial fills', () => {
    // The case the difference-of-cumulatives exists for. A short maker filled
    // in five awkward slices must not end holding — or owing — a quantum.
    const price = 37;
    const total = d('1000');
    const whole = stakeFor('sell', total, price);
    let filled = d('0');
    let released = d('0');

    for (const slice of ['133.7', '299.9', '11.11', '455.29', '100']) {
      const plan = planMatch({
        takerSide: 'buy',
        limitKobo: 99,
        budget: stakeFor('buy', d(slice), price).plus(QUANTUM.times(10)),
        book: [
          {
            id: 'm',
            userId: 'maker',
            priceKobo: price,
            shares: total,
            filled,
            createdAt: new Date(0),
          },
        ],
        takerUserId: 'taker',
      });
      for (const fill of plan.fills) {
        released = released.plus(fill.makerStake);
        filled = filled.plus(fill.shares);
      }
    }

    expect(filled.toString()).toBe(total.toString());
    expect(released.equals(whole)).toBe(true);
  });

  it('returns the whole budget when the book is empty', () => {
    const plan = planMatch({
      takerSide: 'buy',
      limitKobo: null,
      budget: d('500'),
      book: [],
      takerUserId: 'taker',
    });

    expect(plan.fills).toHaveLength(0);
    expect(plan.remainingBudget.toString()).toBe('500');
  });

  it('matches a seller against the highest bid', () => {
    const bids = [order('b1', 'm1', 40, '100', 1), order('b2', 'm2', 45, '100', 2)];
    const plan = planMatch({
      takerSide: 'sell',
      limitKobo: 40,
      budget: d('1000'),
      book: bids,
      takerUserId: 'taker',
    });

    // Highest bid first: the short side pays 100 − p, so a higher long price is
    // the cheaper short.
    expect(plan.fills.map((f) => f.priceKobo)).toEqual([45, 40]);
  });
});

describe('depthLevels', () => {
  it('aggregates orders into levels a reader can act on', () => {
    const levels = depthLevels('buy', [
      order('a', 'u1', 62, '100', 1),
      order('b', 'u2', 62, '50', 2),
      order('c', 'u3', 60, '25', 3),
    ]);

    expect(levels.map((l) => l.priceKobo)).toEqual([60, 62]);
    expect(levels[1]?.shares.toString()).toBe('150');
    // What it would cost to sweep the level — the figure that goes beside a
    // price on a trade sheet.
    expect(levels[1]?.naira.toString()).toBe('93');
  });

  it('leaves out what is already filled', () => {
    const levels = depthLevels('buy', [order('a', 'u1', 62, '100', 1, '100')]);
    expect(levels).toHaveLength(0);
  });
});

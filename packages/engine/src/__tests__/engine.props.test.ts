import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  Decimal,
  type MarketState,
  buy,
  cost,
  openMarket,
  prices,
  resolve,
  seed,
  sell,
  stakedIdentityResidual,
} from '../index';

/** The tolerance the spec asks these properties to hold to. */
const TOLERANCE = new Decimal('1e-9');

const NUM_RUNS = 100;

const ZERO = new Decimal(0);

const sum = (values: readonly Decimal[]): Decimal => values.reduce((acc, v) => acc.plus(v), ZERO);

const within = (actual: Decimal, expected: Decimal, label: string): void => {
  const diff = actual.minus(expected).abs();
  expect(
    diff.lte(TOLERANCE),
    `${label}: ${actual.toString()} vs ${expected.toString()} (diff ${diff.toString()})`,
  ).toBe(true);
};

/**
 * A buy or a sell. Sells are expressed as a fraction of what the holder
 * actually has, so the generator can never manufacture shares that were never
 * bought — the engine would (correctly) reject those, and the interesting
 * property is what happens on the trades a real book would accept.
 */
type Op =
  | {
      readonly kind: 'buy';
      readonly holder: number;
      readonly outcome: number;
      readonly spend: Decimal;
    }
  | {
      readonly kind: 'sell';
      readonly holder: number;
      readonly outcome: number;
      readonly fraction: Decimal;
    };

/** Mixed magnitudes: a ₦0.05 punt and a ₦2,000,000 position in the same book. */
const MONEY_SCALES = ['0.01', '0.5', '10', '1000', '100000'] as const;
const LIQUIDITY_SCALES = ['25', '500', '10000', '2500000'] as const;
const SELL_FRACTIONS = ['0.05', '0.25', '0.5', '0.9', '1'] as const;

const opArb = (outcomes: number, holders: number): fc.Arbitrary<Op> =>
  fc.oneof(
    fc.record({
      kind: fc.constant('buy' as const),
      holder: fc.integer({ min: 0, max: holders - 1 }),
      outcome: fc.integer({ min: 0, max: outcomes - 1 }),
      spend: fc
        .tuple(fc.integer({ min: 1, max: 9999 }), fc.constantFrom(...MONEY_SCALES))
        .map(([units, scale]) => new Decimal(units).times(scale)),
    }),
    fc.record({
      kind: fc.constant('sell' as const),
      holder: fc.integer({ min: 0, max: holders - 1 }),
      outcome: fc.integer({ min: 0, max: outcomes - 1 }),
      fraction: fc.constantFrom(...SELL_FRACTIONS).map((f) => new Decimal(f)),
    }),
  );

interface Scenario {
  readonly outcomes: number;
  readonly holders: number;
  readonly liquidity: Decimal;
  readonly ops: readonly Op[];
  /**
   * A Path B symmetric seed posted before the market opens, or null for a
   * market that opens flat. Seeded markets are the ones where conservation is
   * easiest to get wrong — the seeder's shares are outstanding from the first
   * trade onwards and have to be paid like anyone else's.
   */
  readonly seedPerOutcome: Decimal | null;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .tuple(
    fc.integer({ min: 2, max: 8 }),
    fc.integer({ min: 1, max: 4 }),
    fc.constantFrom(...LIQUIDITY_SCALES).map((l) => new Decimal(l)),
    fc.option(
      fc.constantFrom('1', '2000', '20000', '500000').map((v) => new Decimal(v)),
      { nil: null },
    ),
  )
  .chain(([outcomes, holders, liquidity, seedPerOutcome]) =>
    fc
      .array(opArb(outcomes, holders), { minLength: 1, maxLength: 12 })
      .map((ops) => ({ outcomes, holders, liquidity, ops, seedPerOutcome })),
  );

/** Books per holder, per outcome. Mirrors the engine's own share arithmetic. */
class Book {
  private readonly shares: Decimal[][];

  constructor(holders: number, outcomes: number) {
    this.shares = Array.from({ length: holders }, () =>
      Array.from({ length: outcomes }, () => ZERO),
    );
  }

  get(holder: number, outcome: number): Decimal {
    return this.shares[holder]?.[outcome] ?? ZERO;
  }

  add(holder: number, outcome: number, delta: Decimal): void {
    const row = this.shares[holder];
    if (row === undefined) return;
    row[outcome] = this.get(holder, outcome).plus(delta);
  }

  subtract(holder: number, outcome: number, delta: Decimal): void {
    const row = this.shares[holder];
    if (row === undefined) return;
    row[outcome] = this.get(holder, outcome).minus(delta);
  }

  holdersOf(outcome: number): { holderId: string; shares: Decimal }[] {
    return this.shares
      .map((row, holder) => ({ holderId: `h${holder}`, shares: row[outcome] ?? ZERO }))
      .filter((h) => h.shares.gt(0));
  }

  everyPosition(): { holder: number; outcome: number; shares: Decimal }[] {
    return this.shares.flatMap((row, holder) =>
      row.map((shares, outcome) => ({ holder, outcome, shares })).filter((p) => p.shares.gt(0)),
    );
  }
}

/** Shares of `outcome` that may be sold before hitting the opening vector. */
const sellableOf = (state: MarketState, outcome: number): Decimal =>
  (state.q[outcome] ?? ZERO).minus(state.q0[outcome] ?? ZERO);

/** Replay a scenario, asserting the per-operation invariants as it goes. */
function run(scenario: Scenario): { state: MarketState; book: Book } {
  let state = openMarket({ outcomes: scenario.outcomes, liquidity: scenario.liquidity });
  // The seeder gets a book row of its own, past the trading holders.
  const book = new Book(scenario.holders + 1, scenario.outcomes);
  const seeder = scenario.holders;

  if (scenario.seedPerOutcome !== null) {
    const seeded = seed(state, scenario.seedPerOutcome);
    state = seeded.state;
    for (let outcome = 0; outcome < scenario.outcomes; outcome += 1) {
      book.add(seeder, outcome, seeded.sharesPerOutcome);
    }
  }

  const checkAfterOp = (current: MarketState): void => {
    const p = prices(current.q, current.liquidity);
    within(sum(p), new Decimal(1), 'prices must sum to 1');
    for (const pi of p) {
      expect(pi.gte(0) && pi.lte(1), `price out of [0,1]: ${pi.toString()}`).toBe(true);
    }

    const travelled = cost(current.q, current.liquidity).minus(cost(current.q0, current.liquidity));
    within(current.pot, travelled, 'pot must equal C(q) − C(q0)');

    expect(
      current.pot.gte(TOLERANCE.negated()),
      `pot went negative: ${current.pot.toString()}`,
    ).toBe(true);

    // Every naira in the pot is staked on some outcome — this is what makes the
    // losing pool, and therefore the resolution fee, a well-defined quantity.
    within(stakedIdentityResidual(current), ZERO, 'Σstaked must reconcile to the pot');
  };

  for (const op of scenario.ops) {
    if (op.kind === 'buy') {
      const result = buy(state, op.outcome, op.spend);
      state = result.state;
      book.add(op.holder, op.outcome, result.shares);
    } else {
      const held = book.get(op.holder, op.outcome);
      if (held.lte(0)) continue;
      // fraction 1 sells the whole holding, so a full exit lands on q0.
      const wanted = op.fraction.eq(1) ? held : held.times(op.fraction);
      // A book kept per holder re-associates the same additions the engine makes
      // in one running total, so the two can disagree in the last digit. Clamp to
      // what is actually outstanding, the way a reconciled position would.
      const delta = Decimal.min(wanted, sellableOf(state, op.outcome));
      if (delta.lte(0)) continue;
      const result = sell(state, op.outcome, delta);
      state = result.state;
      book.subtract(op.holder, op.outcome, delta);
    }
    checkAfterOp(state);
  }

  return { state, book };
}

describe('engine invariants (property-based)', () => {
  it('prices sum to 1 and the pot identity holds after every buy/sell', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        run(scenario);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('the pot is never negative, including when every position is fully exited', () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { state, book } = run(scenario);

        let current = state;
        for (const position of book.everyPosition()) {
          const delta = Decimal.min(position.shares, sellableOf(current, position.outcome));
          if (delta.lte(0)) continue;
          const result = sell(current, position.outcome, delta);
          current = result.state;
          expect(
            current.pot.gte(TOLERANCE.negated()),
            `pot went negative mid-exit: ${current.pot.toString()}`,
          ).toBe(true);
        }

        // Everyone is out: shares outstanding are back at the opening vector and
        // the pot is empty, not merely small and not negative.
        for (const [i, qi] of current.q.entries()) {
          within(qi, current.q0[i] ?? ZERO, `outcome ${i} did not return to q0`);
        }
        within(current.pot, ZERO, 'a fully exited market must hold nothing');
        expect(current.pot.gte(TOLERANCE.negated())).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('resolution conserves the pot exactly: Σpayouts + fee === pot', () => {
    fc.assert(
      fc.property(
        scenarioArb,
        fc.integer({ min: 0, max: 7 }),
        fc.constantFrom('0', '0.03', '0.07', '0.1'),
        (scenario, winnerSeed, feeRate) => {
          const { state, book } = run(scenario);
          const winner = winnerSeed % scenario.outcomes;
          const holdings = book.holdersOf(winner);

          // Nobody is holding the winning outcome: nothing to conserve.
          if (holdings.length === 0) return;

          const result = resolve(state, winner, feeRate, holdings);
          const paid = sum(result.payouts.map((p) => p.payout));

          within(paid.plus(result.fee), state.pot, 'payouts + fee must equal the pot');
          within(result.residual, ZERO, 'resolution residual');
          within(
            result.losingPool,
            state.pot.minus(state.staked[winner] ?? ZERO),
            'losing pool must be everything staked off the winning outcome',
          );
          within(result.fee, result.losingPool.times(feeRate), 'fee must be losingPool × feeRate');
          expect(
            result.fee.lte(state.pot.plus(TOLERANCE)),
            `fee ${result.fee.toString()} exceeded the pot ${state.pot.toString()}`,
          ).toBe(true);
          for (const payout of result.payouts) {
            expect(payout.payout.gte(0), `payout was negative: ${payout.payout.toString()}`).toBe(
              true,
            );
          }
          expect(result.state.pot.isZero()).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

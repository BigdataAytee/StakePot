import { Decimal } from '@stakeam/engine';
import { describe, expect, it } from 'vitest';

import { decideActivation, type ActivationRules, type OutcomeFunding } from './activation';

const rules: ActivationRules = {
  minPoolPerOutcome: new Decimal(20_000),
  minBackers: 10,
  mode: 'per_outcome',
  minTotalPot: new Decimal(60_000),
  minFundedOutcomes: 2,
};

const outcome = (over: Partial<OutcomeFunding> = {}): OutcomeFunding => ({
  outcomeId: over.outcomeId ?? 'o1',
  label: over.label ?? 'YES',
  isOther: over.isOther ?? false,
  pool: over.pool ?? new Decimal(25_000),
  backers: over.backers ?? 12,
});

describe('Path A activation — the rulebook rule', () => {
  it('activates when every pool and the backer floor are met', () => {
    const decision = decideActivation(
      [outcome(), outcome({ outcomeId: 'o2', label: 'NO' })],
      rules,
    );
    expect(decision.activate).toBe(true);
  });

  it('voids when one side is short, naming the side and the gap', () => {
    const decision = decideActivation(
      [outcome(), outcome({ outcomeId: 'o2', label: 'NO', pool: new Decimal(9_000) })],
      rules,
    );
    expect(decision.activate).toBe(false);
    if (!decision.activate) {
      expect(decision.reason).toContain('NO');
      expect(decision.reason).toContain('9000');
    }
  });

  it('voids when the backer floor is missed, however much money arrived', () => {
    const decision = decideActivation(
      [
        outcome({ pool: new Decimal(500_000), backers: 3 }),
        outcome({ outcomeId: 'o2', label: 'NO', pool: new Decimal(500_000), backers: 2 }),
      ],
      rules,
    );
    expect(decision.activate).toBe(false);
    if (!decision.activate) expect(decision.reason).toContain('backers');
  });
});

describe('the §2.9 amendment for wide fields', () => {
  const amended: ActivationRules = { ...rules, mode: 'total_pot' };

  it('activates a well-backed five-way race the strict rule would void', () => {
    const field = [
      outcome({ outcomeId: 'a', label: 'Adeyemi', pool: new Decimal(30_000) }),
      outcome({ outcomeId: 'b', label: 'Bello', pool: new Decimal(25_000) }),
      outcome({ outcomeId: 'c', label: 'Chukwu', pool: new Decimal(8_000) }),
      outcome({ outcomeId: 'd', label: 'Danladi', pool: new Decimal(2_000) }),
      outcome({ outcomeId: 'e', label: 'Any other', isOther: true, pool: new Decimal(500) }),
    ];

    // This is exactly the case the backtest flagged: a real market with tails.
    expect(decideActivation(field, rules).activate).toBe(false);
    expect(decideActivation(field, amended).activate).toBe(true);
  });

  it('still voids a field where only one candidate was ever funded', () => {
    const decision = decideActivation(
      [
        outcome({ outcomeId: 'a', label: 'Adeyemi', pool: new Decimal(65_000) }),
        outcome({ outcomeId: 'b', label: 'Bello', pool: new Decimal(400) }),
        outcome({ outcomeId: 'c', label: 'Any other', isOther: true, pool: new Decimal(100) }),
      ],
      amended,
    );
    expect(decision.activate).toBe(false);
    if (!decision.activate) expect(decision.reason).toContain('funded');
  });

  it('does not require the catch-all bucket to be funded', () => {
    const decision = decideActivation(
      [
        outcome({ outcomeId: 'a', label: 'Adeyemi', pool: new Decimal(30_000) }),
        outcome({ outcomeId: 'b', label: 'Bello', pool: new Decimal(30_000) }),
        outcome({ outcomeId: 'c', label: 'Any other', isOther: true, pool: new Decimal(0) }),
      ],
      amended,
    );
    expect(decision.activate).toBe(true);
  });
});

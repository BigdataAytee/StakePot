import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ABUSE_RULES,
  detect,
  multiAccount,
  stakeFlood,
  washTrading,
  type AccountRow,
  type TradeRow,
} from './abuse';

const at = (minutes: number): Date => new Date(Date.UTC(2026, 0, 1, 0, minutes));

const trade = (over: Partial<TradeRow> & { at: Date }): TradeRow => ({
  userId: 'u1',
  marketId: 'm1',
  side: 'buy',
  cost: 1000,
  ...over,
});

/** `count` alternating buy/sell pairs, each round trip inside the window. */
const roundTrips = (count: number, gap = 5): TradeRow[] =>
  Array.from({ length: count * 2 }, (_, index) =>
    trade({ side: index % 2 === 0 ? 'buy' : 'sell', at: at(index * gap) }),
  );

describe('wash trading', () => {
  it('leaves an ordinary change of mind alone', () => {
    expect(washTrading(roundTrips(2), DEFAULT_ABUSE_RULES)).toEqual([]);
  });

  it('flags repeated round trips inside the window', () => {
    const flags = washTrading(roundTrips(5), DEFAULT_ABUSE_RULES);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.kind).toBe('wash_trading');
    expect(flags[0]?.evidence['roundTrips']).toBe(5);
  });

  it('does not count a round trip that took all day', () => {
    // Buying in the morning and selling at night is a position, not a wash.
    const slow = Array.from({ length: 10 }, (_, index) =>
      trade({ side: index % 2 === 0 ? 'buy' : 'sell', at: at(index * 120) }),
    );
    expect(washTrading(slow, DEFAULT_ABUSE_RULES)).toEqual([]);
  });

  it('ignores seeds, which are not directional', () => {
    const seeded = Array.from({ length: 12 }, (_, index) =>
      trade({ side: 'seed', at: at(index * 5) }),
    );
    expect(washTrading(seeded, DEFAULT_ABUSE_RULES)).toEqual([]);
  });

  it('keeps markets separate', () => {
    // Two round trips on each of three markets is not a wash on any of them.
    const spread = ['m1', 'm2', 'm3'].flatMap((marketId) =>
      roundTrips(2).map((row) => ({ ...row, marketId })),
    );
    expect(washTrading(spread, DEFAULT_ABUSE_RULES)).toEqual([]);
  });

  it('carries the evidence a reviewer needs', () => {
    const flags = washTrading(roundTrips(6), DEFAULT_ABUSE_RULES);
    expect(flags[0]?.evidence).toMatchObject({
      marketId: 'm1',
      roundTrips: 6,
      windowMinutes: DEFAULT_ABUSE_RULES.washWindowMinutes,
    });
    expect(flags[0]?.summary.length).toBeGreaterThan(0);
  });
});

describe('stake floods', () => {
  it('leaves a busy human alone', () => {
    const busy = Array.from({ length: 40 }, (_, index) => trade({ at: at(index) }));
    expect(stakeFlood(busy, DEFAULT_ABUSE_RULES)).toEqual([]);
  });

  it('flags a script', () => {
    const script = Array.from({ length: 150 }, (_, index) =>
      trade({ at: new Date(at(0).getTime() + index * 20_000) }),
    );
    const flags = stakeFlood(script, DEFAULT_ABUSE_RULES);
    expect(flags[0]?.kind).toBe('stake_flood');
    expect(Number(flags[0]?.evidence['peakTradesPerHour'])).toBeGreaterThanOrEqual(120);
  });

  it('uses a sliding hour, not a calendar one', () => {
    // 119 trades either side of the hour mark is the pattern a calendar-hour
    // counter would miss entirely.
    const straddling = [
      ...Array.from({ length: 70 }, (_, index) =>
        trade({ at: new Date(at(30).getTime() + index * 20_000) }),
      ),
      ...Array.from({ length: 70 }, (_, index) =>
        trade({ at: new Date(at(55).getTime() + index * 20_000) }),
      ),
    ];
    expect(stakeFlood(straddling, DEFAULT_ABUSE_RULES).length).toBe(1);
  });

  it('keeps accounts separate', () => {
    const two = Array.from({ length: 200 }, (_, index) =>
      trade({
        userId: index % 2 === 0 ? 'a' : 'b',
        at: new Date(at(0).getTime() + index * 20_000),
      }),
    );
    expect(stakeFlood(two, DEFAULT_ABUSE_RULES)).toEqual([]);
  });
});

describe('multi-account clusters', () => {
  const account = (over: Partial<AccountRow> & { userId: string }): AccountRow => ({
    fingerprint: 'device-1',
    tier: 0,
    createdAt: at(0),
    ...over,
  });

  it('treats a household as a household', () => {
    const household = [account({ userId: 'a', tier: 1 }), account({ userId: 'b', tier: 1 })];
    expect(multiAccount(household, DEFAULT_ABUSE_RULES)).toEqual([]);
  });

  it('flags a farm of unverified accounts', () => {
    const farm = Array.from({ length: 6 }, (_, index) =>
      account({ userId: `f${index}`, createdAt: at(index * 3) }),
    );
    const flags = multiAccount(farm, DEFAULT_ABUSE_RULES);
    // One row per account, so a reviewer can clear one without clearing all.
    expect(flags).toHaveLength(6);
    expect(flags[0]?.evidence['accounts']).toBe(6);
    expect(flags[0]?.evidence['unverified']).toBe(6);
  });

  it('weighs a verified cluster lower than an unverified one', () => {
    const unverified = Array.from({ length: 5 }, (_, index) => account({ userId: `u${index}` }));
    const verified = Array.from({ length: 5 }, (_, index) =>
      account({ userId: `v${index}`, tier: 1 }),
    );
    const worst = multiAccount(unverified, DEFAULT_ABUSE_RULES)[0]?.severity ?? 0;
    const mild = multiAccount(verified, DEFAULT_ABUSE_RULES)[0]?.severity ?? 0;
    // A cluster that has paid for a verified contact each is the gate working.
    expect(worst).toBeGreaterThan(mild);
  });

  it('ignores accounts with no fingerprint rather than grouping them together', () => {
    const unknown = Array.from({ length: 8 }, (_, index) =>
      account({ userId: `n${index}`, fingerprint: null }),
    );
    expect(multiAccount(unknown, DEFAULT_ABUSE_RULES)).toEqual([]);
  });

  it('names the other accounts in the cluster', () => {
    const farm = Array.from({ length: 4 }, (_, index) => account({ userId: `f${index}` }));
    const flags = multiAccount(farm, DEFAULT_ABUSE_RULES);
    expect(String(flags[0]?.evidence['others'])).toContain('f1');
    expect(String(flags[0]?.evidence['others'])).not.toContain('f0');
  });
});

describe('detect', () => {
  it('orders the queue by severity', () => {
    const flags = detect(
      {
        trades: [
          ...roundTrips(8),
          ...Array.from({ length: 200 }, (_, index) =>
            trade({ userId: 'flooder', at: new Date(at(0).getTime() + index * 15_000) }),
          ),
        ],
        accounts: [],
      },
      DEFAULT_ABUSE_RULES,
    );
    expect(flags.length).toBeGreaterThan(1);
    const severities = flags.map((flag) => flag.severity);
    expect(severities).toEqual([...severities].sort((a, b) => b - a));
  });

  it('finds nothing in an ordinary week', () => {
    expect(
      detect(
        {
          trades: Array.from({ length: 20 }, (_, index) => trade({ at: at(index * 30) })),
          accounts: [{ userId: 'a', fingerprint: 'd1', tier: 1, createdAt: at(0) }],
        },
        DEFAULT_ABUSE_RULES,
      ),
    ).toEqual([]);
  });
});

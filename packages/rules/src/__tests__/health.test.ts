import { describe, expect, it } from 'vitest';

import { healthFlags, type MarketHealthFacts } from '../health';

/**
 * Part 5, one flag at a time.
 *
 * The interesting assertions here are the negatives. Every one of these rules
 * is easy to implement in a way that fires constantly — a market is 100/0 in
 * its first hour, and every market is "unresolved" until it settles — and a
 * flag that fires on everything is worse than no flag, because it teaches the
 * Manage tab's reader to scroll past the column.
 */
const NOW = new Date('2026-08-20T12:00:00.000Z');
const HOUR = 3_600_000;

function facts(overrides: Partial<MarketHealthFacts> = {}): MarketHealthFacts {
  return {
    marketId: 'm1',
    state: 'active',
    openedAt: new Date(NOW.getTime() - 72 * HOUR),
    eventDate: new Date(NOW.getTime() + 72 * HOUR),
    leadingShare: 0.55,
    largestHolderShare: 0.1,
    holders: 20,
    resolutionProposed: false,
    ...overrides,
  };
}

describe('rule 35 — the split after 48 hours', () => {
  it('flags a market running past 75/25', () => {
    const flags = healthFlags(facts({ leadingShare: 0.82 }), NOW);
    expect(flags.map((flag) => flag.rule)).toContain('35');
  });

  it('says nothing about a young market that is lopsided because one person traded', () => {
    const flags = healthFlags(
      facts({ leadingShare: 1, openedAt: new Date(NOW.getTime() - 2 * HOUR) }),
      NOW,
    );
    expect(flags.map((flag) => flag.rule)).not.toContain('35');
  });

  it('says nothing about a balanced market', () => {
    expect(healthFlags(facts(), NOW).map((flag) => flag.rule)).not.toContain('35');
  });
});

describe('rule 36 — one-sided whale entry', () => {
  it('flags a single dominant early position', () => {
    const flags = healthFlags(
      facts({
        openedAt: new Date(NOW.getTime() - 6 * HOUR),
        largestHolderShare: 0.7,
        holders: 3,
      }),
      NOW,
    );
    expect(flags.find((flag) => flag.rule === '36')?.severity).toBe('act');
  });

  it('leaves an established market alone', () => {
    // The same concentration a week in is a conviction, not a distortion:
    // everybody else has had time to take the other side and has not.
    const flags = healthFlags(
      facts({ openedAt: new Date(NOW.getTime() - 168 * HOUR), largestHolderShare: 0.7 }),
      NOW,
    );
    expect(flags.map((flag) => flag.rule)).not.toContain('36');
  });
});

describe('rules 38 and 39 — settlement', () => {
  it('warns when the event is hours away', () => {
    const flags = healthFlags(facts({ eventDate: new Date(NOW.getTime() + 4 * HOUR) }), NOW);
    expect(flags.map((flag) => flag.rule)).toContain('38');
  });

  it('escalates once the event has passed unresolved for a day', () => {
    const flags = healthFlags(
      facts({ state: 'frozen', eventDate: new Date(NOW.getTime() - 30 * HOUR) }),
      NOW,
    );
    expect(flags.find((flag) => flag.rule === '39')?.severity).toBe('act');
  });

  it('stays quiet once somebody has proposed one', () => {
    const flags = healthFlags(
      facts({
        state: 'pending_resolution',
        eventDate: new Date(NOW.getTime() - 30 * HOUR),
        resolutionProposed: true,
      }),
      NOW,
    );
    expect(flags).toEqual([]);
  });
});

describe('a market with more than one problem', () => {
  it('reports both rather than the worst', () => {
    const flags = healthFlags(
      facts({ leadingShare: 0.9, eventDate: new Date(NOW.getTime() + 3 * HOUR) }),
      NOW,
    );
    expect(flags.map((flag) => flag.rule).sort()).toEqual(['35', '38']);
  });
});

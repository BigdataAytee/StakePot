import { describe, expect, it } from 'vitest';

import {
  accuracyOf,
  ALL_TIME,
  bestStreak,
  currentStreak,
  DEFAULT_BOARD_RULES,
  eligible,
  isoWeekOf,
  profitOf,
  rank,
  topForecaster,
  weekWindow,
  type TraderRecord,
} from './scoring';

const trader = (over: Partial<TraderRecord> & { userId: string }): TraderRecord => ({
  staked: 10_000,
  returned: 12_000,
  marketsWon: 6,
  marketsSettled: 10,
  tier: 1,
  ...over,
});

describe('leaderboard scoring', () => {
  it('measures profit as what came back less what went in', () => {
    expect(profitOf(trader({ userId: 'a', staked: 10_000, returned: 12_500 }))).toBe(2_500);
    expect(profitOf(trader({ userId: 'b', staked: 10_000, returned: 4_000 }))).toBe(-6_000);
  });

  it('has no accuracy before anything has settled', () => {
    // Zero settled is not zero accuracy; ranking it last would be a claim
    // about somebody that the rows do not support.
    expect(accuracyOf(trader({ userId: 'new', marketsSettled: 0, marketsWon: 0 }))).toBeNull();
  });

  it('keeps Tier 0 accounts off both boards, per §2.1', () => {
    const unverified = trader({ userId: 'tier0', tier: 0 });
    expect(eligible(unverified, 'profit', DEFAULT_BOARD_RULES)).toBe(false);
    expect(eligible(unverified, 'accuracy', DEFAULT_BOARD_RULES)).toBe(false);
  });

  it('keeps a one-market wonder off the accuracy board', () => {
    const lucky = trader({ userId: 'lucky', marketsSettled: 1, marketsWon: 1 });
    expect(eligible(lucky, 'accuracy', DEFAULT_BOARD_RULES)).toBe(false);
    // But they can still place on profit if they staked enough.
    expect(eligible(lucky, 'profit', DEFAULT_BOARD_RULES)).toBe(true);
  });

  it('keeps a trivial staker off the profit board', () => {
    const tiny = trader({ userId: 'tiny', staked: 999, returned: 5_000 });
    expect(eligible(tiny, 'profit', DEFAULT_BOARD_RULES)).toBe(false);
  });

  it('ranks the profit board by profit', () => {
    const board = rank(
      [
        trader({ userId: 'a', staked: 10_000, returned: 11_000 }),
        trader({ userId: 'b', staked: 10_000, returned: 30_000 }),
        trader({ userId: 'c', staked: 10_000, returned: 9_000 }),
      ],
      'profit',
      DEFAULT_BOARD_RULES,
    );
    expect(board.map((entry) => entry.userId)).toEqual(['b', 'a', 'c']);
    expect(board.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it('ranks the accuracy board by accuracy, not profit', () => {
    const board = rank(
      [
        // Big profit, mediocre record.
        trader({ userId: 'whale', marketsWon: 5, marketsSettled: 10, returned: 90_000 }),
        // Small profit, excellent record.
        trader({ userId: 'sharp', marketsWon: 9, marketsSettled: 10, returned: 10_500 }),
      ],
      'accuracy',
      DEFAULT_BOARD_RULES,
    );
    expect(board[0]?.userId).toBe('sharp');
  });

  it('shares a rank on a tie and skips the next position', () => {
    const board = rank(
      [
        trader({ userId: 'a', returned: 20_000, marketsWon: 8 }),
        trader({ userId: 'b', returned: 15_000, marketsWon: 8 }),
        trader({ userId: 'c', returned: 15_000, marketsWon: 8 }),
        trader({ userId: 'd', returned: 11_000, marketsWon: 8 }),
      ],
      'profit',
      DEFAULT_BOARD_RULES,
    );
    // 1, 2, 2, 4 — the tie shares a standing, and the next distinct score takes
    // the position it would have had.
    expect(board.map((entry) => entry.rank)).toEqual([1, 2, 2, 4]);
  });

  it('produces the same table twice from the same rows', () => {
    const records = [
      trader({ userId: 'zeta', returned: 15_000, marketsWon: 7 }),
      trader({ userId: 'alpha', returned: 15_000, marketsWon: 7 }),
      trader({ userId: 'mid', returned: 15_000, marketsWon: 7 }),
    ];
    const first = rank(records, 'profit', DEFAULT_BOARD_RULES);
    const second = rank([...records].reverse(), 'profit', DEFAULT_BOARD_RULES);
    // A board whose order wobbles between refreshes is one nobody believes.
    expect(first.map((entry) => entry.userId)).toEqual(second.map((entry) => entry.userId));
  });

  it('counts a streak up to the first miss', () => {
    expect(currentStreak([true, true, true, false, true])).toBe(3);
    expect(currentStreak([false, true, true])).toBe(0);
    expect(currentStreak([])).toBe(0);
  });

  it('remembers the best run even after it breaks', () => {
    expect(bestStreak([true, true, false, true, true, true, false])).toBe(3);
    expect(bestStreak([])).toBe(0);
  });

  it('names the top forecasters from a settled board', () => {
    const board = rank(
      [
        trader({ userId: 'a', marketsWon: 9 }),
        trader({ userId: 'b', marketsWon: 8 }),
        trader({ userId: 'c', marketsWon: 7 }),
        trader({ userId: 'd', marketsWon: 1 }),
      ],
      'accuracy',
      DEFAULT_BOARD_RULES,
    );
    expect(topForecaster(board, 3)).toEqual(['a', 'b', 'c']);
  });

  it('keys a week the way ISO 8601 does', () => {
    // 2026-01-01 is a Thursday, so it lands in week 1 of 2026.
    expect(isoWeekOf(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    // The Monday before it belongs to the last week of 2025.
    expect(isoWeekOf(new Date('2025-12-29T12:00:00Z'))).toBe('2026-W01');
    expect(isoWeekOf(new Date('2026-08-18T12:00:00Z'))).toBe('2026-W34');
  });

  it('gives a week a half-open window that tiles', () => {
    const first = weekWindow('2026-W34');
    const second = weekWindow('2026-W35');
    expect(first.end.toISOString()).toBe(second.start.toISOString());
    expect(first.start.getUTCDay()).toBe(1);
    expect(isoWeekOf(first.start)).toBe('2026-W34');
    // The last instant before the boundary still belongs to the first week.
    expect(isoWeekOf(new Date(first.end.getTime() - 1))).toBe('2026-W34');
  });

  it('has an all-time key that never rolls over', () => {
    expect(ALL_TIME).toBe('all-time');
    expect(() => weekWindow(ALL_TIME)).toThrow();
  });
});

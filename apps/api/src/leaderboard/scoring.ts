/**
 * §2.8's leaderboards, as rules.
 *
 * "Weekly + all-time leaderboards (profit, accuracy %)."
 *
 * Two numbers, and they measure different people. Profit rewards size and
 * nerve; accuracy rewards being right, which is the thing §2.15b calls "real
 * social capital (vs unverifiable WhatsApp tipsters)". Neither is a good board
 * on its own — a board on profit alone is a board of whoever staked most, and a
 * board on accuracy alone is a board of whoever placed one lucky stake — so
 * both exist and both carry a sample-size floor.
 *
 * Pure, because a leaderboard is a public claim about people and has to be
 * reproducible from the rows it was computed from.
 */

export type Board = 'profit' | 'accuracy';

/** What one account did over a period, counted from settled markets only. */
export interface TraderRecord {
  readonly userId: string;
  /** Settled stake, in SPC — the denominator profit is measured against. */
  readonly staked: number;
  /** Payouts received from settled markets, in SPC. */
  readonly returned: number;
  /** Settled markets where they held the winning outcome. */
  readonly marketsWon: number;
  /** Settled markets they had any position in. */
  readonly marketsSettled: number;
  /** Tier 1 is §2.1's gate: leaderboards and prizes need a verified contact. */
  readonly tier: number;
}

export interface BoardRules {
  /** Settled markets below this and accuracy is noise, not a record. */
  readonly minMarketsForAccuracy: number;
  /** Stake below this and profit is noise too. */
  readonly minStakedForProfit: number;
  /** §2.1: "Unlocks ... leaderboards, and prize eligibility." */
  readonly minTier: number;
}

export const DEFAULT_BOARD_RULES: BoardRules = {
  minMarketsForAccuracy: 5,
  minStakedForProfit: 1_000,
  minTier: 1,
};

export interface Ranked {
  readonly userId: string;
  readonly rank: number;
  readonly profit: number;
  readonly accuracy: number;
  readonly marketsSettled: number;
  readonly staked: number;
}

/** Net profit over the period: what came back, less what went in. */
export function profitOf(record: TraderRecord): number {
  return record.returned - record.staked;
}

/**
 * Share of settled markets called right, 0–1.
 *
 * Zero settled markets is **not** zero accuracy — it is no accuracy, and the
 * eligibility rules keep those accounts off the board rather than ranking them
 * last. Returning 0 here would sort a brand-new account below somebody with a
 * genuinely bad record, which is not a fact about either of them.
 */
export function accuracyOf(record: TraderRecord): number | null {
  if (record.marketsSettled === 0) return null;
  return record.marketsWon / record.marketsSettled;
}

/** Whether a record may appear on a board at all. */
export function eligible(record: TraderRecord, board: Board, rules: BoardRules): boolean {
  if (record.tier < rules.minTier) return false;
  if (board === 'accuracy') {
    return record.marketsSettled >= rules.minMarketsForAccuracy;
  }
  return record.staked >= rules.minStakedForProfit;
}

/**
 * Rank a board.
 *
 * Ties are broken deterministically — by the other metric first, then by user id
 * — so two runs over the same rows produce the same table. A leaderboard whose
 * order wobbles between refreshes is one nobody believes, and the snapshot
 * written to `leaderboard_snapshots` has to be reproducible from its inputs.
 *
 * Equal scores share a rank (1, 2, 2, 4) rather than being ordered arbitrarily:
 * the tiebreak decides display order, not standing.
 */
export function rank(
  records: readonly TraderRecord[],
  board: Board,
  rules: BoardRules,
): readonly Ranked[] {
  const eligibleRecords = records.filter((record) => eligible(record, board, rules));

  const scored = eligibleRecords.map((record) => ({
    userId: record.userId,
    profit: profitOf(record),
    accuracy: accuracyOf(record) ?? 0,
    marketsSettled: record.marketsSettled,
    staked: record.staked,
  }));

  const primary = (entry: (typeof scored)[number]): number =>
    board === 'profit' ? entry.profit : entry.accuracy;
  const secondary = (entry: (typeof scored)[number]): number =>
    board === 'profit' ? entry.accuracy : entry.profit;

  const sorted = [...scored].sort((left, right) => {
    if (primary(right) !== primary(left)) return primary(right) - primary(left);
    if (secondary(right) !== secondary(left)) return secondary(right) - secondary(left);
    return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
  });

  const ranked: Ranked[] = [];
  let lastScore: number | null = null;
  let lastRank = 0;

  for (const [index, entry] of sorted.entries()) {
    const score = primary(entry);
    // Equal scores share a rank; the next distinct score takes the position it
    // would have had, so 1, 2, 2, 4 rather than 1, 2, 2, 3.
    const position = lastScore !== null && score === lastScore ? lastRank : index + 1;
    lastScore = score;
    lastRank = position;
    ranked.push({ ...entry, rank: position });
  }

  return ranked;
}

/**
 * §2.8's streaks.
 *
 * Counted over settled markets in the order they settled, most recent first.
 * A streak is the run of correct calls up to and including the latest one — it
 * breaks on the first miss, because a streak that survived misses would not be
 * a streak.
 */
export function currentStreak(outcomes: readonly boolean[]): number {
  let streak = 0;
  for (const won of outcomes) {
    if (!won) break;
    streak += 1;
  }
  return streak;
}

/** The longest run anywhere in the record, for the badge that keeps its value. */
export function bestStreak(outcomes: readonly boolean[]): number {
  let best = 0;
  let running = 0;
  for (const won of outcomes) {
    running = won ? running + 1 : 0;
    if (running > best) best = running;
  }
  return best;
}

/**
 * §2.8's "Top Forecaster" badge.
 *
 * Earned by finishing a completed period in the top slice of the accuracy
 * board, not by sitting there mid-week: a badge that appears and disappears as
 * the week moves is a notification, not an honour.
 */
export function topForecaster(rankedAccuracy: readonly Ranked[], topN = 3): readonly string[] {
  return rankedAccuracy.filter((entry) => entry.rank <= topN).map((entry) => entry.userId);
}

/**
 * The ISO week a moment falls in, as `YYYY-Www`.
 *
 * The period key is a string in `leaderboard_snapshots`, so it has to be one
 * the database can sort and a human can read. ISO weeks start Monday, which
 * matches how a "weekly" competition is actually run and settled.
 */
export function isoWeekOf(at: Date): string {
  const date = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // Thursday of the current week decides the year, per ISO 8601.
  const day = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The half-open window a weekly period covers: [start, end). */
export function weekWindow(period: string): { start: Date; end: Date } {
  const match = /^(\d{4})-W(\d{2})$/.exec(period);
  if (match === null) throw new Error(`not a weekly period: ${period}`);

  const year = Number(match[1]);
  const week = Number(match[2]);

  // 4 January is always in ISO week 1.
  const fourth = new Date(Date.UTC(year, 0, 4));
  const day = fourth.getUTCDay() === 0 ? 7 : fourth.getUTCDay();
  const week1Monday = new Date(fourth.getTime() - (day - 1) * 86_400_000);

  const start = new Date(week1Monday.getTime() + (week - 1) * 7 * 86_400_000);
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

/** The all-time board's period key. Not a date, so it never rolls over. */
export const ALL_TIME = 'all-time';

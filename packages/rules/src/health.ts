import {
  LOPSIDED_AFTER_HOURS,
  LOPSIDED_SPLIT,
  SLOW_RESOLUTION_HOURS,
  UNRESOLVED_GRACE_HOURS,
  WHALE_SHARE,
  WHALE_WINDOW_HOURS,
} from './constants';

/**
 * Part 5 of the checklist — what to watch once a market is live.
 *
 * The rules are written as instructions to a person ("watch the split for 48
 * hours"), and a person watching forty markets watches none of them. So they
 * are a pure function over facts the database already has, and the Studio's
 * Manage tab renders the result as a flag beside each row.
 *
 * Kept beside the creation rules rather than in the API because they are the
 * same document. A monitoring threshold that drifted from the one the wizard
 * warned about at creation would make the warning meaningless: staff told at
 * publish that 35-65% is the band, then flagged at 70/30 by a job with its own
 * idea of lopsided.
 */
export interface MarketHealthFacts {
  readonly marketId: string;
  readonly state: string;
  /** When it opened. */
  readonly openedAt: Date;
  /** When trading freezes and the result is expected. */
  readonly eventDate: Date;
  /** Share of the pot on the leading outcome, 0-1. Null with nothing staked. */
  readonly leadingShare: number | null;
  /** The largest single account's share of the pot, 0-1. Null when empty. */
  readonly largestHolderShare: number | null;
  /** How many accounts hold a position. */
  readonly holders: number;
  /** Whether a resolution has been proposed. */
  readonly resolutionProposed: boolean;
}

export interface HealthFlag {
  /** The checklist rule this comes from. */
  readonly rule: string;
  readonly severity: 'watch' | 'act';
  readonly message: string;
}

/**
 * Flags for one market, as of `now`.
 *
 * Returns every flag that applies rather than the worst one: a thin market
 * running lopsided *and* approaching an unprepared settlement has two separate
 * problems, and collapsing them to one line loses the second.
 */
export function healthFlags(facts: MarketHealthFacts, now: Date): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const hoursOpen = (now.getTime() - facts.openedAt.getTime()) / 3_600_000;
  const hoursToEvent = (facts.eventDate.getTime() - now.getTime()) / 3_600_000;
  const trading = ['seeding', 'funding', 'active'].includes(facts.state);

  // Rule 35 — past 75/25 after 48 hours, the question was probably bad.
  //
  // The 48-hour wait is the whole rule. A market is lopsided in its first hour
  // by definition: one person has traded and the split is 100/0. Flagging that
  // would fire on every market ever opened and teach everybody to ignore the
  // flag by the time a real one arrived.
  if (
    trading &&
    hoursOpen >= LOPSIDED_AFTER_HOURS &&
    facts.leadingShare !== null &&
    facts.leadingShare >= LOPSIDED_SPLIT
  ) {
    flags.push({
      rule: '35',
      severity: 'watch',
      message: `Running ${Math.round(facts.leadingShare * 100)}/${Math.round(
        (1 - facts.leadingShare) * 100,
      )} after ${Math.round(hoursOpen)}h. Note it for the next retune.`,
    });
  }

  // Rule 36 — one account setting the price rather than discovering it.
  if (
    trading &&
    hoursOpen <= WHALE_WINDOW_HOURS &&
    facts.largestHolderShare !== null &&
    facts.largestHolderShare >= WHALE_SHARE &&
    facts.holders > 0
  ) {
    flags.push({
      rule: '36',
      severity: 'act',
      message: `One account holds ${Math.round(
        facts.largestHolderShare * 100,
      )}% of a ${facts.holders}-trader market this early. Consider seeding the other side.`,
    });
  }

  // Rule 38 — the event is close and nobody has said who is resolving it.
  if (trading && hoursToEvent <= UNRESOLVED_GRACE_HOURS && hoursToEvent > 0) {
    flags.push({
      rule: '38',
      severity: 'act',
      message: `Settles in ${Math.max(
        0,
        Math.round(hoursToEvent),
      )}h. Have the source page open and know which figure you will cite.`,
    });
  }

  // Rule 39 — the event has passed and no resolution has been proposed.
  if (!facts.resolutionProposed && hoursToEvent < 0) {
    const late = Math.abs(hoursToEvent);
    const days = Math.round(late / 24);
    flags.push({
      rule: '39',
      severity: late >= SLOW_RESOLUTION_HOURS ? 'act' : 'watch',
      message:
        late >= SLOW_RESOLUTION_HOURS
          ? `The event was ${days} day${days === 1 ? '' : 's'} ago and nothing has been proposed. Slow settlement is the fastest way to lose trust.`
          : `The event was ${Math.round(late)}h ago. Propose within hours, not days.`,
    });
  }

  return flags;
}

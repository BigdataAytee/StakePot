/**
 * §2.14d's nudge engine.
 *
 * "Actionable prompts — 'YES side full, NO at 40%, market voids in 2 days —
 * share with groups holding the opposite view.'"
 *
 * The example is the whole specification: a nudge names the problem, says how
 * long is left, and gives one thing to do about it. A prompt that only says
 * "your market is doing badly" is a notification the creator learns to ignore,
 * and an ignored nudge is worse than none — it spends the one channel the
 * platform has to reach a creator who can still fix something.
 *
 * Pure, so the rules are testable without a database, and so the copy the
 * creator reads is the copy the tests assert.
 */

export type NudgeKind =
  | 'funding_lopsided'
  | 'funding_quiet'
  | 'participation_short'
  | 'price_settled'
  | 'views_no_stakes'
  | 'resolution_due'
  | 'resolution_overdue';

export type Urgency = 'now' | 'soon' | 'fyi';

export interface Nudge {
  readonly kind: NudgeKind;
  readonly urgency: Urgency;
  readonly body: string;
  /** What the creator should do. One action, never a menu. */
  readonly action: 'share' | 'seed' | 'propose_resolution' | 'review_criteria';
}

/** Everything the rules read. A snapshot, so a nudge is reproducible from a row. */
export interface MarketSnapshot {
  readonly marketId: string;
  readonly state: string;
  readonly activationPath: 'organic' | 'seeded';
  /** Staked per outcome, in SPC, in ordinal order. */
  readonly stakedByOutcome: readonly number[];
  readonly prices: readonly number[];
  readonly outcomeLabels: readonly string[];
  readonly distinctStakers: number;
  readonly views: number;
  readonly hoursToWindowClose: number | null;
  readonly hoursToEventDate: number | null;
  /** Hours until the creator's window to propose a resolution runs out. */
  readonly hoursToProposalDeadline: number | null;
  readonly resolutionProposed: boolean;
}

export interface NudgeRules {
  /** A pool this far below the best-funded one is "short" (§2.14d's example). */
  readonly lopsidedRatio: number;
  /** Distinct non-creator stakers a seeded market needs by close. */
  readonly participationFloor: number;
  /** A price above this means the crowd has stopped arguing. */
  readonly settledPrice: number;
  /** Views this many times the staker count with no stakes is a conversion problem. */
  readonly viewsPerStakeConcern: number;
  /** Inside this many hours, a deadline nudge becomes urgent. */
  readonly urgentHours: number;
}

export const DEFAULT_NUDGE_RULES: NudgeRules = {
  lopsidedRatio: 0.5,
  participationFloor: 10,
  settledPrice: 0.85,
  viewsPerStakeConcern: 20,
  urgentHours: 48,
};

function hours(value: number): string {
  if (value < 1) return 'less than an hour';
  const whole = Math.round(value);
  if (whole < 48) return `${whole} hour${whole === 1 ? '' : 's'}`;
  return `${Math.round(whole / 24)} days`;
}

function urgencyFor(hoursLeft: number | null, rules: NudgeRules): Urgency {
  if (hoursLeft === null) return 'fyi';
  return hoursLeft <= rules.urgentHours ? 'now' : 'soon';
}

/**
 * Every nudge a market currently warrants, most urgent first.
 *
 * Deliberately returns all of them rather than picking one: the caller decides
 * how many a creator should be sent and how often, and that throttle belongs
 * where the send history is, not in a pure rule.
 */
export function nudgesFor(snapshot: MarketSnapshot, rules: NudgeRules): readonly Nudge[] {
  const found: Nudge[] = [];

  if (snapshot.state === 'funding') {
    const best = Math.max(...snapshot.stakedByOutcome, 0);
    const shortIndexes = snapshot.stakedByOutcome
      .map((staked, index) => ({ staked, index }))
      .filter(({ staked }) => best > 0 && staked < best * rules.lopsidedRatio);

    if (best === 0) {
      found.push({
        kind: 'funding_quiet',
        urgency: urgencyFor(snapshot.hoursToWindowClose, rules),
        body:
          snapshot.hoursToWindowClose === null
            ? 'Nothing staked yet. Share it — a market nobody has seen cannot activate.'
            : `Nothing staked yet, and the window closes in ${hours(
                snapshot.hoursToWindowClose,
              )}. Share it — a market nobody has seen cannot activate.`,
        action: 'share',
      });
    } else if (shortIndexes.length > 0) {
      const shortLabels = shortIndexes
        .map(({ index }) => snapshot.outcomeLabels[index] ?? `outcome ${index + 1}`)
        .join(' and ');
      found.push({
        kind: 'funding_lopsided',
        urgency: urgencyFor(snapshot.hoursToWindowClose, rules),
        body:
          `${shortLabels} ${shortIndexes.length === 1 ? 'is' : 'are'} short` +
          (snapshot.hoursToWindowClose === null
            ? '. '
            : `, and the market voids in ${hours(snapshot.hoursToWindowClose)}. `) +
          'Share it with people who would take that side — a market only activates when both sides show up.',
        action: 'share',
      });
    }
  }

  if (
    snapshot.state === 'active' &&
    snapshot.activationPath === 'seeded' &&
    snapshot.hoursToWindowClose !== null &&
    snapshot.distinctStakers < rules.participationFloor
  ) {
    const missing = rules.participationFloor - snapshot.distinctStakers;
    found.push({
      kind: 'participation_short',
      urgency: urgencyFor(snapshot.hoursToWindowClose, rules),
      body: `${missing} more ${missing === 1 ? 'person' : 'people'} need to stake within ${hours(
        snapshot.hoursToWindowClose,
      )} or this voids and everything refunds — your seed included. A seed is liquidity, not interest.`,
      action: 'share',
    });
  }

  if (snapshot.state === 'active') {
    const leader = Math.max(...snapshot.prices, 0);
    if (leader >= rules.settledPrice) {
      const index = snapshot.prices.indexOf(leader);
      found.push({
        kind: 'price_settled',
        urgency: 'fyi',
        body: `${snapshot.outcomeLabels[index] ?? 'One side'} is at ${Math.round(
          leader * 100,
        )}%. Nobody argues with that, so volume will stay flat — pitch your next one where people disagree.`,
        action: 'review_criteria',
      });
    }

    if (snapshot.distinctStakers === 0 && snapshot.views >= rules.viewsPerStakeConcern) {
      found.push({
        kind: 'views_no_stakes',
        urgency: 'soon',
        body: `${snapshot.views} people have looked and none have staked. Usually that means the settlement criteria are not clear enough to bet on.`,
        action: 'review_criteria',
      });
    }
  }

  if (
    !snapshot.resolutionProposed &&
    (snapshot.state === 'frozen' || snapshot.state === 'active') &&
    snapshot.hoursToEventDate !== null &&
    snapshot.hoursToEventDate <= 0
  ) {
    const deadline = snapshot.hoursToProposalDeadline;
    if (deadline !== null && deadline <= 0) {
      found.push({
        kind: 'resolution_overdue',
        urgency: 'now',
        body: 'Your window to propose the resolution has passed. Your conduct bond is at risk until this settles.',
        action: 'propose_resolution',
      });
    } else {
      found.push({
        kind: 'resolution_due',
        urgency: deadline !== null && deadline <= rules.urgentHours ? 'now' : 'soon',
        body:
          deadline === null
            ? 'The event has happened. Propose the resolution with the source you named.'
            : `The event has happened. Propose the resolution within ${hours(
                deadline,
              )} — the source you named is ready.`,
        action: 'propose_resolution',
      });
    }
  }

  const order: Record<Urgency, number> = { now: 0, soon: 1, fyi: 2 };
  return [...found].sort((left, right) => order[left.urgency] - order[right.urgency]);
}

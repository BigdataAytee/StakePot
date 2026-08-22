/**
 * §2.14d's market autopsy.
 *
 * "After each close, a short automated review (what worked, why it voided, one
 * improvement tip). Autopsy data feeds the AI engine's training loop (§2.9) —
 * creators and the AI improve from the same signals."
 *
 * That last clause is the reason this is a rule and not a prompt. The signals
 * are the same ones §2.9's `recordOutcome` already reads — final split, volume,
 * stakers, whether it was disputed — so the autopsy has to be computable from
 * the same facts, deterministically, with no API key and no model call. A
 * creator whose market closed at 2am gets their review at 2am.
 *
 * One tip, not a list. §2.14d says "one improvement tip", and a creator who is
 * handed six things to fix fixes none of them.
 */

export type AutopsyKind = 'resolved' | 'voided';

export interface AutopsyFacts {
  readonly kind: AutopsyKind;
  readonly question: string;
  /** Total staked across the market's life, in SPC. */
  readonly volume: number;
  readonly distinctStakers: number;
  readonly views: number;
  /**
   * The winning outcome's share of the pot at settlement, 0–1. Null for a void:
   * nothing won, so there is no split to read.
   */
  readonly finalSplit: number | null;
  readonly disputed: boolean;
  readonly activationPath: 'organic' | 'seeded';
  /** Why it voided, when it did — the void reason already on the record. */
  readonly voidReason: string | null;
  readonly creatorFeeEarned: number;
  /**
   * Part 5 monitoring flags that fired while the market was live, cleared ones
   * included (see `MarketHealthFlag`).
   *
   * Rule 43 asks the post-mortem for "volume, final split, disputes, what
   * you'd change", and the fourth of those is the one the other three cannot
   * supply. A market that settled 55/45 looks healthy on its final split even
   * if it sat at 85/15 for a week and only converged on the day — the flag that
   * fired and cleared is the whole difference, and it is the part a creator can
   * actually act on next time.
   *
   * Optional because it is a later addition and the older callers computing an
   * autopsy from facts alone are still correct without it.
   */
  readonly warnings?: readonly { readonly rule: string; readonly message: string }[];
}

export interface AutopsyRules {
  /** A settle at or above this was never really in doubt. */
  readonly lopsidedSplit: number;
  /** A settle inside this band of even is the shape the platform wants. */
  readonly balancedSplit: number;
  /** Below this, the market did not find an audience. */
  readonly thinStakers: number;
  /** Views per staker above this is a conversion problem, not a reach problem. */
  readonly poorConversion: number;
}

export const DEFAULT_AUTOPSY_RULES: AutopsyRules = {
  lopsidedSplit: 0.85,
  balancedSplit: 0.65,
  thinStakers: 10,
  poorConversion: 20,
};

export interface Autopsy {
  readonly summary: string;
  /** What worked. Empty when nothing did — a false compliment teaches nothing. */
  readonly worked: readonly string[];
  /** The single improvement tip (§2.14d). Null when there is nothing to fix. */
  readonly tip: string | null;
  /** The machine-readable shape §2.9's loop reads back. */
  readonly signals: {
    readonly balanced: boolean;
    readonly lopsided: boolean;
    readonly thin: boolean;
    readonly poorConversion: boolean;
    readonly disputed: boolean;
    /** Checklist rule numbers whose Part 5 flag fired at any point. */
    readonly flaggedRules: readonly string[];
  };
}

function money(value: number): string {
  return value.toLocaleString('en-NG', { maximumFractionDigits: 0 });
}

export function autopsyFor(facts: AutopsyFacts, rules: AutopsyRules): Autopsy {
  const split = facts.finalSplit;
  const balanced = split !== null && split <= rules.balancedSplit;
  const lopsided = split !== null && split >= rules.lopsidedSplit;
  const thin = facts.distinctStakers < rules.thinStakers;
  const poorConversion =
    facts.distinctStakers > 0 && facts.views / facts.distinctStakers >= rules.poorConversion;

  const worked: string[] = [];
  if (balanced) {
    worked.push(
      `It stayed an argument to the end — the winning side held ${Math.round(
        (split ?? 0) * 100,
      )}% of the pot, so people on both sides thought they were right.`,
    );
  }
  if (!thin && facts.kind === 'resolved') {
    worked.push(
      `${facts.distinctStakers} people staked ${money(facts.volume)} between them${
        facts.creatorFeeEarned > 0 ? `, which earned you ${money(facts.creatorFeeEarned)}` : ''
      }.`,
    );
  }
  if (facts.kind === 'resolved' && !facts.disputed) {
    worked.push('It settled with no dispute — that is a clean resolution on your record.');
  }

  const warnings = facts.warnings ?? [];
  const flaggedRules = warnings.map((warning) => warning.rule);

  // One tip, most-important first. Order matters more than the wording: the
  // thing that killed the market is the thing to say.
  //
  // The monitoring flags sit between "it was disputed" and "it was lopsided",
  // and they are checked before the final split for a reason: a market that was
  // flagged at 48 hours and settled balanced anyway has already had its problem
  // named while it was still fixable, and repeating the split verdict would
  // teach the creator nothing they were not told at the time.
  let tip: string | null = null;
  if (facts.kind === 'voided') {
    tip =
      facts.activationPath === 'organic'
        ? 'Organic activation needs an audience on both sides before the window shuts. For a question this specific, the symmetric seed path opens the market yourself and lets the crowd arrive afterwards.'
        : 'A seed is liquidity, not interest — the floor counts people, not naira. Share the next one where the people who disagree with you already are.';
  } else if (facts.disputed) {
    tip =
      'This one was disputed, which means the settlement criteria left room to argue. Name the exact field on the source page — the figure, the table, the announcement — not just the site.';
  } else if (flaggedRules.includes('36')) {
    tip =
      'One account held most of this market early on, which sets the price instead of discovering it. Seed both sides, or open it where the other side of the argument already is — a price one person made is a price nobody else wants to take.';
  } else if (flaggedRules.includes('39')) {
    tip =
      'The result was out well before this was proposed. Have the source page open on the day and settle within hours — slow settlement costs more trust than a wrong-looking question does.';
  } else if (lopsided) {
    tip = `The winning side ended on ${Math.round(
      (split ?? 0) * 100,
    )}% of the pot, so the answer was close to obvious. Move the threshold to where the argument actually is — that is where the volume is too.`;
  } else if (thin) {
    tip =
      'Not many people staked. The question was fine; the reach was not. Share the ticket into the groups already arguing about it, on the day the news breaks.';
  } else if (poorConversion) {
    tip = `${facts.views} people looked and ${facts.distinctStakers} staked. That gap is almost always the criteria — people will not put money on a rule they have to guess at.`;
  }

  const summary =
    facts.kind === 'voided'
      ? `Voided${facts.voidReason === null ? '' : `: ${facts.voidReason}`}. ${
          facts.distinctStakers
        } ${facts.distinctStakers === 1 ? 'person' : 'people'} staked ${money(
          facts.volume,
        )} before it closed, and every naira went back.`
      : `Settled${facts.disputed ? ' after a dispute' : ' cleanly'} with ${money(
          facts.volume,
        )} staked by ${facts.distinctStakers} ${facts.distinctStakers === 1 ? 'person' : 'people'}${
          split === null ? '' : `, the winning side holding ${Math.round(split * 100)}% of the pot`
        }.`;

  return {
    summary,
    worked,
    tip,
    signals: {
      balanced,
      lopsided,
      thin,
      poorConversion,
      disputed: facts.disputed,
      flaggedRules,
    },
  };
}

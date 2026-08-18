import { Decimal } from '@stakeam/engine';

/**
 * Path A activation (§2.4, Rulebook Part 3 §2), as a pure decision.
 *
 * "At funding-window close, every outcome pool ≥ [20,000] pts AND ≥ [10]
 * distinct users → active, else voided + auto-refund."
 *
 * Separated from the job that runs it because this is the rule that decides
 * whether people get their money back, and it should be readable and testable
 * without a queue, a clock or a database.
 */

export interface OutcomeFunding {
  readonly outcomeId: string;
  readonly label: string;
  readonly isOther: boolean;
  readonly pool: Decimal;
  /** Distinct non-creator stakers on this outcome. */
  readonly backers: number;
}

export interface ActivationRules {
  readonly minPoolPerOutcome: Decimal;
  readonly minBackers: number;
  /**
   * `per_outcome` is the Rulebook rule as written. `total_pot` is the amendment
   * §2.9's backtest recommends for 4–5-outcome markets, where the strict rule
   * "fails even well-balanced markets on tail outcomes". Config, not a constant,
   * because adopting it is a rulebook decision and not a code decision.
   */
  readonly mode: 'per_outcome' | 'total_pot';
  readonly minTotalPot: Decimal;
  readonly minFundedOutcomes: number;
}

export type ActivationDecision =
  { readonly activate: true } | { readonly activate: false; readonly reason: string };

export function decideActivation(
  outcomes: readonly OutcomeFunding[],
  rules: ActivationRules,
): ActivationDecision {
  if (outcomes.length < 2) {
    return { activate: false, reason: 'the market has fewer than two outcomes' };
  }

  const distinctBackers = Math.max(...outcomes.map((o) => o.backers), 0);
  if (distinctBackers < rules.minBackers) {
    return {
      activate: false,
      reason: `needed ${rules.minBackers} backers, reached ${distinctBackers}`,
    };
  }

  if (rules.mode === 'total_pot') {
    const total = outcomes.reduce((acc, o) => acc.plus(o.pool), new Decimal(0));
    // The "Any other" bucket absorbs tails, so it does not have to be funded
    // for the field to be real — that is the point of the amendment.
    const funded = outcomes.filter((o) => !o.isOther && o.pool.gte(rules.minPoolPerOutcome)).length;

    if (total.lt(rules.minTotalPot)) {
      return {
        activate: false,
        reason: `the pot reached ${total.toString()} of ${rules.minTotalPot.toString()}`,
      };
    }
    if (funded < rules.minFundedOutcomes) {
      return {
        activate: false,
        reason: `only ${funded} outcome(s) were funded, needed ${rules.minFundedOutcomes}`,
      };
    }
    return { activate: true };
  }

  const short = outcomes.find((o) => o.pool.lt(rules.minPoolPerOutcome));
  if (short !== undefined) {
    return {
      activate: false,
      reason: `"${short.label}" reached ${short.pool.toString()} of ${rules.minPoolPerOutcome.toString()}`,
    };
  }
  return { activate: true };
}

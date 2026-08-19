import type { MarketTemplate } from './market-template';

/**
 * §2.14e — "auto-void risk warnings *before* posting".
 *
 * "(deadline too far, topic too niche for organic activation → suggest seed
 * path)."
 *
 * These are warnings, never refusals, and the distinction is the whole design.
 * `screenTemplate` decides what may exist; this decides what to *say* to
 * somebody about a market that is allowed but likely to fail. A creator whose
 * market voids has lost nothing but time — the bond comes back — and what they
 * actually lost is the week they spent telling friends to back it. Telling
 * them beforehand is the help; blocking them would be us deciding which
 * questions are worth asking.
 *
 * Pure, and separate from the blocklist, so a rule change here can never
 * accidentally start rejecting markets.
 */
export type RiskCode =
  | 'deadline_far'
  | 'deadline_tight'
  | 'niche_topic'
  | 'many_outcomes'
  | 'void_window_short'
  | 'conflict_of_interest';

export interface Risk {
  code: RiskCode;
  /** What is risky. */
  message: string;
  /** What to do about it. Every warning carries one — a warning with no */
  suggestion: string;
  severity: 'high' | 'medium' | 'low';
}

/**
 * How far out is too far.
 *
 * Organic activation needs a funding window's worth of attention, and
 * attention does not survive months of waiting. The threshold is not a rule
 * anybody wrote down — it is the observation that a market resolving beyond a
 * quarter has to hold interest through a news cycle that has moved on.
 */
const FAR_DAYS = 90;
const TIGHT_HOURS = 12;

/** Topics an audience turns out for without being asked. */
const BROAD =
  /\b(election|eagles|afcon|naira|cbn|fuel|bbnaija|premier league|inec|dollar|bitcoin|tinubu|nnpc)\b/i;

export interface RiskInput {
  template: MarketTemplate;
  activationPath: 'organic' | 'seeded';
  now: Date;
  /**
   * Whether the creator attested to a conflict — influence over the outcome or
   * inside knowledge (Rulebook Part 3). Attested is not disqualifying; unstated
   * is what the warning is about.
   */
  conflictAttested?: boolean;
}

export function voidRisks(input: RiskInput): Risk[] {
  const { template, activationPath, now } = input;
  const risks: Risk[] = [];

  const event = new Date(template.eventDate).getTime();
  const voidAt = new Date(template.voidDate).getTime();
  const daysOut = (event - now.getTime()) / 86_400_000;
  const hoursOut = (event - now.getTime()) / 3_600_000;

  if (Number.isFinite(daysOut) && daysOut > FAR_DAYS) {
    risks.push({
      code: 'deadline_far',
      message: `This settles in about ${Math.round(daysOut)} days.`,
      suggestion:
        activationPath === 'organic'
          ? 'A funding window that far out usually goes quiet before it fills. Seeding it opens it now.'
          : 'Long-dated markets are fine once open — just expect the pot to build slowly.',
      severity: activationPath === 'organic' ? 'high' : 'low',
    });
  }

  if (Number.isFinite(hoursOut) && hoursOut < TIGHT_HOURS && hoursOut > 0) {
    risks.push({
      code: 'deadline_tight',
      message: `The event is in about ${Math.max(1, Math.round(hoursOut))} hours.`,
      suggestion:
        'There may not be time for a funding window to fill before it happens. Seed it, or pick a later event.',
      severity: 'high',
    });
  }

  // The void date is the escape hatch when nothing settles it. Too close to
  // the event and an ordinary delay — a postponed match, a late announcement —
  // voids a market that would have resolved fine a day later.
  const graceHours = (voidAt - event) / 3_600_000;
  if (Number.isFinite(graceHours) && graceHours < 24) {
    risks.push({
      code: 'void_window_short',
      message: 'The void date is less than a day after the event.',
      suggestion:
        'A postponement or a late announcement would void this. Give it a few days of room.',
      severity: 'medium',
    });
  }

  const surface = `${template.question} ${template.outcomes.map((o) => o.label).join(' ')}`;
  if (activationPath === 'organic' && !BROAD.test(surface)) {
    risks.push({
      code: 'niche_topic',
      message: 'Nothing here is a topic people are already arguing about.',
      suggestion:
        'Niche questions rarely fill on their own. Seed it open, or share it somewhere the people who care already are.',
      severity: 'medium',
    });
  }

  const outcomes = template.outcomes.length + (template.otherLabel === undefined ? 0 : 1);
  if (outcomes > 4 && activationPath === 'organic') {
    risks.push({
      code: 'many_outcomes',
      message: `${outcomes} outcomes means the pot has to spread across all of them.`,
      suggestion:
        'Wide fields need at least two funded outcomes to activate. Fewer outcomes, or seed it.',
      severity: 'medium',
    });
  }

  if (input.conflictAttested !== true) {
    risks.push({
      code: 'conflict_of_interest',
      message: 'You settle this market yourself, against the source you named.',
      suggestion:
        'If you can influence the result, or know something the market does not, say so now — declaring it costs nothing and hiding it forfeits the bond.',
      severity: 'low',
    });
  }

  return risks;
}

/** Whether anything here is worth stopping to read. */
export function worthWarningAbout(risks: readonly Risk[]): boolean {
  return risks.some((risk) => risk.severity !== 'low');
}

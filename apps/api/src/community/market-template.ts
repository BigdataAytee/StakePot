import {
  BALANCE_BAND,
  MULTI_FAVOURITE_MAX,
  review,
  type Finding,
  type ReviewContext,
  type RuleReport,
  type Surface,
  type TicketDraft,
} from '@stakeam/rules';

/**
 * The community market template (§2.5) and the screen every submission passes
 * before a human ever sees it.
 *
 * The rules themselves used to live here — a blocklist, a set of structural
 * checks, a balance band — and a second copy of most of them lived in the
 * question engine's prompt. `docs/ticket-creation-checklist.md` is now the law
 * and `@stakeam/rules` is that document as code, so this file is the adapter
 * between the checklist and the shapes the community path already speaks.
 *
 * §2.9's note still holds and is worth repeating where somebody will read it: a
 * prohibition that only exists in a prompt is a preference. A model can be
 * argued out of one. `review()` cannot.
 */

export interface TemplateOutcome {
  readonly label: string;
  readonly criteria: string;
}

/**
 * What a submission carries.
 *
 * A `TicketDraft` with the optional fields left off — the checklist asks for
 * more than §2.5 ever did (a category, an expected stake, a balance estimate),
 * and every one of those is optional precisely so a template that predates them
 * still type-checks. What they change is the *report*: a fact nobody supplied
 * comes back as a note rather than a pass.
 */
export type MarketTemplate = TicketDraft;

export type { Finding, ReviewContext, RuleReport };

/**
 * Run the checklist over a template.
 *
 * Returns the whole report rather than a list of complaints. The report is what
 * the Studio shows, what a community submission carries into the review queue,
 * and what the engine files beside a draft it refused — one artefact, so a
 * reviewer looking at any of the three is looking at the same thing.
 */
export function screenTemplate(
  template: MarketTemplate,
  context: ReviewContext,
  surface: Surface = 'community',
): RuleReport {
  return review(template, context, surface);
}

/**
 * Everything standing between this template and publication, in words.
 *
 * Failures and unanswered questions together: an unasked stranger test is not a
 * pass, and a caller that only rendered the failures would show a creator a
 * clean screen beside a refusal.
 */
export function blockersOf(report: RuleReport): string[] {
  return [...report.failures, ...report.unanswered].map(
    (finding) => `Rule ${finding.rule}: ${finding.message}`,
  );
}

/**
 * §2.9 rule 3, now rule 6 of the checklist: the engine rejects its own draft
 * outside the band, and no single outcome above the multi-outcome ceiling.
 *
 * The bounds stay arguments rather than constants because the §6.4b console
 * owns them — the checklist's own figures are the defaults, not the ceiling on
 * what operations may set.
 */
export function isBalanced(
  estimates: readonly number[],
  bounds: {
    readonly binaryLow?: number;
    readonly binaryHigh?: number;
    readonly multiMax?: number;
  } = {},
): boolean {
  const low = bounds.binaryLow ?? BALANCE_BAND.low;
  const high = bounds.binaryHigh ?? BALANCE_BAND.high;
  const multiMax = bounds.multiMax ?? MULTI_FAVOURITE_MAX;

  if (estimates.length === 0) return false;
  const total = estimates.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 0.02) return false;

  if (estimates.length === 2) {
    const [yes] = estimates as [number, number];
    return yes >= low && yes <= high;
  }
  return Math.max(...estimates) <= multiMax;
}

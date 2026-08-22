import type { MarketTemplate, ReviewContext } from '../community/market-template';

/**
 * A market template that satisfies the ticket-creation checklist.
 *
 * Every integration suite that opens a market needs one, and before this
 * existed each wrote its own three-line fixture — a question, two outcomes, one
 * edge case. Those fixtures were fine against the old structural screen and
 * every one of them fails the checklist, for six different reasons apiece.
 *
 * Rewriting them by hand six times would have produced six subtly different
 * ideas of what compliant means, and the next rule added to the document would
 * break all six again. So there is one, and it is deliberately verbose: the
 * year-on-year qualifier is rule 28, "first published" is 27, the WAT hours are
 * 26, the silent-source case is 4, and the deep source URL rather than an
 * institution's homepage is R2.
 *
 * Suites that want to test a *refusal* override one field and keep the rest —
 * which is the other reason this exists. A fixture that fails six rules cannot
 * tell you which one the code under test was checking.
 */
export function compliantTemplate(overrides: Partial<MarketTemplate> = {}): MarketTemplate {
  const inDays = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString();

  return {
    question:
      'Will year-on-year headline CPI, as first published by the NBS, print below 24.5% next month?',
    outcomes: [
      {
        label: 'BELOW',
        criteria:
          'The NBS CPI report, first published figure, shows year-on-year headline inflation below 24.5%, read at 23:59 WAT. Revisions are ignored.',
      },
      {
        label: 'AT OR ABOVE',
        criteria:
          'That same first published year-on-year headline figure is 24.5% or higher, read at 23:59 WAT.',
      },
    ],
    sourceName: 'NBS CPI report',
    sourceUrl: 'https://nigerianstat.gov.ng/elibrary/read/1241',
    eventDate: inDays(20),
    voidDate: inDays(30),
    edgeCases: {
      delayed: 'Voids if the NBS has not published by the void date.',
      'no publication': 'If the NBS publishes no report for the month at all, the market voids.',
    },
    balanceEstimates: [0.52, 0.48],
    category: 'Economy',
    tags: ['inflation', 'nbs'],
    icon: 'chart',
    ...overrides,
  };
}

/**
 * What a staff member answers when they open a market.
 *
 * The attestation and the two judgement questions are answers a person gives,
 * so a test that opens a market has to give them — the same way the Studio's
 * review screen does. `R3: false` is the good answer: it means the reviewer
 * does *not* want a particular side to win.
 *
 * Deliberately just these two fields rather than a whole `ReviewContext`.
 * Spreading a context into a service's parameters compiles, carries six
 * irrelevant keys along with it, and hides which of them the service actually
 * reads.
 */
export function approvalAnswers(): {
  attestedNoInfluence: boolean;
  confirmations: Record<string, boolean>;
} {
  return {
    attestedNoInfluence: true,
    confirmations: { '18': true, '25': true, R3: false },
  };
}

/** The same answers, as the context the validators take directly. */
export function approvalContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return { now: new Date(), ...approvalAnswers(), ...overrides };
}

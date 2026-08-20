import { describe, expect, it } from 'vitest';

import type { ReviewContext, TicketDraft } from '../draft';
import { RULES } from '../registry';
import { review, type Status } from '../validators';

/**
 * The checklist, exercised one rule at a time.
 *
 * Written against a draft that passes everything, with each test breaking
 * exactly one thing. A suite built the other way round — a bad draft, asserting
 * a pile of failures — passes just as happily when a validator stops working,
 * because something else in the pile still fails.
 */
const NOW = new Date('2026-08-20T09:00:00.000Z');

/** A market that satisfies every rule software can decide. */
function goodDraft(overrides: Partial<TicketDraft> = {}): TicketDraft {
  return {
    question:
      'Will year-on-year headline CPI for August 2026, as first published by the NBS, come in below 24.0%?',
    outcomes: [
      {
        label: 'Yes',
        criteria:
          'The NBS CPI report for August 2026, first published figure, shows year-on-year headline inflation below 24.0%. Published by 23:59 WAT, 20 September 2026. Revisions are ignored.',
      },
      {
        label: 'No',
        criteria:
          'That first published year-on-year headline figure is 24.0% or above, per the same NBS report at 23:59 WAT.',
      },
    ],
    sourceName: 'National Bureau of Statistics',
    sourceUrl: 'https://nigerianstat.gov.ng/elibrary/read/1241',
    eventDate: '2026-09-20T22:59:00.000Z',
    voidDate: '2026-10-05T22:59:00.000Z',
    edgeCases: {
      'no publication':
        'If the NBS publishes no August CPI report by the void date, the market voids.',
      'methodology changed':
        'If the NBS rebases the index before publication, the market voids rather than settling on a different series.',
    },
    balanceEstimates: [0.48, 0.52],
    liquidityParam: 50_000,
    expectedStake: 2_000,
    category: 'Economy',
    tags: ['inflation', 'nbs'],
    icon: 'chart',
    ...overrides,
  };
}

function goodContext(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    now: NOW,
    duplicates: [],
    settlingSameDay: 0,
    liveCount: 8,
    catalogueSlots: 20,
    expectedNewsFlow: true,
    attestedNoInfluence: true,
    confirmations: { '18': true, '25': true, R3: false },
    ...overrides,
  };
}

function statusOf(report: ReturnType<typeof review>, id: string): Status {
  const finding = report.findings.find((entry) => entry.rule === id);
  if (finding === undefined) throw new Error(`rule ${id} was not reported at all`);
  return finding.status;
}

describe('a market that follows the checklist', () => {
  it('publishes', () => {
    const report = review(goodDraft(), goodContext());
    expect(report.failures.map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
    expect(report.unanswered).toEqual([]);
    expect(report.blocked).toBe(false);
  });

  it('reports a line for every rule, including the ones it cannot decide', () => {
    // The reviewer is signing off against a document. A report that quietly
    // omitted the rules nothing checks would not be a report on that document.
    const report = review(goodDraft(), goodContext());
    expect(report.findings).toHaveLength(RULES.length);
    expect(report.findings.filter((f) => f.status === 'note').length).toBeGreaterThan(0);
  });
});

describe('the five non-negotiables', () => {
  it('refuses "widely reported" as a source (1)', () => {
    const report = review(goodDraft({ sourceName: 'widely reported' }), goodContext());
    expect(statusOf(report, '1')).toBe('fail');
    expect(report.blocked).toBe(true);
  });

  it('refuses a void date before the event (2)', () => {
    const report = review(goodDraft({ voidDate: '2026-09-01T22:59:00.000Z' }), goodContext());
    expect(statusOf(report, '2')).toBe('fail');
  });

  it('accepts two named contenders beside an "Any other" (3)', () => {
    // A three-way race written as two runners plus a catch-all. An earlier
    // version of this check counted outcomes rather than reading them and
    // refused it as "binary with a third bucket" — refusing the exact shape
    // rule 3 asks for.
    const report = review(
      goodDraft({
        question: 'Who will INEC declare winner of the Surulere LGA chairmanship?',
        outcomes: [
          {
            label: 'Okafor',
            criteria: 'INEC declares Okafor the winner, per the declaration read at 23:59 WAT.',
          },
          {
            label: 'Okonkwo',
            criteria: 'INEC declares Okonkwo the winner, per the declaration read at 23:59 WAT.',
          },
        ],
        otherLabel: 'Any other candidate',
        balanceEstimates: [0.45, 0.4, 0.15],
      }),
      goodContext(),
    );
    expect(statusOf(report, '3')).toBe('pass');
  });

  it('refuses an "Any other" bucket beside Yes and No (3)', () => {
    const report = review(
      goodDraft({ otherLabel: 'Any other outcome', balanceEstimates: [0.4, 0.4, 0.2] }),
      goodContext(),
    );
    expect(statusOf(report, '3')).toBe('fail');
  });

  it('refuses a multi-outcome market with no "Any other" (3)', () => {
    const report = review(
      goodDraft({
        outcomes: [
          { label: 'Ronaldo', criteria: 'CAF names him the winner at the awards ceremony.' },
          { label: 'Osimhen', criteria: 'CAF names him the winner at the awards ceremony.' },
          { label: 'Salah', criteria: 'CAF names him the winner at the awards ceremony.' },
        ],
        balanceEstimates: [0.4, 0.35, 0.25],
      }),
      goodContext(),
    );
    expect(statusOf(report, '3')).toBe('fail');
  });

  it('refuses a market that never says what happens if the source is silent (4)', () => {
    const report = review(
      goodDraft({
        edgeCases: { postponed: 'If the report slips a week, the market still settles on it.' },
      }),
      goodContext(),
    );
    expect(statusOf(report, '4')).toBe('fail');
  });

  it('refuses an unattested market (5, 16)', () => {
    const report = review(goodDraft(), goodContext({ attestedNoInfluence: undefined }));
    expect(statusOf(report, '5')).toBe('fail');
    expect(statusOf(report, '16')).toBe('fail');
  });
});

describe('the forbidden list', () => {
  const cases: readonly [string, string, string][] = [
    ['13', 'harm', 'Will the governor die before the end of his term at 23:59 WAT?'],
    ['14', 'crime', 'Will the senator be arrested before 23:59 WAT on 1 October 2026?'],
    ['15', 'private matters', 'Will the singer announce a divorce before 23:59 WAT?'],
    ['19', 'the platform itself', 'Will StakeAm pass one million users by 23:59 WAT?'],
    ['20', 'inflammatory wording', 'Will the corrupt minister be replaced by 23:59 WAT?'],
    ['R6', 'rumours', 'Will the reportedly imminent cabinet reshuffle happen by 23:59 WAT?'],
  ];

  for (const [id, what, question] of cases) {
    it(`refuses ${what} (${id})`, () => {
      const report = review(goodDraft({ question }), goodContext());
      expect(statusOf(report, id)).toBe('fail');
      expect(report.blocked).toBe(true);
    });
  }

  it('reads the outcomes too, not just the question', () => {
    // A clean question with a prohibited outcome is still a prohibited market.
    const report = review(
      goodDraft({
        outcomes: [
          {
            label: 'Yes',
            criteria: 'The CAF report records that the player was killed in the incident.',
          },
          {
            label: 'No',
            criteria: 'The CAF report records anything else, per the same page at 23:59 WAT.',
          },
        ],
      }),
      goodContext(),
    );
    expect(statusOf(report, '13')).toBe('fail');
  });
});

describe('the commercial rules warn rather than block', () => {
  it('warns on a lopsided binary market (6)', () => {
    const report = review(goodDraft({ balanceEstimates: [0.88, 0.12] }), goodContext());
    expect(statusOf(report, '6')).toBe('warn');
    // A bad market, not an unpublishable one — staff sometimes have a reason.
    expect(report.blocked).toBe(false);
  });

  it('says nothing rather than passing when no estimate was supplied (6)', () => {
    const report = review(goodDraft({ balanceEstimates: undefined }), goodContext());
    expect(statusOf(report, '6')).toBe('note');
  });

  it('warns past the attention window, and not for a blockbuster (10)', () => {
    // Ninety days out: past the ordinary 42-day window, inside the 180 a
    // tournament or an election is allowed. Both assertions were 'warn' in the
    // first draft of this test, which meant the blockbuster branch was never
    // exercised at all — the date was beyond even its limit.
    const far = { eventDate: '2026-11-18T22:59:00.000Z', voidDate: '2026-12-05T22:59:00.000Z' };
    expect(statusOf(review(goodDraft(far), goodContext()), '10')).toBe('warn');
    expect(statusOf(review(goodDraft({ ...far, blockbuster: true }), goodContext()), '10')).toBe(
      'pass',
    );
  });

  it('warns when the settlement calendar is already crowded (33)', () => {
    const report = review(goodDraft(), goodContext({ settlingSameDay: 4 }));
    expect(statusOf(report, '33')).toBe('warn');
  });

  it('warns when a recurring market repeats last cycle verbatim (32)', () => {
    const draft = goodDraft();
    const report = review(draft, goodContext({ previousCycle: { question: draft.question } }));
    expect(statusOf(report, '32')).toBe('warn');
  });
});

describe('the wording rules', () => {
  it('refuses a date with no hour (26)', () => {
    const report = review(goodDraft({ eventDate: '2026-09-20' }), goodContext());
    expect(statusOf(report, '26')).toBe('fail');
  });

  it('refuses wording that never names the timezone (26)', () => {
    const draft = goodDraft();
    const stripped = {
      ...draft,
      question: draft.question,
      outcomes: draft.outcomes.map((o) => ({ ...o, criteria: o.criteria.replace(/ WAT/g, '') })),
      edgeCases: {
        'no publication': 'If the NBS publishes nothing by the void date, the market voids.',
      },
    };
    expect(statusOf(review(stripped, goodContext()), '26')).toBe('fail');
  });

  it('refuses a revisable statistic with no first-published clause (27)', () => {
    const draft = goodDraft();
    const loose = {
      ...draft,
      question: 'Will year-on-year headline CPI for August 2026 come in below 24.0% at 23:59 WAT?',
      // Both outcomes, not just the first — the "No" leg carried its own
      // "first published" and left the rule passing on a draft this test
      // believed had none. Caught by the assertion, which is the point of
      // breaking exactly one thing per test.
      outcomes: draft.outcomes.map((o) => ({
        ...o,
        criteria: o.criteria
          .replace(/,? first published( figure,?)?/g, '')
          .replace(/ Revisions are ignored\./, ''),
      })),
      edgeCases: {
        'no publication':
          'If the NBS publishes nothing by the void date, the market voids at 23:59 WAT.',
      },
    };
    expect(statusOf(review(loose, goodContext()), '27')).toBe('fail');
  });

  it('refuses an unqualified metric (28)', () => {
    const report = review(
      goodDraft({
        question: 'Will inflation come in below 24.0% at 23:59 WAT on 20 September 2026?',
        outcomes: [
          {
            label: 'Yes',
            criteria: 'The NBS first published report shows inflation below 24.0% at 23:59 WAT.',
          },
          {
            label: 'No',
            criteria: 'The NBS first published report shows 24.0% or above at 23:59 WAT.',
          },
        ],
      }),
      goodContext(),
    );
    expect(statusOf(report, '28')).toBe('fail');
  });

  it('refuses a naira market that never says which rate (29)', () => {
    const report = review(
      goodDraft({
        question: 'Will the naira close below ₦1,500 to the dollar on 20 September 2026?',
        outcomes: [
          {
            label: 'Yes',
            criteria: 'The CBN publishes a rate below ₦1,500 that day, read at 23:59 WAT.',
          },
          {
            label: 'No',
            criteria: 'The CBN publishes ₦1,500 or above that day, read at 23:59 WAT.',
          },
        ],
        edgeCases: {
          'no publication': 'If the CBN publishes no rate that day, the market voids at 23:59 WAT.',
        },
      }),
      goodContext(),
    );
    expect(statusOf(report, '29')).toBe('fail');
  });
});

describe('the questions only a person can answer', () => {
  it('blocks while the stranger test is unanswered (25)', () => {
    const report = review(goodDraft(), goodContext({ confirmations: { '18': true, R3: false } }));
    expect(statusOf(report, '25')).toBe('ask');
    expect(report.blocked).toBe(true);
  });

  it('blocks a reviewer who wants a side to win (R3)', () => {
    const report = review(
      goodDraft(),
      goodContext({ confirmations: { '18': true, '25': true, R3: true } }),
    );
    expect(statusOf(report, 'R3')).toBe('fail');
    expect(report.failures[0]?.message).toMatch(/another staff member/i);
  });

  it('blocks a market that fails the front-page test (18)', () => {
    const report = review(
      goodDraft(),
      goodContext({ confirmations: { '18': false, '25': true, R3: false } }),
    );
    expect(statusOf(report, '18')).toBe('fail');
  });
});

describe('facts the caller did not supply', () => {
  it('does not report a clean duplicate check nobody ran (21)', () => {
    const report = review(goodDraft(), goodContext({ duplicates: undefined }));
    expect(statusOf(report, '21')).toBe('note');
  });

  it('fails when a duplicate was actually found (21)', () => {
    const report = review(
      goodDraft(),
      goodContext({ duplicates: [{ id: 'm1', question: 'Will August CPI print below 24%?' }] }),
    );
    expect(statusOf(report, '21')).toBe('fail');
  });
});

describe('scoping to one surface', () => {
  it('leaves out the rules that do not bind there', () => {
    const everywhere = review(goodDraft(), goodContext());
    const community = review(goodDraft(), goodContext(), 'community');
    expect(community.findings.length).toBeLessThan(everywhere.findings.length);
    // Rule 32 is a staff concern about a recurring series; a community creator
    // has no cycle to retune.
    expect(community.findings.map((f) => f.rule)).not.toContain('32');
    expect(community.findings.map((f) => f.rule)).toContain('1');
  });
});

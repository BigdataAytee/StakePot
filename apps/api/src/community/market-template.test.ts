import { describe, expect, it } from 'vitest';

import { isBalanced, screenTemplate, type MarketTemplate } from './market-template';

const NOW = new Date('2026-01-01T00:00:00Z');

const valid: MarketTemplate = {
  question: 'Will the Super Eagles beat Ivory Coast on Saturday?',
  outcomes: [
    { label: 'YES', criteria: 'Nigeria wins in regulation or extra time.' },
    { label: 'NO', criteria: 'Draw, loss, or decided on penalties.' },
  ],
  sourceName: 'CAF official match report',
  sourceUrl: 'https://www.cafonline.com/',
  eventDate: '2026-01-10T18:00:00Z',
  voidDate: '2026-01-17T00:00:00Z',
  edgeCases: { abandoned: 'Void, full refund.' },
};

const screen = (t: MarketTemplate) => screenTemplate(t, { now: NOW });
const codes = (t: MarketTemplate) => screen(t).map((p) => p.code);

describe('template screen', () => {
  it('passes a complete, settleable market', () => {
    expect(screen(valid)).toEqual([]);
  });

  it('rejects the Rulebook §8 categories, in the question or in an outcome', () => {
    expect(codes({ ...valid, question: 'Will the minister die before June?' })).toContain(
      'blocklist',
    );
    expect(codes({ ...valid, question: 'Will there be a bomb attack in Kano?' })).toContain(
      'blocklist',
    );
    expect(codes({ ...valid, question: 'Will the senator be arrested this year?' })).toContain(
      'blocklist',
    );

    // A clean question with a prohibited outcome is still a prohibited market.
    expect(
      codes({
        ...valid,
        outcomes: [
          { label: 'YES', criteria: 'The chairman is convicted of fraud.' },
          { label: 'NO', criteria: 'He is not.' },
        ],
      }),
    ).toContain('blocklist');
  });

  it('requires a named source reachable over https', () => {
    expect(codes({ ...valid, sourceName: '  ' })).toContain('missing_source');
    expect(codes({ ...valid, sourceUrl: 'http://cafonline.com' })).toContain('bad_source_url');
    expect(codes({ ...valid, sourceUrl: 'ask my guy' })).toContain('bad_source_url');
  });

  it('requires a future void date that falls after the event', () => {
    expect(codes({ ...valid, voidDate: '2025-06-01T00:00:00Z' })).toContain('void_date_not_future');
    expect(codes({ ...valid, voidDate: '2026-01-05T00:00:00Z' })).toContain(
      'void_date_before_event',
    );
  });

  it('requires a complete outcome list with settlement criteria', () => {
    expect(codes({ ...valid, outcomes: [valid.outcomes[0]!] })).toContain('incomplete_outcomes');
    expect(
      codes({ ...valid, outcomes: [{ label: 'YES', criteria: 'yes' }, valid.outcomes[1]!] }),
    ).toContain('missing_criteria');
    expect(
      codes({ ...valid, outcomes: [valid.outcomes[0]!, { ...valid.outcomes[1]!, label: 'yes' }] }),
    ).toContain('duplicate_outcome');
  });

  it('reports every problem at once rather than one at a time', () => {
    const found = codes({
      ...valid,
      question: 'no',
      sourceName: '',
      sourceUrl: 'nope',
      voidDate: '2025-01-01T00:00:00Z',
    });
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(new Set(found).size).toBe(found.length);
  });
});

describe('balance pre-check (§2.9 rule 3)', () => {
  const bounds = { binaryLow: 0.35, binaryHigh: 0.65, multiMax: 0.6 };

  it('accepts a genuinely contested binary question', () => {
    expect(isBalanced([0.52, 0.48], bounds)).toBe(true);
    expect(isBalanced([0.36, 0.64], bounds)).toBe(true);
  });

  it('rejects an obvious answer — a lopsided market is a dead market', () => {
    expect(isBalanced([0.9, 0.1], bounds)).toBe(false);
    expect(isBalanced([0.2, 0.8], bounds)).toBe(false);
  });

  it('rejects a multi-outcome field with a runaway favourite', () => {
    expect(isBalanced([0.4, 0.3, 0.2, 0.1], bounds)).toBe(true);
    expect(isBalanced([0.7, 0.2, 0.1], bounds)).toBe(false);
  });

  it('rejects estimates that do not form a distribution', () => {
    expect(isBalanced([0.5, 0.9], bounds)).toBe(false);
    expect(isBalanced([], bounds)).toBe(false);
  });
});

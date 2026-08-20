import { describe, expect, it } from 'vitest';

import { blockersOf, isBalanced, screenTemplate, type MarketTemplate } from './market-template';

/**
 * The adapter, not the rules.
 *
 * What each rule means, and which drafts trip it, is settled in
 * `packages/rules` — one copy of those tests, beside the one copy of the rules.
 * What is left here is the part this file actually owns: that the community
 * path asks the right surface, that a refusal reaches a creator in words, and
 * that the balance band still defaults to the checklist's own figures when the
 * §6.4b console has not overridden them.
 */
const NOW = new Date('2026-01-01T00:00:00Z');

const valid: MarketTemplate = {
  question: 'Will the Super Eagles beat Ivory Coast on Saturday 10 January 2026?',
  outcomes: [
    {
      label: 'YES',
      criteria: 'CAF publishes a full-time result with Nigeria ahead, read at 20:00 WAT.',
    },
    {
      label: 'NO',
      criteria: 'CAF publishes any other full-time result, including a draw, at 20:00 WAT.',
    },
  ],
  sourceName: 'CAF official match report',
  sourceUrl: 'https://www.cafonline.com/africa-cup-of-nations/matches/',
  eventDate: '2026-01-10T18:00:00Z',
  voidDate: '2026-01-17T00:00:00Z',
  edgeCases: {
    abandoned:
      'If the match is abandoned before full time, the market voids and everyone is refunded.',
    'no publication': 'If CAF publishes no result by the void date, the market voids.',
  },
  balanceEstimates: [0.52, 0.48],
  category: 'Football',
  tags: ['super eagles', 'afcon'],
  icon: 'football',
};

const screen = (template: MarketTemplate, attested = true) =>
  screenTemplate(template, { now: NOW, attestedNoInfluence: attested });

describe('the community screen', () => {
  it('finds nothing wrong with a complete, settleable market', () => {
    const report = screen(valid);
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('leaves the judgement questions outstanding for the reviewer', () => {
    // A creator pressing submit cannot answer the front-page test or the
    // stranger test on the platform's behalf, and the staff member who can is
    // not in the room. So they ride into the review queue unanswered — which is
    // why submission gates on failures and approval gates on the whole report.
    const report = screen(valid);
    expect(report.unanswered.map((finding) => finding.rule).sort()).toEqual(['18', '25']);
    expect(report.blocked).toBe(true);
  });

  it('asks the community surface, so staff-only rules do not bind a creator', () => {
    // Rule 32 retunes a recurring series and rule 34 guards the shelf's size.
    // Neither is a creator's to answer, and putting them on a community
    // submission would refuse markets for reasons the creator cannot act on.
    const reported = screen(valid).findings.map((finding) => finding.rule);
    expect(reported).not.toContain('32');
    expect(reported).not.toContain('34');
    expect(reported).toContain('13');
  });

  it('refuses a submission with no attestation, whatever else is right (5, 16)', () => {
    const report = screen(valid, false);
    expect(report.blocked).toBe(true);
    expect(blockersOf(report).join(' ')).toMatch(/attest/i);
  });

  it('puts the rule number in front of the reason', () => {
    // The creator is being refused by a document they can go and read. A
    // message with no number tells them they are wrong without telling them
    // against what.
    const report = screen({ ...valid, sourceName: 'widely reported' });
    expect(blockersOf(report)[0]).toMatch(/^Rule 1: /);
  });
});

describe('the balance band', () => {
  it('defaults to the checklist figures', () => {
    expect(isBalanced([0.52, 0.48])).toBe(true);
    expect(isBalanced([0.36, 0.64])).toBe(true);
    expect(isBalanced([0.9, 0.1])).toBe(false);
    expect(isBalanced([0.2, 0.8])).toBe(false);
  });

  it('reads a ceiling on the favourite for a multi-outcome market', () => {
    expect(isBalanced([0.4, 0.3, 0.2, 0.1])).toBe(true);
    expect(isBalanced([0.7, 0.2, 0.1])).toBe(false);
  });

  it('lets operations override without rewriting the rule', () => {
    expect(isBalanced([0.3, 0.7], { binaryLow: 0.25, binaryHigh: 0.75 })).toBe(true);
  });

  it('refuses estimates that do not add up, and an empty list', () => {
    expect(isBalanced([0.5, 0.9])).toBe(false);
    expect(isBalanced([])).toBe(false);
  });
});

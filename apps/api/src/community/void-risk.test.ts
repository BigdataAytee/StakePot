import { describe, expect, it } from 'vitest';

import { voidRisks, worthWarningAbout, type RiskInput } from './void-risk';

const NOW = new Date('2026-08-19T09:00:00.000Z');

const template = (over: Partial<RiskInput['template']> = {}) => ({
  question: 'Will the Super Eagles beat Ivory Coast on Saturday?',
  outcomes: [
    { label: 'YES', criteria: 'Nigeria wins in 90 minutes' },
    { label: 'NO', criteria: 'Anything else' },
  ],
  sourceName: 'CAF',
  sourceUrl: 'https://cafonline.com/',
  eventDate: '2026-08-23T18:00:00.000Z',
  voidDate: '2026-08-30T18:00:00.000Z',
  edgeCases: {},
  ...over,
});

const codes = (input: Partial<RiskInput> = {}) =>
  voidRisks({
    template: template(),
    activationPath: 'organic',
    now: NOW,
    conflictAttested: true,
    ...input,
  }).map((risk) => risk.code);

describe('void risk warnings (§2.14e)', () => {
  it('says nothing about a well-formed market on a broad topic', () => {
    expect(codes()).toEqual([]);
  });

  it('warns that a far-out organic market will go quiet', () => {
    const far = template({
      eventDate: '2027-02-01T18:00:00.000Z',
      voidDate: '2027-02-10T18:00:00.000Z',
    });
    expect(codes({ template: far })).toContain('deadline_far');
  });

  it('softens the same warning when the creator is seeding it open', () => {
    const far = template({
      eventDate: '2027-02-01T18:00:00.000Z',
      voidDate: '2027-02-10T18:00:00.000Z',
    });
    const organic = voidRisks({
      template: far,
      activationPath: 'organic',
      now: NOW,
      conflictAttested: true,
    });
    const seeded = voidRisks({
      template: far,
      activationPath: 'seeded',
      now: NOW,
      conflictAttested: true,
    });

    expect(organic.find((risk) => risk.code === 'deadline_far')?.severity).toBe('high');
    expect(seeded.find((risk) => risk.code === 'deadline_far')?.severity).toBe('low');
  });

  it('warns when an ordinary postponement would void the market', () => {
    const tightVoid = template({ voidDate: '2026-08-23T22:00:00.000Z' });
    expect(codes({ template: tightVoid })).toContain('void_window_short');
  });

  it('warns a niche organic market that it may never fill', () => {
    const niche = template({
      question: 'Will my estate finish its perimeter fence this month?',
      eventDate: '2026-08-30T18:00:00.000Z',
      voidDate: '2026-09-07T18:00:00.000Z',
    });
    expect(codes({ template: niche })).toContain('niche_topic');
    // Seeding is the answer the spec names, so it must not warn about it.
    expect(codes({ template: niche, activationPath: 'seeded' })).not.toContain('niche_topic');
  });

  it('warns a wide organic field about spreading the pot', () => {
    const wide = template({
      outcomes: ['A', 'B', 'C', 'D', 'E'].map((label) => ({ label, criteria: `${label} wins` })),
    });
    expect(codes({ template: wide })).toContain('many_outcomes');
  });

  it('asks about a conflict until the creator has answered', () => {
    // Not passed at all — the state a creator is in before they answer.
    expect(
      voidRisks({ template: template(), activationPath: 'organic', now: NOW }).map(
        (risk) => risk.code,
      ),
    ).toContain('conflict_of_interest');
    expect(codes({ conflictAttested: true })).not.toContain('conflict_of_interest');
  });

  it('never blocks — every risk carries something to do about it', () => {
    const risks = voidRisks({
      template: template({ question: 'Will my cousin finish his NYSC posting paperwork?' }),
      activationPath: 'organic',
      now: NOW,
    });

    expect(risks.length).toBeGreaterThan(0);
    for (const risk of risks) expect(risk.suggestion.length).toBeGreaterThan(20);
  });

  it('does not interrupt for a conflict prompt alone', () => {
    // The attestation question is always there; it should not make the wizard
    // stop and demand attention on an otherwise clean market.
    const risks = voidRisks({ template: template(), activationPath: 'organic', now: NOW });
    expect(risks.map((risk) => risk.code)).toEqual(['conflict_of_interest']);
    expect(worthWarningAbout(risks)).toBe(false);
  });
});

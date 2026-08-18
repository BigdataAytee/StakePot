import { describe, expect, it } from 'vitest';

import { DEFAULT_NUDGE_RULES, nudgesFor, type MarketSnapshot } from './nudges';

const BASE: MarketSnapshot = {
  marketId: 'm1',
  state: 'active',
  activationPath: 'organic',
  stakedByOutcome: [50_000, 50_000],
  prices: [0.5, 0.5],
  outcomeLabels: ['Yes', 'No'],
  distinctStakers: 30,
  views: 400,
  hoursToWindowClose: null,
  hoursToEventDate: 72,
  hoursToProposalDeadline: null,
  resolutionProposed: false,
};

describe('nudge engine', () => {
  it('says nothing about a healthy market', () => {
    expect(nudgesFor(BASE, DEFAULT_NUDGE_RULES)).toEqual([]);
  });

  it('names the short side and the deadline, per §2.14d', () => {
    const nudges = nudgesFor(
      {
        ...BASE,
        state: 'funding',
        stakedByOutcome: [100_000, 40_000],
        hoursToWindowClose: 48,
      },
      DEFAULT_NUDGE_RULES,
    );

    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.kind).toBe('funding_lopsided');
    expect(nudges[0]?.action).toBe('share');
    expect(nudges[0]?.body).toContain('No');
    expect(nudges[0]?.body).toContain('2 days');
  });

  it('treats an empty funding window as quiet, not lopsided', () => {
    const nudges = nudgesFor(
      { ...BASE, state: 'funding', stakedByOutcome: [0, 0], hoursToWindowClose: 10 },
      DEFAULT_NUDGE_RULES,
    );
    expect(nudges.map((nudge) => nudge.kind)).toEqual(['funding_quiet']);
    expect(nudges[0]?.urgency).toBe('now');
  });

  it('counts the people a seeded market still needs', () => {
    const nudges = nudgesFor(
      {
        ...BASE,
        activationPath: 'seeded',
        distinctStakers: 4,
        hoursToWindowClose: 24,
        views: 10,
      },
      DEFAULT_NUDGE_RULES,
    );

    const short = nudges.find((nudge) => nudge.kind === 'participation_short');
    expect(short?.body).toContain('6 more people');
    expect(short?.body).toContain('your seed included');
    expect(short?.urgency).toBe('now');
  });

  it('flags a market the crowd has stopped arguing about', () => {
    const nudges = nudgesFor({ ...BASE, prices: [0.92, 0.08] }, DEFAULT_NUDGE_RULES);
    const settled = nudges.find((nudge) => nudge.kind === 'price_settled');
    expect(settled?.body).toContain('92%');
    expect(settled?.action).toBe('review_criteria');
  });

  it('reads views without stakes as a criteria problem', () => {
    const nudges = nudgesFor(
      { ...BASE, distinctStakers: 0, views: 120, prices: [0.5, 0.5] },
      DEFAULT_NUDGE_RULES,
    );
    expect(nudges.map((nudge) => nudge.kind)).toContain('views_no_stakes');
  });

  it('asks for the resolution once the event has happened', () => {
    const nudges = nudgesFor(
      {
        ...BASE,
        state: 'frozen',
        hoursToEventDate: -2,
        hoursToProposalDeadline: 46,
      },
      DEFAULT_NUDGE_RULES,
    );
    const due = nudges.find((nudge) => nudge.kind === 'resolution_due');
    expect(due?.action).toBe('propose_resolution');
    expect(due?.urgency).toBe('now');
  });

  it('escalates once the proposal deadline has passed, naming the bond', () => {
    const nudges = nudgesFor(
      {
        ...BASE,
        state: 'frozen',
        hoursToEventDate: -80,
        hoursToProposalDeadline: -8,
      },
      DEFAULT_NUDGE_RULES,
    );
    expect(nudges[0]?.kind).toBe('resolution_overdue');
    expect(nudges[0]?.body).toContain('bond');
  });

  it('says nothing about resolution once one has been proposed', () => {
    const nudges = nudgesFor(
      {
        ...BASE,
        state: 'frozen',
        hoursToEventDate: -80,
        hoursToProposalDeadline: -8,
        resolutionProposed: true,
      },
      DEFAULT_NUDGE_RULES,
    );
    expect(nudges).toEqual([]);
  });

  it('puts the urgent nudge first', () => {
    const nudges = nudgesFor(
      {
        ...BASE,
        state: 'active',
        activationPath: 'seeded',
        prices: [0.95, 0.05],
        distinctStakers: 1,
        hoursToWindowClose: 6,
      },
      DEFAULT_NUDGE_RULES,
    );
    expect(nudges[0]?.urgency).toBe('now');
    expect(nudges[nudges.length - 1]?.urgency).toBe('fyi');
  });
});

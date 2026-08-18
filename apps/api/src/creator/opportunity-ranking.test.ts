import { describe, expect, it } from 'vitest';

import {
  alreadyServed,
  DEFAULT_DEMAND_RULES,
  demandFromSearches,
  demandScore,
  normaliseQuery,
  rankOpportunities,
  timeliness,
} from './opportunity-ranking';

describe('opportunity ranking', () => {
  it('scores something happening tomorrow above the same thing next month', () => {
    expect(timeliness(1, DEFAULT_DEMAND_RULES)).toBeGreaterThan(
      timeliness(30, DEFAULT_DEMAND_RULES),
    );
  });

  it('scores a past event at zero — the opportunity has gone', () => {
    expect(timeliness(-1, DEFAULT_DEMAND_RULES)).toBe(0);
  });

  it('treats a handful of searches as noise', () => {
    expect(demandFromSearches(4, DEFAULT_DEMAND_RULES)).toBe(0);
    expect(demandFromSearches(5, DEFAULT_DEMAND_RULES)).toBe(0);
    expect(demandFromSearches(20, DEFAULT_DEMAND_RULES)).toBeGreaterThan(0);
  });

  it('saturates so one viral query cannot own the feed', () => {
    expect(demandFromSearches(50, DEFAULT_DEMAND_RULES)).toBe(1);
    expect(demandFromSearches(5_000, DEFAULT_DEMAND_RULES)).toBe(1);
  });

  it('ranks measured demand above a guess at demand', () => {
    const gap = demandScore(
      { source: 'search_gap', title: 'BBNaija eviction', searchers: 47, daysToEvent: 3 },
      DEFAULT_DEMAND_RULES,
    );
    const calendar = demandScore(
      { source: 'calendar', title: 'Same fixture', daysToEvent: 3 },
      DEFAULT_DEMAND_RULES,
    );
    expect(gap).toBeGreaterThan(calendar);
  });

  it('buckets the same question asked three different ways', () => {
    expect(normaliseQuery('BBNaija Eviction!')).toBe(normaliseQuery('bbnaija  evictions'));
    expect(normaliseQuery('eviction bbnaija')).toBe(normaliseQuery('bbnaija eviction'));
  });

  it('will not call a live market an unmet need', () => {
    const live = [{ question: 'Who will be evicted from BBNaija this week?' }];
    expect(alreadyServed('bbnaija evicted week', live, DEFAULT_DEMAND_RULES)).toBe(true);
    expect(alreadyServed('naira exchange rate december', live, DEFAULT_DEMAND_RULES)).toBe(false);
  });

  it('drops opportunities that have already expired', () => {
    const ranked = rankOpportunities(
      [
        { source: 'calendar', title: 'Yesterday', daysToEvent: -1 },
        { source: 'calendar', title: 'Tomorrow', daysToEvent: 1 },
      ],
      DEFAULT_DEMAND_RULES,
    );
    expect(ranked.map((entry) => entry.title)).toEqual(['Tomorrow']);
  });

  it('orders the feed by score', () => {
    const ranked = rankOpportunities(
      [
        { source: 'calendar', title: 'Far off', daysToEvent: 40 },
        { source: 'search_gap', title: 'Asked for a lot', searchers: 47, daysToEvent: 2 },
        { source: 'seasonal', title: 'AFCON', daysToEvent: 21 },
      ],
      DEFAULT_DEMAND_RULES,
    );
    expect(ranked[0]?.title).toBe('Asked for a lot');
    expect(ranked.map((entry) => entry.score)).toEqual(
      [...ranked].map((entry) => entry.score).sort((a, b) => b - a),
    );
  });
});

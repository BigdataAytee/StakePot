import { describe, expect, it } from 'vitest';

import {
  CONFLICT_PENALTY,
  crawlIntervalMs,
  DEMOTION_FLOOR,
  isPublicTier,
  maySettle,
  trustOf,
  type SourceRecord,
} from '../sources';

/**
 * The tier system, which exists to make one sentence true: nothing but a
 * resolution source can settle a market.
 */
function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return { tier: 'news', trust: 0.6, conflicts: 0, corroborations: 0, ...overrides };
}

describe('what each tier is allowed to do', () => {
  it('lets only resolution sources settle', () => {
    expect(maySettle('resolution')).toBe(true);
    expect(maySettle('news')).toBe(false);
    expect(maySettle('signal')).toBe(false);
  });

  it('keeps signals off every public screen', () => {
    // Forecast markets and poll aggregators are for pitching a threshold at
    // consensus. Published beside the platform's own price they would be the
    // platform telling its users what to think.
    expect(isPublicTier('signal')).toBe(false);
    expect(isPublicTier('news')).toBe(true);
    expect(isPublicTier('resolution')).toBe(true);
  });
});

describe('trust', () => {
  it('drops a news source that contradicts tier 1, without holding it back yet', () => {
    // Two contradictions cost 0.30 off a 0.60 base, landing at exactly the
    // floor's far side. Three would cross it — which is the intended shape: a
    // wire service that has disagreed with an official figure three times
    // running, with no corroboration in between, has earned a look.
    const verdict = trustOf(record({ conflicts: 2 }));
    expect(verdict.trust).toBeCloseTo(0.6 - 2 * CONFLICT_PENALTY, 6);
    expect(verdict.demoted).toBe(false);
  });

  it('holds one back on the third contradiction', () => {
    expect(trustOf(record({ conflicts: 3 })).demoted).toBe(true);
  });

  it('holds one back once it falls through the floor', () => {
    const verdict = trustOf(record({ conflicts: 5 }));
    expect(verdict.trust).toBeLessThan(DEMOTION_FLOOR);
    expect(verdict.demoted).toBe(true);
    expect(verdict.reason).toMatch(/until somebody reviews it/);
  });

  it('lets a source earn its way back off the floor', () => {
    const punished = trustOf(record({ conflicts: 3 }));
    const recovered = trustOf(record({ conflicts: 3, corroborations: 4 }));
    expect(punished.demoted).toBe(true);
    expect(recovered.trust).toBeGreaterThan(punished.trust);
    expect(recovered.demoted).toBe(false);
  });

  it('never scores a source above where its tier starts', () => {
    // Otherwise a well-behaved tabloid outranks a wire service on arithmetic
    // alone, and the tier stops meaning anything.
    expect(trustOf(record({ corroborations: 100 })).trust).toBe(0.6);
  });

  it('does not quietly demote a resolution source', () => {
    // A body whose publication *is* the fact contradicting itself is an
    // incident for a person, not a number to decay in the background.
    const verdict = trustOf(record({ tier: 'resolution', conflicts: 4 }));
    expect(verdict.demoted).toBe(false);
    expect(verdict.trust).toBe(1);
    expect(verdict.reason).toMatch(/incident/);
  });
});

describe('crawl cadence', () => {
  it('reads faster the closer a settlement is', () => {
    const intervals = [0.5, 3, 24, 200].map(crawlIntervalMs);
    expect(intervals).toEqual([...intervals].sort((a, b) => a - b));
    expect(crawlIntervalMs(0.5)).toBeLessThanOrEqual(2 * 60_000);
  });

  it('backs right off for a source no live market depends on', () => {
    expect(crawlIntervalMs(null)).toBeGreaterThan(crawlIntervalMs(200));
  });
});

import { describe, expect, it } from 'vitest';

import { bucketOf, flagOn, type FlagState } from './rollout';

const flag = (over: Partial<FlagState> = {}): FlagState => ({
  key: 'new-checkout',
  enabled: true,
  rolloutPct: 0,
  allowList: [],
  ...over,
});

const SUBJECTS = Array.from({ length: 2000 }, (_, index) => `user-${index}`);

describe('canary rollout (§2.13)', () => {
  it('gives the same subject the same answer every time', () => {
    const state = flag({ rolloutPct: 37 });
    const first = SUBJECTS.map((subject) => flagOn(state, subject));
    const second = SUBJECTS.map((subject) => flagOn(state, subject));

    expect(second).toEqual(first);
  });

  it('lands within a couple of points of the requested percentage', () => {
    for (const pct of [5, 25, 50, 90]) {
      const state = flag({ rolloutPct: pct });
      const inside = SUBJECTS.filter((subject) => flagOn(state, subject)).length;
      expect(Math.abs((inside / SUBJECTS.length) * 100 - pct)).toBeLessThan(4);
    }
  });

  it('only ever adds people as the percentage ramps', () => {
    // The property that makes a ramp a ramp. Bucketing on the percentage
    // instead of the key would fail this: every step would redraw the cohort.
    const at = (pct: number) =>
      new Set(SUBJECTS.filter((subject) => flagOn(flag({ rolloutPct: pct }), subject)));

    const five = at(5);
    const ten = at(10);
    const fifty = at(50);

    for (const subject of five) expect(ten.has(subject)).toBe(true);
    for (const subject of ten) expect(fifty.has(subject)).toBe(true);
  });

  it('does not put the same unlucky cohort in every experiment', () => {
    const a = new Set(SUBJECTS.filter((s) => flagOn(flag({ key: 'a', rolloutPct: 10 }), s)));
    const b = SUBJECTS.filter((s) => flagOn(flag({ key: 'b', rolloutPct: 10 }), s));
    const overlap = b.filter((subject) => a.has(subject)).length;

    // Independent 10% samples overlap around 1% of the population, not 10%.
    expect(overlap).toBeLessThan(b.length * 0.4);
  });

  it('treats disabled as a kill switch that beats the allow list', () => {
    const state = flag({ enabled: false, rolloutPct: 100, allowList: ['user-1'] });

    expect(flagOn(state, 'user-1')).toBe(false);
    expect(flagOn(state, 'user-2')).toBe(false);
  });

  it('always includes the allow list below 100%', () => {
    const state = flag({ rolloutPct: 0, allowList: ['staff-1'] });

    expect(flagOn(state, 'staff-1')).toBe(true);
    expect(flagOn(state, 'user-1')).toBe(false);
  });

  it('gives an anonymous visitor the flag only at 100%', () => {
    expect(flagOn(flag({ rolloutPct: 50 }), null)).toBe(false);
    expect(flagOn(flag({ rolloutPct: 100 }), null)).toBe(true);
  });

  it('keeps buckets inside 0–99', () => {
    for (const subject of SUBJECTS.slice(0, 200)) {
      const bucket = bucketOf('k', subject);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });
});

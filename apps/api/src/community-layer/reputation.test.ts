import { describe, expect, it } from 'vitest';

import {
  accuracyOf,
  boldness,
  brier,
  calibrationOf,
  reliability,
  titleFor,
  topCalls,
  type Call,
  type CallCandidate,
} from './reputation';

const call = (probability: number, won: boolean, category = 'football'): Call => ({
  probability,
  won,
  category,
});

describe('accuracy', () => {
  it('is null below a sample worth quoting', () => {
    // Two from two is not a 100% forecaster; publishing it as one would be a
    // claim the evidence does not support.
    expect(accuracyOf([call(0.5, true), call(0.5, true)])).toBeNull();
  });

  it('counts wins over settled calls', () => {
    const calls = [true, true, true, false, false].map((won) => call(0.5, won));
    expect(accuracyOf(calls)).toBeCloseTo(0.6, 10);
  });
});

describe('calibration (§2.15b)', () => {
  it('scores a perfect forecaster at 1 and a coin-flipper at 0', () => {
    const perfect = [call(1, true), call(1, true), call(0, false), call(0, false), call(1, true)];
    expect(calibrationOf(perfect)).toBeCloseTo(1, 10);

    // "50% on everything" is the definition of no skill, and it should read as
    // zero rather than as three quarters of the way to expert.
    const coinFlip = Array.from({ length: 10 }, (_, index) => call(0.5, index % 2 === 0));
    expect(calibrationOf(coinFlip)).toBeCloseTo(0, 10);
  });

  it('clamps worse-than-a-coin-flip at zero rather than going negative', () => {
    const wrong = Array.from({ length: 10 }, () => call(0.95, false));
    expect(calibrationOf(wrong)).toBe(0);
  });

  it('separates the favourite-backer from the calibrated forecaster', () => {
    // Both are right 80% of the time. The first claims certainty and is wrong
    // one time in five; the second says 80% and is right 80% of the time.
    const overconfident = Array.from({ length: 10 }, (_, index) => call(0.99, index < 8));
    const calibrated = Array.from({ length: 10 }, (_, index) => call(0.8, index < 8));

    expect(accuracyOf(overconfident)).toBe(accuracyOf(calibrated));
    expect(calibrationOf(calibrated) ?? 0).toBeGreaterThan(calibrationOf(overconfident) ?? 1);
  });

  it('brier is 0.25 for a coin-flipper, which is what the rescale assumes', () => {
    const coinFlip = Array.from({ length: 10 }, (_, index) => call(0.5, index % 2 === 0));
    expect(brier(coinFlip)).toBeCloseTo(0.25, 10);
  });
});

describe('reliability diagram', () => {
  it('buckets by stated confidence and reports what happened', () => {
    const calls = [
      ...Array.from({ length: 10 }, (_, index) => call(0.85, index < 9)),
      ...Array.from({ length: 10 }, (_, index) => call(0.25, index < 2)),
    ];

    const bands = reliability(calls);
    expect(bands.map((band) => band.band)).toEqual(['20–30%', '80–90%']);
    expect(bands[1]?.actual).toBeCloseTo(0.9, 10);
    expect(bands[0]?.actual).toBeCloseTo(0.2, 10);
  });

  it('omits a band nobody used rather than reporting it as zero', () => {
    // "never right at 90%" and "never said 90%" are different claims.
    expect(reliability([call(0.5, true)]).map((band) => band.band)).toEqual(['50–60%']);
  });
});

describe('category titles (§2.15b)', () => {
  const sharp = (n: number, category: string) =>
    Array.from({ length: n }, (_, index) => call(0.7, index < n * 0.8, category));

  it('names the category where there is a name for it', () => {
    expect(titleFor('sports', sharp(20, 'sports'))).toBe('Football Prophet');
    expect(titleFor('money', sharp(20, 'money'))).toBe('Oracle of Naira');
    // A topic with no title of its own still earns the generic one.
    expect(titleFor('everything', sharp(20, 'everything'))).toBe('Sharp Eye');
  });

  it('withholds a title below the sample floor', () => {
    expect(titleFor('sports', sharp(6, 'sports'))).toBeNull();
  });

  it('refuses a title to a favourite-backer who clears accuracy alone', () => {
    // Right 80% of the time, but claiming near-certainty every time. Accuracy
    // passes; calibration is what stops this.
    const overconfident = Array.from({ length: 20 }, (_, index) => call(0.99, index < 16));
    expect(accuracyOf(overconfident) ?? 0).toBeGreaterThan(0.6);
    expect(titleFor('football', overconfident)).toBeNull();
  });

  it('only counts calls in the category being titled', () => {
    const mixed = [...sharp(20, 'sports'), ...sharp(4, 'politics')];
    expect(titleFor('sports', mixed)).toBe('Football Prophet');
    expect(titleFor('politics', mixed)).toBeNull();
  });
});

describe('weekly Top Calls (§2.15b)', () => {
  const candidate = (
    userId: string,
    probability: number,
    won: boolean,
    marketId = 'm1',
  ): CallCandidate => ({ userId, marketId, probability, won, category: 'football' });

  it('ranks the longer shot above the larger favourite', () => {
    const picked = topCalls([
      candidate('a', 0.8, true),
      candidate('b', 0.15, true),
      candidate('c', 0.45, true),
    ]);

    expect(picked.map((entry) => entry.userId)).toEqual(['b', 'c', 'a']);
  });

  it('ignores bold calls that lost', () => {
    // A bold wrong call is just a wrong call.
    expect(topCalls([candidate('a', 0.02, false)])).toHaveLength(0);
  });

  it('shows one entry per person so a single sharp week cannot fill the board', () => {
    const picked = topCalls([
      candidate('a', 0.1, true, 'm1'),
      candidate('a', 0.12, true, 'm2'),
      candidate('a', 0.14, true, 'm3'),
      candidate('b', 0.5, true, 'm4'),
    ]);

    expect(picked).toHaveLength(2);
    expect(picked[0]?.userId).toBe('a');
    // Their boldest, not their first.
    expect(picked[0]?.marketId).toBe('m1');
  });

  it('scores boldness as distance from consensus, not as profit', () => {
    expect(boldness(call(0.15, true))).toBeCloseTo(0.85, 10);
    expect(boldness(call(0.8, true))).toBeCloseTo(0.2, 10);
    expect(boldness(call(0.15, false))).toBe(0);
  });
});

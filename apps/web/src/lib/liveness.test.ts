import { describe, expect, it } from 'vitest';

import type { Candle } from './candles';
import { EDGE_STEP_MS, carryCandles, carryForward, edgeAt, elapsed } from './liveness';

describe('edgeAt', () => {
  it('quantises the clock so a redraw costs a step, not a frame', () => {
    expect(edgeAt(1_700_000_003_999)).toBe(edgeAt(1_700_000_000_000));
    expect(edgeAt(1_700_000_000_000 + EDGE_STEP_MS)).toBeGreaterThan(edgeAt(1_700_000_000_000));
  });
});

describe('carryForward', () => {
  const line = [
    { time: 100, value: 60 },
    { time: 200, value: 64 },
  ];

  it('extends the line at the last traded value and no other', () => {
    const carried = carryForward(line, 500);

    expect(carried).toHaveLength(3);
    expect(carried[2]).toEqual({ time: 500, value: 64 });
    // The whole point: the added point is the last price, not a step towards
    // anything. Nothing between the two moved, so the segment is flat.
    expect(carried[2]!.value).toBe(carried[1]!.value);
  });

  it('leaves an empty series empty rather than inventing a first point', () => {
    expect(carryForward([], 500)).toEqual([]);
  });

  it('adds nothing when the last point is already at the edge', () => {
    expect(carryForward(line, 200)).toEqual(line);
  });

  it('adds nothing when a skewed clock puts the last trade in the future', () => {
    expect(carryForward(line, 150)).toEqual(line);
  });

  it('never alters a real point', () => {
    const carried = carryForward(line, 900);
    expect(carried.slice(0, 2)).toEqual(line);
  });
});

describe('carryCandles', () => {
  const bucket = 60;
  const candles: Candle[] = [{ time: 600, open: 50, high: 70, low: 45, close: 62 }];

  it('fills the untraded buckets with dojis at the last close', () => {
    const carried = carryCandles(candles, 780, bucket);

    expect(carried).toHaveLength(4);
    for (const filled of carried.slice(1)) {
      expect(filled).toMatchObject({ open: 62, high: 62, low: 62, close: 62 });
    }
  });

  it('stays inside the current bucket until it ends', () => {
    expect(carryCandles(candles, 650, bucket)).toEqual(candles);
  });

  it('caps the fill so a long-dormant market does not lock the tab', () => {
    const carried = carryCandles(candles, 600 + 10_000 * bucket, bucket, 5);
    expect(carried).toHaveLength(1 + 6);
  });

  it('leaves an empty series empty', () => {
    expect(carryCandles([], 900, bucket)).toEqual([]);
  });
});

describe('elapsed', () => {
  it('keeps the seconds while the seconds are the story', () => {
    expect(elapsed(0)).toBe('0s');
    expect(elapsed(4_400)).toBe('4s');
    expect(elapsed(59_000)).toBe('59s');
  });

  it('coarsens once seconds stop meaning anything', () => {
    expect(elapsed(60_000)).toBe('1m');
    expect(elapsed(3_599_000)).toBe('59m');
    expect(elapsed(7_200_000)).toBe('2h');
    expect(elapsed(3 * 86_400_000)).toBe('3d');
  });

  it('reads a clock skewed the wrong way as no time at all', () => {
    expect(elapsed(-5_000)).toBe('0s');
  });
});

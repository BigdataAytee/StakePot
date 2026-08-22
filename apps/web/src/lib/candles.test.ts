import { describe, expect, it } from 'vitest';

import { bucketFor, toCandles } from './candles';

const at = (iso: string, price: string) => ({
  outcomeId: 'o1',
  price,
  pot: '0',
  ts: iso,
});

describe('OHLC bucketing', () => {
  it('opens on the first snapshot in the bucket and closes on the last', () => {
    const candles = toCandles(
      [
        at('2026-08-19T10:00:10Z', '0.40'),
        at('2026-08-19T10:03:00Z', '0.55'),
        at('2026-08-19T10:14:00Z', '0.50'),
      ],
      15 * 60,
    );
    expect(candles).toHaveLength(1);
    expect(candles[0]?.open).toBeCloseTo(40);
    expect(candles[0]?.close).toBeCloseTo(50);
  });

  it('takes the extremes as high and low, not the endpoints', () => {
    const candles = toCandles(
      [
        at('2026-08-19T10:00:00Z', '0.50'),
        at('2026-08-19T10:05:00Z', '0.80'),
        at('2026-08-19T10:06:00Z', '0.20'),
        at('2026-08-19T10:07:00Z', '0.55'),
      ],
      15 * 60,
    );
    expect(candles[0]?.high).toBeCloseTo(80);
    expect(candles[0]?.low).toBeCloseTo(20);
  });

  it('splits snapshots across buckets', () => {
    const candles = toCandles(
      [at('2026-08-19T10:05:00Z', '0.40'), at('2026-08-19T10:20:00Z', '0.60')],
      15 * 60,
    );
    expect(candles).toHaveLength(2);
    expect(candles[0]?.close).toBeCloseTo(40);
    expect(candles[1]?.open).toBeCloseTo(60);
  });

  it('aligns buckets to the epoch so two renders of one market agree', () => {
    // The failure this prevents: bucketing from the first point makes the same
    // market's candles land on different boundaries depending on when it is
    // charted, so the picture changes without the data changing.
    const candles = toCandles([at('2026-08-19T10:07:00Z', '0.5')], 15 * 60);
    expect((candles[0]?.time ?? 0) % (15 * 60)).toBe(0);
  });

  it('handles points arriving out of order', () => {
    const candles = toCandles(
      [at('2026-08-19T10:10:00Z', '0.70'), at('2026-08-19T10:01:00Z', '0.30')],
      15 * 60,
    );
    expect(candles[0]?.open).toBeCloseTo(30);
    expect(candles[0]?.close).toBeCloseTo(70);
  });

  it('returns nothing for no points rather than one empty candle', () => {
    expect(toCandles([], 900)).toEqual([]);
  });

  it('sizes buckets so a timeframe stays readable', () => {
    expect(bucketFor('1H')).toBeLessThan(bucketFor('1D'));
    expect(bucketFor('1D')).toBeLessThan(bucketFor('ALL'));
  });
});

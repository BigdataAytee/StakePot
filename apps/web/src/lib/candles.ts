import type { PricePoint } from './api';
import { percent } from './format';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Price snapshots bucketed into OHLC candles (§7.2a's power-user toggle).
 *
 * Our history is per-trade and per-minute snapshots rather than a stream of
 * ticks, so a candle here is "what this outcome's probability did during this
 * bucket" — open and close are the first and last snapshots in it, high and
 * low the extremes. That is the honest reading of the data we hold; anything
 * fancier would be inventing intra-bucket movement we never recorded.
 *
 * Buckets are aligned to the epoch rather than to the first point, so the same
 * market charted at two different moments lines its candles up instead of
 * shifting them by however long ago the first trade was.
 */
export function toCandles(points: PricePoint[], bucketSeconds: number): Candle[] {
  const byBucket = new Map<number, Candle>();

  const ordered = [...points].sort(
    (left, right) => new Date(left.ts).getTime() - new Date(right.ts).getTime(),
  );

  for (const point of ordered) {
    const at = Math.floor(new Date(point.ts).getTime() / 1000);
    if (!Number.isFinite(at)) continue;
    const bucket = Math.floor(at / bucketSeconds) * bucketSeconds;
    const value = percent(point.price);

    const existing = byBucket.get(bucket);
    if (existing === undefined) {
      byBucket.set(bucket, { time: bucket, open: value, high: value, low: value, close: value });
      continue;
    }
    // Points arrive in time order, so the newest is always the close.
    existing.close = value;
    existing.high = Math.max(existing.high, value);
    existing.low = Math.min(existing.low, value);
  }

  return [...byBucket.values()].sort((left, right) => left.time - right.time);
}

/** A bucket size that leaves a readable number of candles for a timeframe. */
export function bucketFor(timeframe: string): number {
  switch (timeframe) {
    case '1H':
      return 60; // a candle a minute
    case '6H':
      return 5 * 60;
    case '1D':
      return 15 * 60;
    case '1W':
      return 2 * 60 * 60;
    default:
      return 12 * 60 * 60;
  }
}

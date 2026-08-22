import type { Candle } from './candles';

/**
 * Carrying a chart's line up to the present without inventing a price.
 *
 * A market that has not traded for ten minutes has not stopped existing, but
 * a chart whose last point is ten minutes old looks like one that has stopped
 * loading. The fix is not to make up prices — it is to draw the ten minutes
 * that actually happened, during which the price was exactly what the last
 * trade left it at.
 *
 * So: one extra point, at now, carrying the *same value* as the last real one.
 * A flat segment is a true statement — nobody traded, so nothing moved — and
 * it is the only extension of this line that is. Everything this module
 * refuses to do is the point of it:
 *
 * - no interpolation between the last price and anything else,
 * - no drift, decay, or reversion towards a mean,
 * - no synthetic movement of any kind.
 *
 * The extended point is drawn and never stored. It does not go back to the
 * API, it is not written to price history, and it carries no timestamp any
 * trade could be confused with — it is the present, and the present is where
 * the price still is.
 */

/**
 * How often the live edge advances.
 *
 * Five seconds rather than every frame. On a one-hour window in a 600px chart
 * a second is a sixth of a pixel, so a per-second redraw would cost sixty
 * full-series redraws a minute to move the line by nothing visible. Five
 * seconds is roughly a pixel on the tightest timeframe offered, which is the
 * smallest step anybody can see and therefore the largest one worth paying
 * for.
 */
export const EDGE_STEP_MS = 5_000;

/** The live edge, quantised, so a ticking clock does not redraw continuously. */
export function edgeAt(nowMs: number): number {
  return Math.floor(nowMs / EDGE_STEP_MS) * EDGE_STEP_MS;
}

export interface LinePoint {
  readonly time: number;
  readonly value: number;
}

/**
 * The line, carried forward to `nowSeconds` at its last traded value.
 *
 * Returns the input untouched when there is nothing to carry — an empty
 * series, or a last point already at or past the edge. A market whose last
 * trade is somehow in the future (a clock skewed between the browser and the
 * server, which happens) gets no edge rather than a line that doubles back.
 */
export function carryForward(data: readonly LinePoint[], nowSeconds: number): LinePoint[] {
  const last = data[data.length - 1];
  if (last === undefined || nowSeconds <= last.time) return [...data];
  return [...data, { time: nowSeconds, value: last.value }];
}

/**
 * The same, for candles: flat buckets from the last one to the current one.
 *
 * A doji — open, high, low and close all equal to the last close — because
 * that is what a bucket in which nothing traded looks like. Every empty bucket
 * in between is filled rather than just the current one: skipping them would
 * leave a candle chart with gaps that read as missing data, when what actually
 * happened is that nothing happened.
 *
 * Capped, because a market that last traded in March charted on a one-minute
 * bucket is hundreds of thousands of empty candles and a locked-up tab.
 */
export function carryCandles(
  data: readonly Candle[],
  nowSeconds: number,
  bucketSeconds: number,
  maxFilled = 400,
): Candle[] {
  const last = data[data.length - 1];
  if (last === undefined || bucketSeconds <= 0) return [...data];

  const current = Math.floor(nowSeconds / bucketSeconds) * bucketSeconds;
  if (current <= last.time) return [...data];

  const filled: Candle[] = [...data];
  const from = Math.max(last.time + bucketSeconds, current - maxFilled * bucketSeconds);
  for (let time = from; time <= current; time += bucketSeconds) {
    filled.push({
      time,
      open: last.close,
      high: last.close,
      low: last.close,
      close: last.close,
    });
  }
  return filled;
}

/**
 * How long since the last trade, at the resolution the wait deserves.
 *
 * Seconds while it is still seconds, because on a live chart the difference
 * between "4s" and "40s" is the difference between a market being traded and a
 * market being watched — and `ago()` rounds both to "just now". Past a minute
 * the coarser form is enough: nobody needs the seconds on an hour.
 */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * The two numbers a threshold market's reader actually wants side by side:
 * where the source last said the thing is, and where the market says it has
 * to be.
 *
 * The second one is the awkward half. StakeAm markets state their threshold in
 * prose — "below ₦1,500/$", "under 24.0%" — because that is what reads well on
 * a ticket, so the level has to be recovered from the wording rather than read
 * from a column. That is a parse, and parses are wrong sometimes, which is why
 * this returns null rather than a guess: the strip is absent when the level
 * cannot be recovered, and an absent strip is honest where a wrong number on a
 * money screen is not.
 */

export interface Threshold {
  /** The level, as written. "₦1,500" or "24.0%". */
  readonly label: string;
  /** The same level as a number, for comparing against a published figure. */
  readonly value: number;
  /** Which way the market is asking. */
  readonly direction: 'below' | 'above';
}

const DIRECTION = /\b(below|under|beneath|less than|above|over|at least|more than)\b/i;
const ABOVE = /\b(above|over|at least|more than)\b/i;

/** A currency amount or a percentage, with its separators intact. */
const LEVEL = /(₦\s?[\d,]+(?:\.\d+)?|\$\s?[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?\s?%)/;

/**
 * Recover the threshold from a market's own question.
 *
 * Deliberately conservative: both a direction word and a level have to be
 * present, in that order. "Will the naira close below ₦1,500/$" parses; "Will
 * the naira strengthen this month" does not, and should not — there is no line
 * to draw on a chart for it.
 */
export function thresholdOf(question: string): Threshold | null {
  const direction = DIRECTION.exec(question);
  if (direction === null) return null;

  const after = question.slice(direction.index);
  const level = LEVEL.exec(after);
  if (level === null) return null;

  const label = (level[1] ?? '').replace(/\s+/g, '');
  const value = Number(label.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(value)) return null;

  return {
    label,
    value,
    direction: ABOVE.test(direction[1] ?? '') ? 'above' : 'below',
  };
}

/** One published reading, plotted against the threshold. */
export interface WatchPoint {
  readonly value: number;
  /** When the source published it — not when we read it. */
  readonly at: string;
  /** Who published it, so no number on the screen is unattributed. */
  readonly outlet: string;
}

export interface SourceWatch {
  readonly sourceName: string;
  /** The latest figure that source published, as written. Null if none. */
  readonly latest: string | null;
  readonly latestValue: number | null;
  /** When it was read. */
  readonly checkedAt: string | null;
  readonly threshold: Threshold | null;
  /**
   * Whether the latest published figure is on the market's side of the line.
   * Null when either half is missing — and null is common, which is the point.
   */
  readonly meetsThreshold: boolean | null;
  /**
   * Every reading the named body has published for this market, oldest first.
   *
   * This is the underlying quantity — a naira rate, a CPI print — and it is
   * emphatically not the price. The price is what traders think the answer
   * will be; this is the thing they are guessing about, moving on its own
   * schedule and in its own units. They belong on the same screen and never on
   * the same axis, which is why each point carries the outlet that published
   * it and the moment it was published: a figure on a money screen with no
   * name and no timestamp on it is a rumour.
   *
   * Empty for almost every market. A one-off print, a match result, an
   * election — none of them are a series, and drawing a line through a single
   * point would be inventing a trend.
   */
  readonly series: readonly WatchPoint[];
}

/** Put the two halves together, saying null wherever a half is missing. */
export function sourceWatchOf(input: {
  sourceName: string;
  question: string;
  latest: { value: string | number; publishedAt: Date } | null;
  /** Every official reading, in any order. Unparseable ones are dropped. */
  readings?: readonly { value: string | number; publishedAt: Date; outlet: string }[];
}): SourceWatch {
  const threshold = thresholdOf(input.question);
  const latestValue = input.latest === null ? null : numeric(String(input.latest.value));

  const series = (input.readings ?? [])
    .map((reading) => ({
      value: numeric(String(reading.value)),
      at: reading.publishedAt.toISOString(),
      outlet: reading.outlet,
    }))
    // A reading that will not parse as a number cannot be plotted. Dropped
    // rather than zeroed: a zero on this line is a naira rate of nothing.
    .filter((point): point is WatchPoint => point.value !== null)
    .sort((left, right) => left.at.localeCompare(right.at));

  return {
    sourceName: input.sourceName,
    latest: input.latest === null ? null : display(input.latest.value, threshold),
    latestValue,
    checkedAt: input.latest?.publishedAt.toISOString() ?? null,
    threshold,
    meetsThreshold:
      threshold === null || latestValue === null
        ? null
        : threshold.direction === 'below'
          ? latestValue < threshold.value
          : latestValue > threshold.value,
    // One point is a reading, not a series. Kept as a single-element list
    // rather than emptied, so the caller decides whether to draw it — the
    // strip prints it as a figure and the sparkline needs two.
    series,
  };
}

/**
 * The published figure, wearing the same unit as the level it is compared to.
 *
 * A source publishes `1532.41` and the market says "below ₦1,500", so the strip
 * read "Latest 1532.41 · Settles below ₦1,500" — the same quantity written two
 * ways, on a screen whose whole job is to let somebody compare them at a
 * glance. The symbol is not invented: the threshold and the reading are the
 * same measurement by construction, which is what makes the comparison
 * meaningful in the first place.
 *
 * Only when the published value is bare. A source that formatted its own
 * figure keeps its formatting — it knows what it published better than this
 * does.
 */
function display(value: string | number, threshold: Threshold | null): string {
  const raw = String(value);
  if (threshold === null || /[^\d.,\s-]/.test(raw)) return raw;

  const prefix = /^[^\d]+/.exec(threshold.label)?.[0] ?? '';
  const suffix = /[^\d.,]+$/.exec(threshold.label)?.[0] ?? '';
  const grouped = Number(raw).toLocaleString('en-NG', { maximumFractionDigits: 2 });
  return `${prefix}${grouped}${prefix === '' ? suffix : ''}`;
}

function numeric(raw: string): number | null {
  const digits = raw.replace(/[^\d.-]/g, '');
  if (digits.trim().length === 0) return null;
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : null;
}

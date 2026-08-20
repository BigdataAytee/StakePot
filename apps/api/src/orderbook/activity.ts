import { Decimal } from '@stakeam/engine';

import { KOBO_PER_SHARE, type Side } from './matching';

/**
 * Reading a matched fill back as the trade somebody actually made.
 *
 * Three decisions live here, and each of them is a way of being wrong that a
 * live activity feed would otherwise be wrong in.
 *
 * **Counted once, from the taker's side.** A fill has two participants. Both
 * of them traded, but only one of them *did* anything — the taker crossed the
 * spread, the maker had been waiting since whenever. Counting both would report
 * twice the activity the market has, which on a trades-per-hour readout is a
 * crowd that does not exist.
 *
 * **Always a buy of something.** The book stores a taker `sell` as the short
 * side of the first outcome; the person pressed "Buy NO". So a fill is read
 * back as a buy of whichever outcome they now hold. This also keeps the
 * pressure readout meaning what it always meant: on the pot, buy and sell are
 * *enter* and *exit*, and every matched fill is an entry.
 *
 * **Volume is the whole pair's stake.** A pot buy commits one person's money;
 * a matched fill commits two, and together they are exactly ₦1 a share. That
 * total is the money the trade moved, and it is the figure comparable with a
 * pot trade's cost — the taker's half alone would under-report a matched
 * market against a pot one by whatever the price happened to be.
 */

export interface FillRow {
  readonly id: string;
  readonly takerUserId: string;
  readonly takerSide: Side;
  readonly outcomeId: string;
  readonly priceKobo: number;
  readonly shares: Decimal;
  readonly createdAt: Date;
}

export interface OutcomeRef {
  readonly id: string;
  readonly label: string;
  readonly ordinal: number;
}

export interface MatchedActivity {
  readonly id: string;
  readonly userId: string;
  readonly outcomeId: string;
  readonly label: string;
  /** Always `buy`: a matched fill opens a position, it never closes one. */
  readonly side: 'buy';
  readonly shares: Decimal;
  /** Both sides' stake — ₦1 a share, which is what the pair committed. */
  readonly naira: Decimal;
  /** The price of the outcome the taker ended up holding, in kobo. */
  readonly priceKobo: number;
  readonly createdAt: Date;
}

/**
 * What the taker holds after this fill, and what it cost the pair.
 *
 * Returns null when the market's outcomes cannot account for the fill — a
 * shape that should be unreachable, and is dropped rather than guessed at: a
 * mislabelled row on a public feed is worse than a missing one.
 */
export function readMatchedFill(
  fill: FillRow,
  outcomes: readonly OutcomeRef[],
): MatchedActivity | null {
  const ordered = [...outcomes].sort((left, right) => left.ordinal - right.ordinal);
  const bookOutcome = ordered.find((outcome) => outcome.id === fill.outcomeId);
  if (bookOutcome === undefined) return null;

  const complement = ordered.find((outcome) => outcome.id !== fill.outcomeId);
  const held = fill.takerSide === 'buy' ? bookOutcome : complement;
  if (held === undefined) return null;

  return {
    id: fill.id,
    userId: fill.takerUserId,
    outcomeId: held.id,
    label: held.label,
    side: 'buy',
    shares: fill.shares,
    naira: fill.shares,
    priceKobo: fill.takerSide === 'buy' ? fill.priceKobo : KOBO_PER_SHARE - fill.priceKobo,
    createdAt: fill.createdAt,
  };
}

export function readMatchedFills(
  fills: readonly FillRow[],
  outcomes: readonly OutcomeRef[],
): MatchedActivity[] {
  return fills
    .map((fill) => readMatchedFill(fill, outcomes))
    .filter((row): row is MatchedActivity => row !== null);
}

/**
 * Merge two streams into one feed, newest first.
 *
 * Generic over the row because three surfaces need it — the pulse ticker, the
 * context panel's activity list, and the market's own recent trades — and the
 * one thing they must agree on is the ordering. A feed that interleaved
 * differently in two places would have people comparing screenshots.
 */
export function newestFirst<T>(rows: readonly T[], at: (row: T) => Date, take: number): T[] {
  return [...rows].sort((left, right) => at(right).getTime() - at(left).getTime()).slice(0, take);
}

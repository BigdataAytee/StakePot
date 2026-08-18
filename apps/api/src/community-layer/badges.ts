/**
 * §2.15a's position badge.
 *
 * "Each comment displays the commenter's position badge ('YES @ 62%' / 'no
 * position') — arguments become accountable; talking your book is visible."
 *
 * The badge is a *snapshot*, taken when the comment is posted and never
 * recomputed. That is the whole mechanism: a badge that followed the position
 * would let somebody argue a side, close out, and leave a comment that reads as
 * disinterested. §2.15a's prediction receipts depend on the same permanence —
 * "at resolution, every comment keeps its badge permanently".
 *
 * Pure, because what a badge says is a claim about somebody that has to be
 * reproducible from the numbers that were true at the time.
 */

/** What the commenter held when they spoke. */
export interface PositionSnapshot {
  /** The outcome they are long, or null when they hold nothing. */
  readonly outcomeLabel: string | null;
  /** The market's price for that outcome at the moment of posting, 0–1. */
  readonly priceAtPost: number | null;
  /** Shares held. Zero or absent means no position. */
  readonly shares: number;
}

/** The stored form: short, human, and parseable back into its parts. */
export const NO_POSITION = 'none';

/**
 * Render a badge from a position.
 *
 * Deliberately keeps the price the commenter *is speaking at* rather than their
 * average entry: §2.15a's example is "YES @ 62%", and the useful accountability
 * question is "what did the market say when you said that", which is also what
 * makes a right call impressive later.
 */
export function badgeFor(position: PositionSnapshot): string {
  if (position.outcomeLabel === null || position.shares <= 0) return NO_POSITION;
  if (position.priceAtPost === null) return position.outcomeLabel.toUpperCase();
  return `${position.outcomeLabel.toUpperCase()}@${Math.round(position.priceAtPost * 100)}`;
}

export interface ParsedBadge {
  readonly outcomeLabel: string | null;
  readonly pricePct: number | null;
}

/** Read a stored badge back. Anything unrecognised reads as no position. */
export function parseBadge(badge: string): ParsedBadge {
  if (badge === NO_POSITION || badge.trim().length === 0) {
    return { outcomeLabel: null, pricePct: null };
  }
  const at = badge.lastIndexOf('@');
  if (at === -1) return { outcomeLabel: badge, pricePct: null };

  const pct = Number(badge.slice(at + 1));
  return {
    outcomeLabel: badge.slice(0, at),
    pricePct: Number.isFinite(pct) ? pct : null,
  };
}

/**
 * Whether a badged comment called the result (§2.15a's prediction receipt).
 *
 * Null rather than false when there is nothing to judge — no position, or an
 * unreadable badge. A comment from somebody holding nothing is not a wrong
 * call; it is not a call at all, and marking it wrong would punish exactly the
 * disinterested commentary the thread wants.
 */
export function calledIt(badge: string, winningLabel: string): boolean | null {
  const parsed = parseBadge(badge);
  if (parsed.outcomeLabel === null) return null;
  return parsed.outcomeLabel.toUpperCase() === winningLabel.toUpperCase();
}

/**
 * How bold a correct call was, 0–1, for §2.15b's Top Calls later.
 *
 * A call at 15% that landed is the platform's best marketing asset; the same
 * call at 90% is a shrug. Computed here so the receipt and any future
 * leaderboard cannot disagree about what "bold" meant.
 */
export function boldness(badge: string, winningLabel: string): number | null {
  const correct = calledIt(badge, winningLabel);
  if (correct !== true) return null;
  const { pricePct } = parseBadge(badge);
  if (pricePct === null) return null;
  return Math.min(1, Math.max(0, 1 - pricePct / 100));
}

/**
 * §2.9's generation rules, as arithmetic.
 *
 * Everything here is pure and deterministic on purpose. The model proposes; the
 * rules in this file decide — balance, duplication, catalogue discipline and
 * rank. A rule that lives in a system prompt is a preference; a rule that lives
 * here is a rule, and it can be tested without an API key.
 */

/**
 * §2.9 rule 8's shelf plan: "[6] official slots (2 economic bankers, 1 recurring
 * sport, 1 seasonal blockbuster, 1 cost-of-living, 1 rotating trending).
 * Suggest replacements per cycle, not additions."
 */
export const CATALOGUE_SLOTS = {
  economic_banker: {
    slots: 2,
    brief: 'Naira, inflation or interest rates, pitched at the analyst consensus.',
  },
  recurring_sport: { slots: 1, brief: 'Super Eagles, AFCON or an EPL fixture with a live stake.' },
  seasonal_blockbuster: {
    slots: 1,
    brief: 'BBNaija, an award show or an election — whatever the season is arguing about.',
  },
  cost_of_living: { slots: 1, brief: 'Fuel, electricity, food prices — the daily squeeze.' },
  rotating_trending: { slots: 1, brief: 'Whatever the country is talking about this fortnight.' },
} as const;

export type CatalogueSlot = keyof typeof CATALOGUE_SLOTS;

export const CATALOGUE_SLOT_NAMES = Object.keys(CATALOGUE_SLOTS) as CatalogueSlot[];

export function isCatalogueSlot(value: string): value is CatalogueSlot {
  return Object.prototype.hasOwnProperty.call(CATALOGUE_SLOTS, value);
}

/** How many official markets the shelf plan allows in total. */
export const OFFICIAL_SHELF_SIZE = Object.values(CATALOGUE_SLOTS).reduce(
  (total, slot) => total + slot.slots,
  0,
);

/**
 * How close to a genuine argument this question is, in [0, 1].
 *
 * §2.9's prime directive is "maximise genuine disagreement", and the honest
 * measure of that is distance from an even split — 1 when every outcome is
 * equally likely, 0 when one of them is a certainty. Scaled so a binary market
 * at 65/35 (the edge of the acceptable band) scores 0.7, not 0.35: inside the
 * band the differences are real but small, and a scoring function that treats
 * them as enormous would rank on noise.
 */
export function balanceQuality(estimates: readonly number[]): number {
  if (estimates.length < 2) return 0;
  const total = estimates.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;

  const normalised = estimates.map((value) => value / total);
  const even = 1 / estimates.length;
  const leader = Math.max(...normalised);

  // Distance from even, normalised by the furthest a leader can be from it.
  const drift = (leader - even) / (1 - even);
  return Math.max(0, 1 - drift);
}

/**
 * §2.9 rule 3's band, as a gate rather than a score.
 *
 * Binary questions must sit inside [low, high]; on a multi-outcome question no
 * single outcome may be estimated above `multiMax`. The engine "rejects its own
 * draft" outside these, which is the difference between a preference and a rule.
 */
export function withinBalanceBand(
  estimates: readonly number[],
  bounds: { binaryLow: number; binaryHigh: number; multiMax: number },
): boolean {
  if (estimates.length < 2) return false;
  const total = estimates.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return false;
  const normalised = estimates.map((value) => value / total);

  if (normalised.length === 2) {
    const first = normalised[0] ?? 0;
    return first >= bounds.binaryLow && first <= bounds.binaryHigh;
  }
  return Math.max(...normalised) <= bounds.multiMax;
}

/**
 * Rank: engagement weighted by how good an argument it is.
 *
 * §2.9 rule 5 says score and rank by predicted engagement; the backtest in the
 * same section is what says balance is worth money (+24% fee per market). So
 * engagement sets the size of the prize and balance decides how much of it the
 * market actually collects — a multiplication, not an average, because a
 * one-sided market on a huge topic still earns nothing.
 */
export function draftScore(input: { engagement: number; estimates: readonly number[] }): number {
  const engagement = Math.min(1, Math.max(0, input.engagement));
  return Number((engagement * balanceQuality(input.estimates)).toFixed(6));
}

/** Words too common in market questions to distinguish one from another. */
const STOPWORDS = new Set([
  'will',
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'at',
  'by',
  'to',
  'for',
  'be',
  'is',
  'it',
  'this',
  'that',
  'and',
  'or',
  'before',
  'after',
  'than',
  'up',
  'down',
  'next',
  'end',
  'still',
  'any',
  'their',
  'its',
]);

function terms(question: string): Set<string> {
  return new Set(
    question
      .toLowerCase()
      .replace(/[^a-z0-9₦%\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 1 && !STOPWORDS.has(word)),
  );
}

/**
 * Jaccard overlap between two questions' meaningful terms, in [0, 1].
 *
 * Deliberately dumb and deterministic. §2.9 asks the model for duplicate
 * detection too, but a duplicate is a liquidity problem — two markets splitting
 * one argument — and that is worth catching without a network call and without
 * a model's opinion on the day.
 */
export function questionSimilarity(left: string, right: string): number {
  const a = terms(left);
  const b = terms(right);
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const term of a) if (b.has(term)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** The live market this draft would duplicate, if any. */
export function duplicateOf(
  question: string,
  live: readonly { id: string; question: string }[],
  threshold: number,
): { id: string; question: string; similarity: number } | null {
  let worst: { id: string; question: string; similarity: number } | null = null;

  for (const market of live) {
    const similarity = questionSimilarity(question, market.question);
    if (similarity >= threshold && (worst === null || similarity > worst.similarity)) {
      worst = { id: market.id, question: market.question, similarity };
    }
  }
  return worst;
}

/** What the queue's order depends on. Anything else about a draft is display. */
export interface QueuePosition {
  state: 'suggested' | 'rejected' | string;
  firstMarket: boolean;
  score: number;
}

/**
 * §6.2's queue order: open work first, first-time creators next, then score.
 *
 * The first-market rung is the one worth arguing about, because it deliberately
 * outranks the engine's own confidence. A high score means the model liked the
 * question; the creators it is least entitled to be confident about are the
 * ones it has never seen settle anything. §2.9 says first-time creators are
 * "always flagged for human review", and a flag that does not move the row is
 * not a flag — it is a field.
 *
 * Pure, so the ordering is testable without a database. It was previously
 * inline in the service, next to a first-market conditional that read
 * `isFirstMarket && state === 'suggested' ? 'suggested' : state` — the same
 * value on both branches, so the rule was enforced nowhere.
 */
export function byQueuePriority(a: QueuePosition, b: QueuePosition): number {
  if (a.state !== b.state) return a.state === 'suggested' ? -1 : 1;
  if (a.firstMarket !== b.firstMarket) return a.firstMarket ? -1 : 1;
  return b.score - a.score;
}

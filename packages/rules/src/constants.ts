/**
 * The numbers the checklist states in prose, in one place.
 *
 * Every one of these appears in the document as a figure inside a sentence —
 * "target 35-65%", "≈25x typical stake", "past 75/25 after 48h". Written out
 * again at each call site they drift: the wizard warns at 35% while the AI
 * self-rejects at 30% and the reviewer cannot tell which is the rule.
 */

/** Rule 6. A binary market outside this band is a market nobody argues about. */
export const BALANCE_BAND = { low: 0.35, high: 0.65 } as const;

/**
 * Rule 6, applied to a list rather than a pair.
 *
 * A four-way race cannot sit inside 35-65% — an even split is 25% each — so the
 * band is expressed as a ceiling on the favourite instead. Above this, one
 * outcome is the answer and the others are decoration.
 */
export const MULTI_FAVOURITE_MAX = 0.6;

/** Rule 10. Beyond this, a market is asking for attention it will not hold. */
export const ATTENTION_WINDOW_DAYS = 42;

/** Rule 10's exception: blockbusters may run long, but not indefinitely. */
export const BLOCKBUSTER_WINDOW_DAYS = 180;

/** Rule 24. L sized to expected volume: about 25x a typical stake. */
export const LIQUIDITY_MULTIPLE = 25;

/** Rule 24's tolerance before the wizard says anything. */
export const LIQUIDITY_TOLERANCE = 2.5;

/** Rule 33. Settling the same day as this many others is a collision. */
export const COLLISION_THRESHOLD = 3;

/** Rule 35. Past this split, 48 hours in, the question was probably bad. */
export const LOPSIDED_SPLIT = 0.75;
export const LOPSIDED_AFTER_HOURS = 48;

/**
 * Rule 36. One account holding this much of a market's stake, this early, is
 * a price being set rather than discovered.
 */
export const WHALE_SHARE = 0.5;
export const WHALE_WINDOW_HOURS = 24;

/** Rule 38. A market whose event has passed by this much needs a resolution. */
export const UNRESOLVED_GRACE_HOURS = 12;

/** Rule 39. Beyond this from the event, settlement is late. */
export const SLOW_RESOLUTION_HOURS = 24;

/** Rule 26. Every date a market states is in this zone. */
export const TIMEZONE = 'WAT' as const;

/**
 * Rule 28/29. Statistics whose name alone does not identify a figure.
 *
 * Matching on these is what triggers the demand for an exact metric and, where
 * the figure gets revised, the first-published clause. The list is deliberately
 * short: it catches the recurring Nigerian macro questions the shelf actually
 * runs, and a term not on it costs a reviewer nothing because rule 25's
 * stranger test still stands above it.
 */
export const AMBIGUOUS_METRICS: readonly { readonly term: RegExp; readonly revised: boolean }[] = [
  { term: /\binflation\b/i, revised: true },
  { term: /\bcpi\b/i, revised: true },
  { term: /\bgdp\b/i, revised: true },
  { term: /\bunemployment\b/i, revised: true },
  { term: /\breserves?\b/i, revised: true },
  { term: /\bfuel price\b/i, revised: false },
  { term: /\bpetrol price\b/i, revised: false },
  { term: /\bexchange rate\b/i, revised: false },
];

/** Rule 29. A market quoting money has to say which currency and which window. */
export const CURRENCY_TERMS = /(₦|\bnaira\b|\bnjn\b|\bngn\b|\$|\busd\b|\bdollar)/i;

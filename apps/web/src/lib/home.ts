import type { MarketSummary, OutcomeView } from './api';

/**
 * The front page's own vocabulary.
 *
 * The home page groups markets by topic, ranks them by how busy they are, and
 * gives every question a tile — none of which the API models, because none of
 * it is truth. A market has a question, a shelf and a pot; "Sports" and the
 * green square next to it are reading aids, and they are derived here rather
 * than stored so that nothing on the front page can drift out of step with the
 * market it describes.
 */

export interface Topic {
  key: string;
  label: string;
  /** What a question about this topic tends to say. Ordered — first match wins. */
  match: RegExp;
}

/**
 * The topic strip, in the order it is shown.
 *
 * Nigerian-first on purpose: the naira, the Eagles and the ballot are what this
 * audience already argues about, so they are the first three doors rather than
 * an "Other" bucket three scrolls down.
 */
export const TOPICS: Topic[] = [
  {
    key: 'politics',
    label: 'Politics',
    match:
      /\b(inec|election|governor|senate|president|tinubu|obi|atiku|apc|pdp|labour party|ballot|poll|minister|bill|assembly)\b/i,
  },
  {
    key: 'sports',
    label: 'Sports',
    match:
      /\b(eagles|super falcons|afcon|caf|nff|premier league|npfl|fifa|world cup|match|derby|goal|olympic|boxing|f1|nba|cricket)\b/i,
  },
  {
    key: 'money',
    label: 'Money',
    match:
      /\b(naira|cbn|inflation|petrol|pump price|fuel|dollar|exchange rate|gdp|budget|tax|bank|interest rate|mpc|nnpc|diesel|cement|rice)\b/i,
  },
  {
    key: 'crypto',
    label: 'Crypto',
    match: /\b(bitcoin|btc|ethereum|eth|crypto|stablecoin|usdt|token|binance|solana)\b/i,
  },
  {
    key: 'culture',
    label: 'Culture',
    match:
      /\b(bbnaija|big brother|nollywood|afrobeats|burna|wizkid|davido|asake|rema|grammy|amvca|headies|album|single|netflix|film|song|music)\b/i,
  },
  {
    key: 'tech',
    label: 'Tech',
    match:
      /\b(startup|funding round|ai|apple|google|openai|meta|nvidia|app|launch|iphone|android|chip)\b/i,
  },
  {
    key: 'weather',
    label: 'Weather',
    match: /\b(rain|rainfall|flood|harmattan|temperature|nimet|storm|heat)\b/i,
  },
];

const FALLBACK: Topic = { key: 'everything', label: 'Everything else', match: /.^/ };

/** Which strip a market belongs under. Never null — everything has a door. */
export function topicOf(market: Pick<MarketSummary, 'question' | 'sourceName'>): Topic {
  const haystack = `${market.question} ${market.sourceName}`;
  return TOPICS.find((topic) => topic.match.test(haystack)) ?? FALLBACK;
}

/** The topics that actually have markets, in strip order, with counts. */
export function topicsPresent(markets: MarketSummary[]): { topic: Topic; count: number }[] {
  const counts = new Map<string, number>();
  for (const market of markets) {
    const key = topicOf(market).key;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const present = TOPICS.filter((topic) => counts.has(topic.key)).map((topic) => ({
    topic,
    count: counts.get(topic.key) as number,
  }));
  const spare = counts.get(FALLBACK.key);
  return spare === undefined ? present : [...present, { topic: FALLBACK, count: spare }];
}

/**
 * The two letters on a market's tile.
 *
 * Every market on the front page wears a square, and the squares are what make
 * a grid of forty questions scannable rather than a wall of text. There are no
 * artworks to hang there, so a market wears the initials of its own question —
 * stable, readable at 38px, and never a missing image.
 */
export function monogram(question: string): string {
  const words = question
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 2 &&
        !/^(will|the|and|for|any|his|her|its|are|has|have|from|with|this|that)$/i.test(word),
    );
  const first = words[0] ?? question.trim();
  const second = words[1];
  return ((first[0] ?? 'S') + (second?.[0] ?? first[1] ?? '')).toUpperCase();
}

/**
 * A stable pair of hues for a market's tile, keyed off its id.
 *
 * Deterministic so the same market wears the same square on every render and in
 * every session — a tile that changes colour on reload is worse than no tile,
 * because it stops being a thing a returning reader recognises.
 */
export function tileHue(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  return hash;
}

/** How busy a market is. The pot is the only volume figure the API exposes. */
export function volumeOf(market: MarketSummary): number {
  const pot = Number.parseFloat(market.pot);
  return Number.isFinite(pot) ? pot : 0;
}

/** Busiest first, with a market that nobody has touched sinking to the bottom. */
export function byBusiest(left: MarketSummary, right: MarketSummary): number {
  return volumeOf(right) - volumeOf(left);
}

/** Closing soonest first, among markets that have not frozen. */
export function bySoonest(left: MarketSummary, right: MarketSummary): number {
  return new Date(left.eventDate).getTime() - new Date(right.eventDate).getTime();
}

/** Newest first. Ids are cuids, which sort roughly by creation — so use dates. */
export function byNewest(left: MarketSummary, right: MarketSummary): number {
  return new Date(right.voidDate).getTime() - new Date(left.voidDate).getTime();
}

export const SORTS = [
  { key: 'volume', label: 'Volume', compare: byBusiest },
  { key: 'closing', label: 'Closing soon', compare: bySoonest },
  { key: 'new', label: 'Newest', compare: byNewest },
] as const;

export type SortKey = (typeof SORTS)[number]['key'];

export const isSortKey = (value: string | undefined): value is SortKey =>
  SORTS.some((sort) => sort.key === value);

/**
 * The Yes and No of a binary market, in that order — or null if it is not one.
 *
 * The order is the whole point. Everything else on the front page is ranked by
 * price, and ranking a Yes/No pair puts whichever side is winning into the
 * green slot: a market at No 61% renders a green "No" and a red "Yes", which
 * inverts the one colour convention the whole product runs on (§7.4 — green is
 * YES, red is NO). So a binary market is never ranked. Yes is first because it
 * is Yes.
 */
export function binaryPair(market: MarketSummary): [OutcomeView, OutcomeView] | null {
  if (market.outcomes.length !== 2) return null;
  const yes = market.outcomes.find((outcome) => /^yes$/i.test(outcome.label));
  const no = market.outcomes.find((outcome) => /^no$/i.test(outcome.label));
  return yes === undefined || no === undefined ? null : [yes, no];
}

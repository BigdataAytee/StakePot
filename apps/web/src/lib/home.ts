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
 * The icon-fallback ramp, taken from the reference.
 *
 * Already tuned to sit together on a white ground, which a generated hue is
 * not — six markets side by side in a grid should look like a set rather than
 * like a colour wheel.
 */
export const ICON_COLOURS = ['#2d5cf6', '#8b5cf6', '#0ea5a4', '#e64800', '#27ae5f', '#d97706'];

/** The colour a market's icon wears. Stable, so it is recognisable on return. */
export function iconColour(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 1_000_003;
  }
  return ICON_COLOURS[hash % ICON_COLOURS.length] as string;
}

/** A number the API sent as a string, or 0 if it sent nothing usable. */
function figure(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** How busy a market has been today. The shelf's default order. */
export function volume24hOf(market: MarketSummary): number {
  return figure(market.volume24h);
}

/** Everything ever staked into it. */
export function volumeOf(market: MarketSummary): number {
  return figure(market.pot);
}

/**
 * The four orders the shelf offers.
 *
 * They are four genuinely different questions — what is busy now, what is new,
 * what is big, and what is about to close — rather than one ranking relabelled.
 * "Trending" reads today's traded volume, which is why the list endpoint goes
 * and computes it: ordering by the total pot instead would rank a market that
 * filled up last month above the one filling up while you read this.
 */
export const SORTS = [
  {
    key: 'trending',
    label: 'Trending',
    compare: (a: MarketSummary, b: MarketSummary) => volume24hOf(b) - volume24hOf(a),
  },
  {
    key: 'new',
    label: 'New',
    compare: (a: MarketSummary, b: MarketSummary) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  },
  {
    key: 'volume',
    label: 'Volume',
    compare: (a: MarketSummary, b: MarketSummary) => volumeOf(b) - volumeOf(a),
  },
  {
    key: 'ending',
    label: 'Ending soon',
    compare: (a: MarketSummary, b: MarketSummary) =>
      new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime(),
  },
] as const;

export type SortKey = (typeof SORTS)[number]['key'];

export const isSortKey = (value: string | undefined): value is SortKey =>
  SORTS.some((sort) => sort.key === value);

/** The comparator for a sort key, falling back to the default order. */
export function comparatorFor(key: string | undefined) {
  return (SORTS.find((sort) => sort.key === key) ?? SORTS[0]).compare;
}

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

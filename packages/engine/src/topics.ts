/**
 * What a market is *about* (§2.15b's category titles, §7.1's topic strip).
 *
 * This lives in the engine package for one reason: both apps need the same
 * answer. The web app draws the topic strip from it and the API awards
 * category titles from it, and if the two ever disagree then somebody is
 * "Football Prophet" on a profile while their markets sit under Culture. A
 * taxonomy is an odd thing to find in a package called `engine`, and the
 * alternative — the same regex list maintained twice — is worse in the exact
 * way this classifier exists to prevent.
 *
 * Derived from the question rather than stored on the market, so nothing can
 * drift out of step with the market it describes, and so re-categorising is a
 * code change rather than a backfill.
 */
export interface Topic {
  key: string;
  label: string;
  /** What a question about this topic tends to say. Ordered — first match wins. */
  match: RegExp;
}

/**
 * The topics, in the order the strip shows them.
 *
 * Nigerian-first on purpose: the naira, the Eagles and the ballot are what this
 * audience already argues about, so they are the first three doors rather than
 * an "Other" bucket three scrolls down.
 */
export const TOPICS: readonly Topic[] = [
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

/** The bucket for a question that matches nothing. Everything has a door. */
export const FALLBACK_TOPIC: Topic = {
  key: 'everything',
  label: 'Everything else',
  match: /.^/,
};

/** Which topic a market belongs under. Never null. */
export function topicFor(question: string, sourceName = ''): Topic {
  const haystack = `${question} ${sourceName}`;
  return TOPICS.find((topic) => topic.match.test(haystack)) ?? FALLBACK_TOPIC;
}

/** Just the key, which is what gets stored on a reputation row. */
export function topicKeyFor(question: string, sourceName = ''): string {
  return topicFor(question, sourceName).key;
}

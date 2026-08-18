import { questionSimilarity } from '../community/draft-ranking';

/**
 * §2.14b's opportunity feed, as rules.
 *
 * Three sources, one ranking. The calendar knows what is coming; the season
 * knows what is coming in bulk; and the search log knows what people came
 * looking for and did not find — "47 users searched 'BBNaija eviction' this
 * week — no market exists. Create it?"
 *
 * The last one is the valuable one, because it is the only signal on the
 * platform that measures demand the platform failed to meet. It is also the one
 * that must not fire on a question already trading, so the gap test reuses
 * §2.9's similarity rather than inventing a second opinion about what counts as
 * the same market.
 */

export type OpportunitySource = 'calendar' | 'search_gap' | 'seasonal';

export interface OpportunityInput {
  readonly source: OpportunitySource;
  readonly title: string;
  /** Distinct people who searched for this and found nothing. Search gaps only. */
  readonly searchers?: number;
  /** Days until the thing happens. Null when there is no date attached. */
  readonly daysToEvent: number | null;
}

export interface DemandRules {
  /** Searchers below this are noise, not demand. */
  readonly minSearchers: number;
  /** Searchers at which a gap scores full marks. */
  readonly saturationSearchers: number;
  /** Beyond this horizon an event is too far off to act on. */
  readonly horizonDays: number;
  /** Similarity at which a live market already serves a search. */
  readonly servedThreshold: number;
}

export const DEFAULT_DEMAND_RULES: DemandRules = {
  minSearchers: 5,
  saturationSearchers: 50,
  horizonDays: 45,
  servedThreshold: 0.5,
};

/**
 * Urgency from a date: something happening tomorrow is worth more than the same
 * thing in a month, because a creator can only capture volume before it starts.
 *
 * Something already past scores zero — the opportunity has gone.
 */
export function timeliness(daysToEvent: number | null, rules: DemandRules): number {
  if (daysToEvent === null) return 0.5;
  if (daysToEvent < 0) return 0;
  if (daysToEvent >= rules.horizonDays) return 0.1;
  return 1 - (daysToEvent / rules.horizonDays) * 0.9;
}

/** How loudly people asked, 0–1, saturating so one viral query cannot dominate. */
export function demandFromSearches(searchers: number, rules: DemandRules): number {
  if (searchers < rules.minSearchers) return 0;
  const span = rules.saturationSearchers - rules.minSearchers;
  if (span <= 0) return 1;
  return Math.min(1, (searchers - rules.minSearchers) / span);
}

/**
 * The demand score stored on the row and used to order the feed.
 *
 * A search gap is scored on what people actually asked for; a calendar or
 * seasonal entry has no such evidence, so it is scored on timing alone and
 * weighted below a gap of equal urgency. Measured demand beats a guess about
 * demand, every time.
 */
export function demandScore(input: OpportunityInput, rules: DemandRules): number {
  const when = timeliness(input.daysToEvent, rules);
  if (input.source === 'search_gap') {
    const asked = demandFromSearches(input.searchers ?? 0, rules);
    // Weighted toward the evidence: a gap with real searchers is worth
    // surfacing even when there is no date attached to it.
    return round(asked * 0.7 + when * 0.3);
  }
  return round(when * 0.6);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Whether a live market already answers what somebody searched for.
 *
 * §2.14b's promise is "no market exists" — surfacing an opportunity that one
 * does would send a creator to build a duplicate, which splits the liquidity of
 * the market already trading (§2.14e).
 */
export function alreadyServed(
  query: string,
  live: readonly { question: string }[],
  rules: DemandRules,
): boolean {
  return live.some((market) => questionSimilarity(query, market.question) >= rules.servedThreshold);
}

/**
 * Search terms normalised into one bucket.
 *
 * "bbnaija eviction", "BBNaija Eviction!", and "bbnaija  evictions" are one
 * question being asked three times, and counting them separately is how a real
 * signal gets buried under its own spelling.
 */
export function normaliseQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9₦%\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
    .sort()
    .join(' ');
}

export interface RankedOpportunity extends OpportunityInput {
  readonly score: number;
}

export function rankOpportunities(
  inputs: readonly OpportunityInput[],
  rules: DemandRules,
): readonly RankedOpportunity[] {
  return [...inputs]
    .map((input) => ({ ...input, score: demandScore(input, rules) }))
    .filter((ranked) => ranked.score > 0)
    .sort((left, right) => right.score - left.score);
}

/**
 * §3's `events` table, given a vocabulary.
 *
 * "events — id, user_id?, name, properties_json, ts [analytics]"
 *
 * A free-text `name` column is how an analytics table becomes unusable: six
 * months in there are four spellings of the same event, two of them typos, and
 * no way to tell which dashboards are wrong. So the names live here, the
 * properties are typed, and a call site that invents one does not compile.
 *
 * The taxonomy is deliberately small. Every event listed is one somebody has
 * asked a question with — funnel (did they sign up, fund, stake), growth (did
 * the share link work), and money (what settled, what was paid) — rather than
 * everything that could conceivably be logged.
 */

export const EVENT_SCHEMAS = {
  // ------------------------------------------------------------------ funnel
  signup: {} as { tier: number },
  contact_verified: {} as { tier: number },
  first_stake: {} as { marketId: string; amount: string },

  // ------------------------------------------------------------ the argument
  /** §2.14d's views→stakes conversion. Written by the client, with a source. */
  market_view: {} as { marketId: string; source: string },
  /** §2.14b's unmet-demand signal reads the ones that found nothing. */
  market_search: {} as { query: string; resultCount: number },
  comment_posted: {} as { marketId: string; hasPosition: boolean; fromTrade: boolean },
  /** §2.15d: the link was opened. The denominator for "strongest motivator". */
  challenge_opened: {} as { marketId: string },
  challenge_accepted: {} as { marketId: string },
  share_card_rendered: {} as { marketId: string; format: string },

  // ------------------------------------------------------------------- money
  trade_placed: {} as { marketId: string; side: string; amount: string },
  market_activated: {} as { marketId: string; path: string },
  market_resolved: {} as { marketId: string; pot: string; fee: string },
  market_voided: {} as { marketId: string; reason: string },

  // ------------------------------------------------- engagement (§2.8, §6.8)
  leaderboard_snapshot: {} as { period: string; board: string; entries: number },
  prize_run_proposed: {} as { period: string; board: string; total: string; awards: number },
  prize_paid: {} as { period: string; board: string; total: string; awards: number },
} as const;

export type EventName = keyof typeof EVENT_SCHEMAS;

export type EventProperties<N extends EventName> = (typeof EVENT_SCHEMAS)[N];

export const EVENT_NAMES = Object.keys(EVENT_SCHEMAS) as EventName[];

export function isEventName(value: string): value is EventName {
  return Object.prototype.hasOwnProperty.call(EVENT_SCHEMAS, value);
}

/**
 * The events a funnel is built from, in order.
 *
 * Kept here rather than in a dashboard query so the funnel a chart draws and
 * the funnel the team talks about are the same list.
 */
export const FUNNEL: readonly EventName[] = [
  'signup',
  'contact_verified',
  'market_view',
  'first_stake',
];

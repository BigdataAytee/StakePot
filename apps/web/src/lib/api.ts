/** Shapes the API returns. Money and prices cross the wire as strings, never floats. */

export interface OutcomeView {
  id: string;
  label: string;
  ordinal: number;
  price: string;
  staked: string;
  /** Shares outstanding — the denominator in the §2.3 payout estimate. */
  shares: string;
  /** The "Any other" catch-all bucket (§2.5). Always ranks last. */
  isOther: boolean;
}

export interface MarketSummary {
  id: string;
  shelf: 'official' | 'community';
  /** When the market opened. What "New" sorts on. */
  createdAt: string;
  question: string;
  sourceName: string;
  sourceUrl: string;
  state: string;
  /** How the market reaches `active` (§2.4). Path B carries a live seed. */
  activationPath: 'organic' | 'seeded';
  /** When the funding window closes — Path B's participation floor deadline. */
  fundingClosesAt: string | null;
  eventDate: string;
  /**
   * When trading stops (§2.3, rule 22): the event less a buffer. Sent as data,
   * not as a rendered sentence, so the countdown, the badge and the sheet's
   * refusal are all derived from the same fact the API enforces on.
   */
  freezeAt: string | null;
  /** When it actually froze, and the reason recorded with it. */
  frozenAt: string | null;
  freezeReason: string | null;
  voidDate: string;
  pot: string;
  /** Liquidity constant L. The Trade Ticket prices its preview with it. */
  liquidity: string;
  feeBps: number;
  criteria: unknown;
  resolvedOutcomeId: string | null;
  outcomes: OutcomeView[];
  /**
   * The headline outcome's move over 24h, as a fraction of where it started.
   * Null on a market younger than the window, which is not the same as flat.
   */
  change24h: number | null;
  /** Money traded in the last 24h, seeds excluded. What "Trending" sorts on. */
  volume24h: string;
  sparkline?: string[];
}

export interface Annotation {
  id: string;
  type: 'open' | 'activation' | 'big_trade' | 'news' | 'freeze' | 'resolution';
  label: string;
  /** Set only on `news`: where a pinned item came from. */
  url: string | null;
  /** Set only on `news`: the staff account that pinned it. */
  pinnedBy: string | null;
  ts: string;
}

export interface MarketDetail extends MarketSummary {
  livePrices: Record<string, string> | null;
  annotations: Annotation[];
  traderCount: number;
  /** Whose market this is (§2.14c). Null on the official shelf. */
  creator: CreatorByline | null;
  /** What the winners split. Null while the market is still open. */
  distributed: string | null;
  /** §2.6's proposed resolution, once somebody has proposed one. */
  resolution: {
    proposedOutcomeId: string | null;
    evidenceUrl: string | null;
    proposedAt: string;
    finalOutcomeId: string | null;
    finalizedAt: string | null;
  } | null;
  /** When the 48h dispute window shuts. Null until a resolution is proposed. */
  disputeClosesAt: string | null;
}

/** One outcome's lifetime numbers, for the context panel's key stats. */
export interface OutcomeStats {
  outcomeId: string;
  label: string;
  /** Prices are 0-1 fractions here, not strings: nothing settles against them. */
  opened: number | null;
  latest: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  /** How many accounts are holding this side right now. */
  holders: number;
}

export interface ActivityEntry {
  id: string;
  /** A per-market pseudonym. Never a handle — a trade is not a post. */
  actor: string;
  /**
   * Where it filled.
   *
   * Not decoration: a matched row is a claim on an exact ₦1 a share and a pot
   * row is a claim on a share of a pot. Every other surface keeps those apart,
   * and a feed that quietly mixed them would be the one place that did not.
   */
  venue?: 'matched' | 'pot';
  side: 'buy' | 'sell' | 'seed';
  outcomeId: string;
  label: string;
  shares: string;
  cost: string;
  price: string;
  ts: string;
}

/** One story, however many outlets ran it. */
export interface NewsCluster {
  id: string;
  headline: string;
  url: string;
  /** The outlet whose copy this is — the first to carry it. */
  outlet: string;
  tier: 'resolution' | 'news';
  /** How many outlets carried the same story. */
  sourceCount: number;
  publishedAt: string;
  relevance: number;
  pinnedAt: string | null;
  pinnedBy: string | null;
}

/** The named source's latest figure against the market's own threshold. */
export interface SourceWatch {
  sourceName: string;
  latest: string | null;
  latestValue: number | null;
  checkedAt: string | null;
  threshold: { label: string; value: number; direction: 'below' | 'above' } | null;
  /** Null whenever either half is missing, which is most of the time. */
  meetsThreshold: boolean | null;
  /**
   * Every reading the named body has published, oldest first.
   *
   * The underlying quantity, not the price — a naira rate or a CPI print,
   * moving on its own schedule and in its own units. Empty for most markets.
   */
  series: { value: number; at: string; outlet: string }[];
}

export interface MarketContext {
  openedAt: string;
  news: NewsCluster[];
  sourceWatch: SourceWatch;
  stats: OutcomeStats[];
  biggestMove: {
    outcomeId: string;
    label: string;
    from: number;
    to: number;
    ts: string;
  } | null;
  activity: ActivityEntry[];
}

/**
 * How busy a market is right now, counted from executed trades and from
 * nothing else.
 *
 * Every field here is activity. None of it is a price, none of it is derived
 * from one, and none of it may be read as one — see apps/api/src/http/pulse.ts.
 */
export interface MarketPulse {
  /** The server's clock when this was read, so the client can age it. */
  now: string;
  windowMinutes: number;
  tradesPerHour: number;
  trend: 'rising' | 'falling' | 'steady';
  tradersActive: number;
  activeMinutes: number;
  lastTradeAt: string | null;
  pressure: {
    buys: number;
    sells: number;
    /** Buys as a share of buys and sells. Null when nothing has traded. */
    buyShare: number | null;
    windowMinutes: number;
  };
  ticker: ActivityEntry[];
}

/**
 * One price level on the book: how much is there, and what it would cost to
 * take it.
 *
 * Aggregated by the API — forty orders at 62 kobo is one line saying how much
 * is available, not forty lines saying who. Nobody's identity is in a depth
 * response: a book is a quantity at a price.
 */
export interface DepthLevel {
  priceKobo: number;
  shares: string;
  /** What sweeping this level would cost the taker of it. */
  naira: string;
}

export interface MarketBook {
  /** False when this market has no book — pot-only, and saying so. */
  enabled: boolean;
  bookOutcomeId: string | null;
  /** What a buyer of the first outcome can lift. */
  asks: DepthLevel[];
  /** What a buyer of the second outcome can lift, quoted on the same book. */
  bids: DepthLevel[];
}

/**
 * What a trade would do, before anybody commits to it.
 *
 * The matched and pot legs are kept apart on purpose and must stay apart on
 * screen. A matched share pays ₦1 exactly, out of money a named counterparty
 * has already escrowed; a pot share pays a share of a pot that is still
 * filling. One number for both would be describing neither.
 */
export interface TradeQuote {
  matched: {
    shares: string;
    cost: string;
    /** ₦1 a share. Known now, not projected. */
    exactPayout: string;
    priceKobo: number | null;
  } | null;
  pot: {
    shares: string;
    cost: string;
    averageKobo: string | null;
    quotedKobo: string;
  } | null;
  resting: { shares: string; priceKobo: number | null; locked: string } | null;
  /** Thin-pot and price-impact warnings, in words a trader can act on. */
  warnings: string[];
}

export interface OpenOrder {
  id: string;
  marketId: string;
  question: string;
  outcomeId: string;
  label: string;
  side: 'buy' | 'sell';
  priceKobo: number;
  shares: string;
  filled: string;
  locked: string;
  createdAt: string;
}

export interface SponsorView {
  userId: string;
  contribution: string;
  feeSharePct: string;
}

export interface SeedComposition {
  marketId: string;
  state: string;
  activationPath: 'organic' | 'seeded';
  fundingClosesAt: string | null;
  /** Money each seeder put in, from the seed legs on the trade record. */
  seeded: { userId: string; amount: string }[];
  syndicate: {
    id: string;
    state: 'open' | 'filled' | 'refunded';
    roundEndsAt: string;
    minTotal: string;
    perOutcomeMin: string;
    minContribution: string;
    maxSponsors: number;
    organiserBps: number;
    raised: string;
    sponsors: SponsorView[];
  } | null;
}

export interface CreatorByline {
  id: string;
  handle: string | null;
  displayName: string | null;
  /** §2.14c's level badge. Null at level 1 — a new creator wears no claim. */
  badge: string | null;
  followerCount: number;
  cleanResolutions: number;
}

/**
 * One bar of trading activity: how many trades landed in this bucket, which
 * way they went, and how much money moved.
 *
 * Volume, never price. It sits under the price line to answer the question a
 * flat line cannot — whether the market is being argued over at a stable price
 * or simply not being traded.
 */
export interface FlowBucket {
  /** Bucket start, epoch seconds, aligned to the timeframe's grid. */
  ts: number;
  buys: number;
  sells: number;
  volume: string;
}

export interface MarketFlow {
  bucketSeconds: number;
  buckets: FlowBucket[];
}

export interface PricePoint {
  outcomeId: string;
  price: string;
  pot: string;
  ts: string;
}

export const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001';

async function get<T>(path: string, revalidate = 0): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    next: { revalidate },
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${path} responded ${response.status}`);
  }
  return (await response.json()) as T;
}

export const api = {
  markets: (shelf?: string) =>
    get<MarketSummary[]>(`/markets${shelf === undefined ? '' : `?shelf=${shelf}`}`),
  market: (id: string) => get<MarketDetail>(`/markets/${id}`),
  /** Seed composition and seeding-round terms (§2.4, Rulebook Part 3 §3). */
  seed: (id: string) => get<SeedComposition>(`/community/markets/${id}/seed`),
  /** Everything under the chart: key stats, biggest move, recent activity. */
  context: (id: string) => get<MarketContext>(`/markets/${id}/context`),
  /** How busy the market is right now — trade counts, never a price. */
  pulse: (id: string) => get<MarketPulse>(`/markets/${id}/pulse`),
  /** Bucketed trading activity for the chart's volume bars. */
  flow: (id: string, tf: string) => get<MarketFlow>(`/markets/${id}/flow?tf=${tf}`),
  /** The order book's depth, or `enabled: false` on a pot-only market. */
  book: (id: string) => get<MarketBook>(`/markets/${id}/book`),
  /** Omit `outcomeId` to get every outcome's series — the multi-line overlay. */
  history: (id: string, outcomeId: string | undefined, tf: string) =>
    get<PricePoint[]>(
      `/markets/${id}/history?tf=${tf}${outcomeId === undefined ? '' : `&outcomeId=${outcomeId}`}`,
    ),
};

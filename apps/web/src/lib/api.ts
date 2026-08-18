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
  question: string;
  sourceName: string;
  sourceUrl: string;
  state: string;
  /** How the market reaches `active` (§2.4). Path B carries a live seed. */
  activationPath: 'organic' | 'seeded';
  /** When the funding window closes — Path B's participation floor deadline. */
  fundingClosesAt: string | null;
  eventDate: string;
  voidDate: string;
  pot: string;
  /** Liquidity constant L. The Trade Ticket prices its preview with it. */
  liquidity: string;
  feeBps: number;
  criteria: unknown;
  resolvedOutcomeId: string | null;
  outcomes: OutcomeView[];
  sparkline?: string[];
}

export interface Annotation {
  id: string;
  type: 'open' | 'activation' | 'big_trade' | 'news' | 'freeze' | 'resolution';
  label: string;
  ts: string;
}

export interface MarketDetail extends MarketSummary {
  livePrices: Record<string, string> | null;
  annotations: Annotation[];
  traderCount: number;
  volume24h: string;
  /** Whose market this is (§2.14c). Null on the official shelf. */
  creator: CreatorByline | null;
  /** What the winners split. Null while the market is still open. */
  distributed: string | null;
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
  /** Omit `outcomeId` to get every outcome's series — the multi-line overlay. */
  history: (id: string, outcomeId: string | undefined, tf: string) =>
    get<PricePoint[]>(
      `/markets/${id}/history?tf=${tf}${outcomeId === undefined ? '' : `&outcomeId=${outcomeId}`}`,
    ),
};

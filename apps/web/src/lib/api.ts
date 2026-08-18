/** Shapes the API returns. Money and prices cross the wire as strings, never floats. */

export interface OutcomeView {
  id: string;
  label: string;
  ordinal: number;
  price: string;
  staked: string;
  /** Shares outstanding — the denominator in the §2.3 payout estimate. */
  shares: string;
}

export interface MarketSummary {
  id: string;
  shelf: 'official' | 'community';
  question: string;
  sourceName: string;
  sourceUrl: string;
  state: string;
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
  history: (id: string, outcomeId: string, tf: string) =>
    get<PricePoint[]>(`/markets/${id}/history?outcomeId=${outcomeId}&tf=${tf}`),
};

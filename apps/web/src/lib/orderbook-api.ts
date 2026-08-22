import { API_URL, type OpenOrder, type TradeQuote } from './api';

/**
 * The order book's write and authenticated reads.
 *
 * Split from `api.ts` for the same reason `creator-api.ts` is: that module is
 * the public, cacheable market surface, and these need a token.
 */

/** What a trade would do, split into its legs, before it is placed. */
export async function quoteTrade(input: {
  marketId: string;
  outcomeId: string;
  amount: string;
  limitKobo?: number | null;
}): Promise<TradeQuote | null> {
  const response = await fetch(`${API_URL}/markets/${input.marketId}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      outcomeId: input.outcomeId,
      amount: input.amount,
      ...(input.limitKobo == null ? {} : { limitKobo: input.limitKobo }),
    }),
  }).catch(() => null);

  if (response === null || !response.ok) return null;
  return (await response.json().catch(() => null)) as TradeQuote | null;
}

export async function myOrders(token: string, marketId?: string): Promise<OpenOrder[]> {
  const query = marketId === undefined ? '' : `?marketId=${encodeURIComponent(marketId)}`;
  const response = await fetch(`${API_URL}/markets/orders/mine${query}`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (response === null || !response.ok) return [];
  return ((await response.json().catch(() => [])) as OpenOrder[]) ?? [];
}

export async function cancelOrder(token: string, orderId: string): Promise<void> {
  const response = await fetch(`${API_URL}/markets/orders/${orderId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? 'That order could not be cancelled.');
  }
}

/** A holding matched against another trader, rather than against the pot. */
export interface MatchedHolding {
  id: string;
  marketId: string;
  question: string;
  marketState: string;
  outcomeId: string;
  /** What the holder actually backed, with the short side read back as a long. */
  label: string;
  side: 'long' | 'short';
  shares: string;
  staked: string;
  /** ₦1 a share if this is right. Exact, and known already. */
  exactPayout: string;
  settled: boolean;
  won: boolean | null;
}

export async function matchedHoldings(token: string, marketId?: string): Promise<MatchedHolding[]> {
  const query = marketId === undefined ? '' : `?marketId=${encodeURIComponent(marketId)}`;
  const response = await fetch(`${API_URL}/markets/orders/matched${query}`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (response === null || !response.ok) return [];
  return ((await response.json().catch(() => [])) as MatchedHolding[]) ?? [];
}

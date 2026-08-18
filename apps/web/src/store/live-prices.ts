'use client';

import { create } from 'zustand';

export interface LiveMarket {
  /** Outcome id → price. */
  prices: Record<string, string>;
  pot: string;
  at: number;
}

interface LivePriceState {
  markets: Record<string, LiveMarket>;
  apply: (marketId: string, update: LiveMarket) => void;
  seed: (marketId: string, update: LiveMarket) => void;
}

/**
 * Live prices, keyed by market.
 *
 * Ticks arrive already coalesced on a 250ms window from the gateway, so this
 * store never has to throttle — it just holds the newest truth and lets the
 * components animate toward it.
 */
export const useLivePrices = create<LivePriceState>((set) => ({
  markets: {},
  apply: (marketId, update) =>
    set((state) => {
      const current = state.markets[marketId];
      // Ticks can arrive out of order across a reconnect; the older one is stale.
      if (current !== undefined && current.at > update.at) return state;
      return { markets: { ...state.markets, [marketId]: update } };
    }),
  seed: (marketId, update) =>
    set((state) =>
      state.markets[marketId] === undefined
        ? { markets: { ...state.markets, [marketId]: update } }
        : state,
    ),
}));

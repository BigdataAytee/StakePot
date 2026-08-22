'use client';

import { create } from 'zustand';

import type { TradeMarket } from '@/components/trade-sheet';
import type { OutcomeView } from '@/lib/api';

interface TradeIntentState {
  market: TradeMarket | null;
  outcome: OutcomeView | null;
  side: 'buy' | 'sell';
  /** Shares held, when selling. Explicitly nullable rather than optional:
   *  `exactOptionalPropertyTypes` treats a missing key and an undefined one as
   *  different things, and a store that clears a field has to write one. */
  held: string | undefined;
  open: (market: TradeMarket, outcome: OutcomeView, side?: 'buy' | 'sell', held?: string) => void;
  close: () => void;
}

/**
 * The trade the reader has asked for but not yet placed.
 *
 * It lives in a store rather than in the grid's state because the thing that
 * asks (a button inside one card, among forty) and the thing that answers (one
 * sheet, mounted once at the page root) are nowhere near each other in the
 * tree. Threading a callback down would mean making the whole grid a client
 * component; this way only the button is.
 */
export const useTradeIntent = create<TradeIntentState>((set) => ({
  market: null,
  outcome: null,
  side: 'buy',
  held: undefined,
  open: (market, outcome, side = 'buy', held) => set({ market, outcome, side, held }),
  close: () => set({ market: null, outcome: null, held: undefined }),
}));

'use client';

import { create } from 'zustand';

const KEY = 'stakeam.live';

/**
 * Whether this tab is listening to the price stream.
 *
 * The header's switch is the only thing that sets it, and everything that
 * subscribes reads it — so one control governs every socket the page holds
 * rather than each screen deciding for itself.
 *
 * On by default. Live prices are the product, not a mode of it; the switch
 * exists because a person on metered data, or one reading a market rather
 * than trading it, is owed a way to make the numbers hold still.
 */
interface LiveModeState {
  live: boolean;
  /** Hydrated from storage on mount — see `useLiveModeHydration`. */
  ready: boolean;
  set: (live: boolean) => void;
  hydrate: () => void;
}

export const useLiveMode = create<LiveModeState>((set) => ({
  live: true,
  ready: false,
  set: (live) => {
    try {
      window.localStorage.setItem(KEY, live ? 'on' : 'off');
    } catch {
      // A browser refusing storage is not a reason to refuse the toggle; the
      // choice simply lasts as long as the tab does.
    }
    set({ live });
  },
  hydrate: () => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(KEY);
    } catch {
      stored = null;
    }
    // Read after mount rather than in the initial state, because the server
    // rendered this page with the default and a different first client value
    // is a hydration mismatch.
    set({ live: stored === null ? true : stored === 'on', ready: true });
  },
}));

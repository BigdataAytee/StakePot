'use client';

import { useMarketFeeds } from '@/hooks/use-market-feed';
import { useLiveMode } from '@/store/live-mode';

/**
 * Subscribes the page to the prices of the markets on it.
 *
 * Renders nothing — it exists so that a server-rendered grid can still be
 * live. The cards themselves stay server components and read their prices out
 * of the store; this is the one client piece that fills the store, and it is
 * governed by the header's switch.
 */
export function LiveFeed({ marketIds }: { marketIds: string[] }) {
  const live = useLiveMode((state) => state.live);
  useMarketFeeds(marketIds, live);
  return null;
}

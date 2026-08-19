'use client';

import { useSearchParams } from 'next/navigation';

import { useWatchlist } from '@/lib/watchlist';

/**
 * Hides a card that is not on the watchlist, while the watchlist tab is open.
 *
 * The starred set lives in this browser, so the server cannot filter by it —
 * it does not know what you starred. Rather than move the whole grid into the
 * client to get one filter, each card is wrapped in this: the markup is still
 * server-rendered, and the only thing the browser decides is whether to show
 * it.
 */
export function WatchGate({ marketId, children }: { marketId: string; children: React.ReactNode }) {
  const params = useSearchParams();
  const { has, ready } = useWatchlist();

  if (params.get('cat') !== 'watch') return <>{children}</>;
  // Render nothing until the stored list has been read, so the grid does not
  // flash every market before hiding most of them.
  if (!ready || !has(marketId)) return null;
  return <>{children}</>;
}

/** The line that explains an empty watchlist, only on the watchlist tab. */
export function WatchlistEmpty() {
  const params = useSearchParams();
  const { ids, ready } = useWatchlist();

  if (params.get('cat') !== 'watch' || !ready || ids.size > 0) return null;

  return (
    <div className="py-16 text-center text-text-muted">
      <p className="font-semibold text-text">Nothing starred yet.</p>
      <p className="mt-1 text-base">Tap the star on any market and it will wait for you here.</p>
    </div>
  );
}

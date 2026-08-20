'use client';

import type { MarketDetail, OutcomeView } from '@/lib/api';
import { kobo } from '@/lib/format';
import { binaryPair } from '@/lib/home';

/**
 * The detail page's primary action, on a phone.
 *
 * On a laptop the trade panel sits in the right column where it is always in
 * view. There is no right column on a phone, and putting the panel at the
 * bottom of the page would bury the one thing the page exists for under a
 * chart, an outcome list, the rules and a comment thread.
 *
 * So the phone gets this instead: the prices, pinned, opening the same bottom
 * sheet the grid uses. A detail page replaces the tab bar with its own action
 * rather than stacking two fixed bars — which is why this page does not render
 * the primary nav.
 *
 * The chosen outcome goes back to the page rather than into the shared
 * `trade-intent` store. The store exists for the grid, where the sheet is
 * mounted once beside forty cards that cannot each own one; the detail page
 * already renders its own sheet from its own state. Writing to the store here
 * set an intent nothing on this page was reading — the bar was the only way to
 * trade on a phone, and tapping it did nothing at all, silently, because a
 * button that opens no sheet still looks like a button.
 */
export function MobileBuyBar({
  market,
  livePrices,
  onBuy,
  frozen = false,
  frozenMessage,
}: {
  market: MarketDetail;
  livePrices: Record<string, string>;
  onBuy: (outcome: OutcomeView) => void;
  /** Past its freeze time, whatever the state column has caught up to. */
  frozen?: boolean;
  frozenMessage?: string;
}) {
  // Order matters. The frozen branch has to run *before* the state gate,
  // because a frozen market fails `state === 'active'` — checking the state
  // first made the bar disappear at exactly the moment it had something to say,
  // which on a phone is the only way to trade and reads as the app breaking.
  if (frozen && market.state !== 'resolved' && market.state !== 'voided') {
    return (
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3 text-center min-[860px]:hidden">
        <p className="text-sm font-semibold">{frozenMessage ?? 'Trading closed'}</p>
        <p className="mt-0.5 text-xs text-text-muted">
          Your position stays visible and settles when the result is in.
        </p>
      </div>
    );
  }

  if (market.state !== 'active') return null;

  const binary = binaryPair(market);
  // A candidate market has no "No" side (§2.3), so it offers the leader.
  const sides =
    binary ??
    [...market.outcomes]
      .sort((left, right) => Number.parseFloat(right.price) - Number.parseFloat(left.price))
      .slice(0, 1);

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface px-4 pb-[calc(12px+env(safe-area-inset-bottom))] pt-3 min-[860px]:hidden">
      <div className="mx-auto flex max-w-lg gap-2">
        {sides.map((outcome, index) => {
          const no = binary !== null && index === 1;
          return (
            <button
              key={outcome.id}
              type="button"
              onClick={() => onBuy(outcome)}
              aria-label={`Buy ${outcome.label} at ${kobo(livePrices[outcome.id] ?? outcome.price)}`}
              className={`flex-1 rounded-lg py-3 text-md font-bold text-paper transition-transform active:scale-press ${
                no ? 'bg-fall' : 'bg-rise'
              }`}
            >
              Buy {outcome.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

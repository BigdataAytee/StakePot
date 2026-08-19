'use client';

import type { MarketDetail } from '@/lib/api';
import { kobo } from '@/lib/format';
import { binaryPair } from '@/lib/home';
import { useTradeIntent } from '@/store/trade-intent';

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
 */
export function MobileBuyBar({
  market,
  livePrices,
}: {
  market: MarketDetail;
  livePrices: Record<string, string>;
}) {
  const open = useTradeIntent((state) => state.open);

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
              onClick={() => open(market, outcome)}
              className={`flex-1 rounded-lg py-3 text-md font-bold text-paper transition-transform active:scale-press ${
                no ? 'bg-fall' : 'bg-rise'
              }`}
            >
              Buy {outcome.label} {kobo(livePrices[outcome.id] ?? outcome.price)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

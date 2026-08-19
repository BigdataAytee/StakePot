'use client';

import { useEffect, useRef, useState } from 'react';

import { percent } from '@/lib/format';
import { useLivePrices } from '@/store/live-prices';

/**
 * A percentage that shows which way it just moved.
 *
 * The number itself is only half of what a reader wants from a live price —
 * the other half is the direction, and on a grid of forty cards nobody is
 * watching closely enough to catch a digit changing. So a tick tints the
 * figure for a beat: green if it went up, red if it went down, back to normal
 * after.
 *
 * The tint is cleared on a timer rather than by the next tick, because a
 * market that moves once and then sits still would otherwise stay green until
 * something else happened to it — which would read as a standing claim about
 * the market rather than as a report of one change.
 */
export function LivePercent({
  marketId,
  outcomeId,
  fallback,
  className = '',
}: {
  marketId: string;
  outcomeId: string;
  /** The price the server rendered, used until a tick arrives. */
  fallback: string;
  className?: string;
}) {
  const live = useLivePrices((state) => state.markets[marketId]?.prices[outcomeId]);
  const price = live ?? fallback;
  const value = Math.round(percent(price));

  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  const previous = useRef<number | null>(null);

  useEffect(() => {
    const last = previous.current;
    previous.current = value;
    // The first render is not a move — there is nothing to have moved from.
    if (last === null || last === value) return undefined;

    setDirection(value > last ? 'up' : 'down');
    const clear = setTimeout(() => setDirection(null), 600);
    return () => clearTimeout(clear);
  }, [value]);

  return (
    <span
      className={`transition-colors duration-tick ${
        direction === 'up' ? 'text-rise' : direction === 'down' ? 'text-fall' : ''
      } ${className}`}
    >
      {value}%
    </span>
  );
}

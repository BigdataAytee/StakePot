'use client';

import { LivingNumber } from '@/components/living-number';
import { percent } from '@/lib/format';
import { useLivePrices } from '@/store/live-prices';
import { ChanceGauge } from './chance-gauge';

/**
 * A market's live percentage, wherever one appears on a card or a list.
 *
 * This does one job: resolve an outcome's current price out of the live-price
 * store, falling back to whatever the server rendered. The *appearance* of a
 * changing number — counting between values rather than snapping, and the
 * brief green/red tint — belongs to §7.4's living number, so it delegates
 * there rather than reimplementing it.
 *
 * It used to reimplement it, badly: it carried its own tint and then printed
 * the new figure directly, so every price on the grid snapped. §7.4 is
 * explicit that a price "animates by counting between values (never
 * snapping)", and having two implementations of that is how one of them ends
 * up not doing it.
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
  const value = Math.round(percent(live ?? fallback));

  return <LivingNumber value={value} suffix="%" className={className} />;
}

/**
 * The same live figure, drawn as §7.2's dial instead of as digits.
 *
 * Split from `LivePercent` rather than bolted onto it with a `variant` prop:
 * the two are read in different places for different reasons — a multi-outcome
 * row wants a number it can align in a column, a binary card wants a shape — and
 * a component that renders either depending on a flag is two components sharing
 * a name.
 */
export function LiveChanceGauge({
  marketId,
  outcomeId,
  fallback,
  size,
  label,
  className,
}: {
  marketId: string;
  outcomeId: string;
  fallback: string;
  size?: number;
  label?: string;
  className?: string;
}) {
  const live = useLivePrices((state) => state.markets[marketId]?.prices[outcomeId]);

  return (
    <ChanceGauge
      value={percent(live ?? fallback)}
      {...(size === undefined ? {} : { size })}
      {...(label === undefined ? {} : { label })}
      {...(className === undefined ? {} : { className })}
    />
  );
}

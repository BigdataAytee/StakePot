'use client';

import { LivingNumber } from '@/components/living-number';

/**
 * A market's headline probability, as a speedometer.
 *
 * A number on its own is read; an arc is *seen*. On a grid of cards where every
 * question is competing for the same glance, the difference between 8% and 80%
 * should register before the digits do — which is the whole argument for the
 * shape, and why the fill is proportional rather than decorative.
 *
 * 240° of sweep, open at the bottom, drawn as a single stroked path revealed by
 * `stroke-dashoffset`. One path rather than two arcs recomputed per render: the
 * geometry never changes, only how much of it is showing, so the browser gets
 * to animate a single number and the value can move every 250ms without
 * rebuilding a `d` attribute each tick.
 *
 * The digits are HTML rather than `<text>` on purpose — SVG text does not hint
 * the way the rest of the page's type does, and at 56px that is the difference
 * between a crisp number and a blurry one. It also lets the figure reuse §7.4's
 * living number, so it counts between values and tints on change exactly like
 * every other price on the site instead of being a second implementation.
 */
export function ChanceGauge({
  value,
  size = 60,
  label = 'chance',
  greenAt = 50,
  className = '',
}: {
  /** 0–100. */
  value: number;
  /** Width in px. The shape is 3:4, so the height follows from it. */
  size?: number;
  /** The word under the number. Empty string hides it. */
  label?: string;
  /** At or above this, the arc is green; below it, red. */
  greenAt?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const offset = ARC_LENGTH * (1 - clamped / 100);
  const good = clamped >= greenAt;

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: size, height: size * 0.8 }}
      role="img"
      aria-label={`${Math.round(clamped)}% ${label === '' ? 'chance' : label}`}
    >
      <svg viewBox="0 0 100 80" className="absolute inset-0 size-full overflow-visible" aria-hidden>
        <path
          d={ARC}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          className="stroke-border"
        />
        <path
          d={ARC}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={ARC_LENGTH}
          strokeDashoffset={offset}
          className={`motion-safe:transition-[stroke-dashoffset] motion-safe:duration-500 motion-safe:ease-out ${
            good ? 'stroke-rise' : 'stroke-fall'
          }`}
        />
      </svg>

      {/*
        Centred on the dial's interior, not on the box.

        The shape is open at the bottom, so the box's own middle is not the
        middle of the bowl — anchoring there put the digits across the stroke on
        one side and left a gap on the other. 56% down, pulled back by half its
        own height, lands the block between the arc's crown and its two feet at
        every size, which is the only placement that survives being asked for at
        58px on a card and 90px on the ticket.
      */}
      <div
        className="absolute inset-x-0 flex flex-col items-center leading-none"
        style={{ top: '56%', transform: 'translateY(-50%)' }}
      >
        <LivingNumber
          value={Math.round(clamped)}
          suffix="%"
          className="font-bold"
          // Scaled off the dial rather than a Tailwind step: one class cannot
          // be right at both sizes, and the digits have to clear the stroke.
          style={{ fontSize: Math.round(size * 0.24) }}
        />
        {label !== '' && (
          <span
            className="mt-[0.2em] max-w-full truncate px-0.5 font-semibold tracking-[.02em] text-text-muted"
            style={{ fontSize: Math.max(8, Math.round(size * 0.115)) }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The dial: radius 42 about (50, 50), swept 240° clockwise from −120° to +120°,
 * where the angle is measured from twelve o'clock.
 *
 *   x = 50 + 42·sin θ      y = 50 − 42·cos θ
 *
 * The large-arc flag is 1 because 240° is the long way round, and the sweep
 * flag is 1 because the fill has to grow clockwise — swap either and the gauge
 * quietly reads backwards.
 */
const ARC = 'M 13.63 71 A 42 42 0 1 1 86.37 71';
const STROKE = 8;
/** 2πr · (240/360), the length `stroke-dasharray` is measured against. */
const ARC_LENGTH = 2 * Math.PI * 42 * (240 / 360);

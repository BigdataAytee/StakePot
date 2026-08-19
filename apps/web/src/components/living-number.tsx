'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * §7.4's second signature element: the living number.
 *
 * "Every price/percentage animates by counting between values (never
 * snapping), flashes a brief green/red tint on change, and ticks in real time
 * from the WebSocket feed."
 *
 * The count-up runs on requestAnimationFrame over the 250ms `priceTick` window
 * — the same window the gateway coalesces on, so a tick is drawn once, fully.
 * Under `prefers-reduced-motion` the value simply changes: the information is
 * identical, only the theatre is dropped.
 */
export function LivingNumber({
  value,
  decimals = 0,
  suffix = '',
  className = '',
  style,
  durationMs = 250,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  className?: string;
  /** For sizes a utility class cannot express — see the chance gauge. */
  style?: React.CSSProperties;
  durationMs?: number;
}) {
  const [shown, setShown] = useState(value);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  const previous = useRef(value);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value) return;

    setDirection(value > from ? 'up' : 'down');

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      setShown(value);
    } else {
      const start = performance.now();
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / durationMs);
        // Ease-out: the number arrives decisively rather than drifting in.
        setShown(from + (value - from) * (1 - Math.pow(1 - t, 3)));
        if (t < 1) frame.current = requestAnimationFrame(step);
      };
      frame.current = requestAnimationFrame(step);
    }

    const clearTint = setTimeout(() => setDirection(null), durationMs * 2);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      clearTimeout(clearTint);
    };
  }, [value, durationMs]);

  const tint = direction === 'up' ? 'text-rise' : direction === 'down' ? 'text-fall' : '';

  return (
    <span
      className={`font-mono tabular-nums transition-colors duration-tick ${tint} ${className}`}
      style={style}
      aria-live="off"
    >
      {shown.toFixed(decimals)}
      {suffix}
    </span>
  );
}

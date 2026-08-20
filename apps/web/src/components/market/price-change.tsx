/**
 * A move over a window, in the register a quote page uses.
 *
 * Two decisions worth stating, because both are the kind that get "corrected"
 * later by somebody reading the component in isolation:
 *
 * **It is a percentage of the price, not a difference in probability points.**
 * 50% → 52% shows as +4.0%, because that is what the position gained and what
 * every other price screen a reader has ever seen means by a change. Reported
 * as "+2%" — the points difference — the same move reads a twentieth the size.
 *
 * **Null is not zero.** A market younger than the window has no change to
 * report, and rendering "0.0%" for it claims the price has been flat since it
 * opened. Nothing is drawn instead.
 */
export function PriceChange({
  change,
  className = '',
}: {
  /** Fractional move, e.g. 0.032 for +3.2%. Null when there is no window. */
  change: number | null;
  className?: string;
}) {
  if (change === null) return null;

  const pct = change * 100;
  // Below a tenth of a percent the arrow implies a direction the number cannot
  // support, so it reads flat rather than picking one.
  const flat = Math.abs(pct) < 0.05;
  const up = pct > 0;

  return (
    <span
      className={`inline-flex items-center gap-0.5 whitespace-nowrap font-mono text-xs font-bold tabular-nums ${
        flat ? 'text-text-muted' : up ? 'text-rise' : 'text-fall'
      } ${className}`}
      title="Change over the last 24 hours"
    >
      {!flat && <span aria-hidden>{up ? '▲' : '▼'}</span>}
      {flat ? '0.0%' : `${up ? '+' : '−'}${Math.abs(pct).toFixed(1)}%`}
    </span>
  );
}

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
  /**
   * Fractional move, e.g. 0.032 for +3.2%. Null — or absent — when there is no
   * window to measure over.
   */
  change: number | null | undefined;
  className?: string;
}) {
  // `== null` rather than `=== null`, and deliberately. The first version took
  // `number | null` and was handed an `undefined` by a caller whose endpoint
  // did not return the field yet; it sailed past the strict check and rendered
  // "▼ −NaN%" on the ticket. A component whose entire job is to be honest about
  // an unknown should treat both spellings of unknown the same way.
  if (change == null) return null;

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

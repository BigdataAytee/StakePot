/**
 * A placeholder shaped like the thing that is coming.
 *
 * The word "Loading…" tells a reader that something is happening and nothing
 * about what. A block the size and position of the row that will replace it
 * does the opposite: the layout is already correct, so nothing jumps when the
 * data lands, and the reader can see how much is on its way before it arrives.
 *
 * Kept deliberately plain — a single soft pulse, no shimmer sweep. A shimmer is
 * a small animation running on every screen in the product at once, and it is
 * the kind of motion that reads as decoration rather than as information.
 * `prefers-reduced-motion` stops it entirely, which the token preset handles
 * globally.
 */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-sm bg-chip ${className}`} />;
}

/**
 * A screenful of skeleton rows, for a list whose shape is known but whose
 * length is not.
 *
 * `label` is what a screen reader is told, because a pile of decorative blocks
 * should announce itself as one thing that is loading rather than as nothing at
 * all. Sighted readers get the shape; everyone else gets the sentence.
 */
export function SkeletonRows({
  rows = 3,
  height = 'h-16',
  label = 'Loading',
}: {
  rows?: number;
  height?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={`${height} w-full rounded-lg`} />
      ))}
    </div>
  );
}

/** A figure and its label, for the tiles at the top of a money screen. */
export function SkeletonStat() {
  return (
    <div className="rounded-lg border border-border bg-surface-raised p-2.5">
      <Skeleton className="h-6 w-24" />
      <Skeleton className="mt-2 h-3 w-16" />
    </div>
  );
}

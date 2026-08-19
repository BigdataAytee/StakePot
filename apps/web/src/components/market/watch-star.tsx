'use client';

import { useWatchlist } from '@/lib/watchlist';

/**
 * The star in a card's footer.
 *
 * It sits inside a card that is itself a link, so it stops the click from
 * reaching that link — starring a market is not the same gesture as opening
 * it, and a star that navigated would be unusable.
 *
 * Nothing renders as starred until the stored list has been read, so the
 * server's markup and the first client paint agree and no star flickers on
 * after hydration.
 */
export function WatchStar({
  marketId,
  question,
  size = 26,
}: {
  marketId: string;
  question: string;
  size?: number;
}) {
  const { has, toggle, ready } = useWatchlist();
  const on = ready && has(marketId);

  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${on ? 'Remove' : 'Add'} ${question} ${on ? 'from' : 'to'} your watchlist`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle(marketId);
      }}
      style={{ width: size, height: size }}
      className="relative z-10 flex shrink-0 items-center justify-center rounded-sm hover:bg-chip"
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        style={{ width: size * 0.58, height: size * 0.58 }}
        strokeWidth="1.7"
        className={on ? 'fill-star stroke-star' : 'fill-none stroke-text-muted'}
      >
        <path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.4l6.1-.8z" />
      </svg>
    </button>
  );
}

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
      /*
       * The mark stays the reference's 26px; the *target* is 44. A star this
       * size is comfortable to look at and a coin-toss to hit with a thumb,
       * and the two are not the same measurement — so the hit area is extended
       * past the visual with a pseudo-element rather than by inflating the
       * icon. `z-10` keeps it above the card's stretched link, which would
       * otherwise swallow the tap and navigate instead of starring.
       */
      className="relative z-10 flex shrink-0 items-center justify-center rounded-sm before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-[''] hover:bg-chip"
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

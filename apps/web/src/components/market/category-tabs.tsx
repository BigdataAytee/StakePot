'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

/**
 * The row of categories under the header.
 *
 * Trending leads and wears the live dot, because it is the default view and
 * the dot is the page saying the prices on it are moving. The watchlist sits
 * at the end, where a personal thing belongs among general ones.
 *
 * It scrolls sideways rather than wrapping: a second row of tabs would push
 * the markets themselves off a phone screen, which is the one thing this page
 * cannot afford.
 */
export function CategoryTabs({
  categories,
  watchCount,
}: {
  categories: { key: string; label: string; count: number }[];
  watchCount: number;
}) {
  const params = useSearchParams();
  const active = params.get('cat') ?? 'all';

  function href(key: string): string {
    const next = new URLSearchParams(params.toString());
    if (key === 'all') next.delete('cat');
    else next.set('cat', key);
    return next.toString() === '' ? '/' : `/?${next.toString()}`;
  }

  const items = [
    { key: 'all', label: 'Trending', count: 0 },
    ...categories,
    { key: 'watch', label: '★ Watchlist', count: watchCount },
  ];

  return (
    <nav aria-label="Categories" className="border-b border-border bg-surface">
      <div className="mx-auto max-w-[1200px] px-5">
        <div className="flex gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((item) => {
            const on = item.key === active;
            return (
              <Link
                key={item.key}
                href={href(item.key)}
                aria-current={on ? 'page' : undefined}
                className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-[13px] py-[11px] text-[13.5px] transition-colors ${
                  on
                    ? 'border-brand font-semibold text-text'
                    : 'border-transparent font-medium text-text-muted hover:text-text'
                }`}
              >
                {item.key === 'all' && (
                  <span
                    className="size-1.5 shrink-0 animate-pulse rounded-full bg-fall"
                    aria-hidden
                  />
                )}
                {item.label}
                {item.count > 0 && (
                  <span className="font-mono text-xs font-medium opacity-70">{item.count}</span>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}

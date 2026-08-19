'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import { SORTS } from '@/lib/home';

const SHELVES = [
  { key: 'all', label: 'All' },
  { key: 'official', label: 'Official' },
  { key: 'community', label: 'Community' },
] as const;

/**
 * How many markets are showing, and in what order.
 *
 * Both shelves live here as pills rather than as another tab row: the shelf is
 * a different question from the topic (who stands behind this market, not what
 * it is about), and stacking two full-width tab rows would cost a phone its
 * first card.
 *
 * Every control is a link with its state in the query string, so a sorted,
 * filtered view is a thing somebody can send to a friend and the back button
 * does what the back button is for.
 */
export function ShelfToolbar({ shown, total }: { shown: number; total: number }) {
  const params = useSearchParams();
  const sort = params.get('sort') ?? SORTS[0].key;
  const shelf = params.get('shelf') ?? 'all';

  function href(key: 'sort' | 'shelf', value: string): string {
    const next = new URLSearchParams(params.toString());
    if (value === (key === 'sort' ? SORTS[0].key : 'all')) next.delete(key);
    else next.set(key, value);
    return next.toString() === '' ? '/' : `/?${next.toString()}`;
  }

  return (
    <div className="flex items-center gap-2.5 pb-1 pt-3.5">
      {/* The count is the first thing to go on a narrow screen: seven pills and
          a sentence do not fit on 390px, and the pills are the controls. */}
      <span className="hidden shrink-0 text-sm text-text-muted sm:block">
        {shown === total ? shown : `${shown} of ${total}`} market{total === 1 ? '' : 's'}
      </span>

      {/* One scrolling row on a phone rather than two wrapped ones, so the
          grid still starts above the fold. */}
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [-ms-overflow-style:none] [scrollbar-width:none] sm:mx-0 sm:ml-auto sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
        <span className="contents" role="group" aria-label="Shelf">
          {SHELVES.map((option) => (
            <Pill key={option.key} href={href('shelf', option.key)} on={option.key === shelf}>
              {option.label}
            </Pill>
          ))}
        </span>

        <span className="mx-0.5 w-px shrink-0 self-stretch bg-border" aria-hidden />

        <span className="contents" role="group" aria-label="Sort by">
          {SORTS.map((option) => (
            <Pill key={option.key} href={href('sort', option.key)} on={option.key === sort}>
              {option.label}
            </Pill>
          ))}
        </span>
      </div>
    </div>
  );
}

function Pill({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? 'true' : undefined}
      className={`whitespace-nowrap rounded-[20px] px-[11px] py-1.5 text-sm font-medium transition-colors ${
        on ? 'bg-text text-paper' : 'bg-chip text-text-muted hover:text-text'
      }`}
    >
      {children}
    </Link>
  );
}

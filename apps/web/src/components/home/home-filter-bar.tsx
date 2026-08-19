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
 * How the grid below is ordered and what is in it.
 *
 * Every control is a link with the state in the query string rather than a
 * dropdown holding it in memory: a sorted, filtered view of the front page is
 * then a thing somebody can send to a friend, and the back button does what
 * the back button is for. It also means the grid stays a server component —
 * the ordering happens where the markets are, not in the browser.
 */
export function HomeFilterBar({ shown, total }: { shown: number; total: number }) {
  const params = useSearchParams();
  const sort = params.get('sort') ?? 'volume';
  const shelf = params.get('shelf') ?? 'all';

  function href(key: 'sort' | 'shelf', value: string): string {
    const next = new URLSearchParams(params.toString());
    if (value === (key === 'sort' ? 'volume' : 'all')) next.delete(key);
    else next.set(key, value);
    return next.toString() === '' ? '/' : `/?${next.toString()}`;
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <p className="text-xs text-text-muted">
        <span className="font-mono tabular-nums">{shown}</span>
        {shown === total ? '' : ` of ${total}`} {total === 1 ? 'market' : 'markets'}
      </p>

      <div className="ml-auto flex items-center gap-1" role="group" aria-label="Shelf">
        {SHELVES.map((option) => (
          <Chip key={option.key} href={href('shelf', option.key)} on={option.key === shelf}>
            {option.label}
          </Chip>
        ))}
      </div>

      <div className="flex items-center gap-1" role="group" aria-label="Sort by">
        <span className="pl-1 text-xs text-text-muted">Sort</span>
        {SORTS.map((option) => (
          <Chip key={option.key} href={href('sort', option.key)} on={option.key === sort}>
            {option.label}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={on ? 'true' : undefined}
      className={`flex h-8 items-center rounded-sm px-2.5 text-xs font-bold transition-colors ${
        on ? 'bg-rise/15 text-rise' : 'text-text-muted hover:bg-text/5 hover:text-text'
      }`}
    >
      {children}
    </Link>
  );
}

'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The row of topics under the search bar.
 *
 * It scrolls horizontally because there will eventually be more topics than
 * fit, and a row that silently clips is a row whose last four doors nobody
 * knows exist. Two things fix that: the edge fades, which say "there is more
 * this way" without a label, and the arrow, which gives a mouse a way to get
 * there — a trackpad can swipe, a mouse wheel cannot scroll sideways.
 *
 * Both are driven off the element's own scroll position rather than a media
 * query, so the affordance appears exactly when there is something to reach.
 */
export function TopicStrip({
  topics,
}: {
  topics: { key: string; label: string; count: number }[];
}) {
  const params = useSearchParams();
  const active = params.get('topic') ?? 'all';
  const rail = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const node = rail.current;
    if (node === null) return;
    setOverflow({
      left: node.scrollLeft > 4,
      right: node.scrollLeft + node.clientWidth < node.scrollWidth - 4,
    });
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure, topics]);

  function href(key: string): string {
    const next = new URLSearchParams(params.toString());
    if (key === 'all') next.delete('topic');
    else next.set('topic', key);
    return next.toString() === '' ? '/' : `/?${next.toString()}`;
  }

  const items = [{ key: 'all', label: 'Trending', count: 0 }, ...topics];

  return (
    <div className="relative border-b border-border">
      <div className="mx-auto max-w-[1350px] px-4">
        <div
          ref={rail}
          onScroll={measure}
          className="flex h-12 items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {items.map((item) => {
            const selected = item.key === active;
            return (
              <Link
                key={item.key}
                href={href(item.key)}
                aria-current={selected ? 'page' : undefined}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-sm px-3 text-sm font-bold transition-colors ${
                  selected
                    ? 'bg-rise/15 text-rise'
                    : 'text-text-muted hover:bg-text/5 hover:text-text'
                }`}
              >
                {item.key === 'all' && <TrendIcon className="size-3.5" />}
                {item.label}
                {item.count > 0 && (
                  <span className="font-mono text-xs font-medium opacity-70">{item.count}</span>
                )}
              </Link>
            );
          })}
        </div>
      </div>

      {overflow.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-surface to-transparent"
        />
      )}
      {overflow.right && (
        <>
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-surface to-transparent"
          />
          <button
            type="button"
            aria-label="More topics"
            onClick={() => rail.current?.scrollBy({ left: 240, behavior: 'smooth' })}
            className="absolute right-1 top-1/2 hidden size-7 -translate-y-1/2 place-items-center rounded-full border border-border bg-surface-raised text-text-muted shadow-soft hover:text-text lg:grid"
          >
            <ChevronIcon className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

function TrendIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="M1.5 11.5 6 6.5l3 3 5.5-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10.5 3.5H14.5V7.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={className}>
      <path
        d="m6 3 5 5-5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

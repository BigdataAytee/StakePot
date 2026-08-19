'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The bar along the bottom of a phone.
 *
 * The reference has no mobile design at all — it is a desktop layout with one
 * media query that hides two labels — so this is ours. It exists because
 * everything else on this site is reachable by scrolling, and these four are
 * the ones that must be reachable without it. Hidden from `md` up, where the
 * header already carries the same destinations and a second navigation would
 * only be a duplicate.
 *
 * `pb-[env(safe-area-inset-bottom)]` is not decoration: without it the labels
 * sit under the home indicator on every iPhone since the X.
 */
const ITEMS = [
  {
    href: '/',
    label: 'Markets',
    match: (p: string, c: string | null) => p === '/' && c !== 'watch',
  },
  {
    href: '/?cat=watch',
    label: 'Watchlist',
    match: (p: string, c: string | null) => p === '/' && c === 'watch',
  },
  { href: '/wallet', label: 'Wallet', match: (p: string) => p.startsWith('/wallet') },
  { href: '/leaderboard', label: 'Board', match: (p: string) => p.startsWith('/leaderboard') },
] as const;

export function MobileNav() {
  const pathname = usePathname();
  const cat = useSearchParams().get('cat');

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex h-[56px] max-w-lg items-stretch">
        {ITEMS.map((item) => {
          const on = item.match(pathname, cat);
          return (
            <li key={item.label} className="flex-1">
              <Link
                href={item.href}
                aria-current={on ? 'page' : undefined}
                className={`flex h-full flex-col items-center justify-center gap-1 ${
                  on ? 'text-brand' : 'text-text-muted'
                }`}
              >
                <Icon name={item.label} />
                <span className="text-[11px] font-semibold leading-none">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    Markets: <path d="M3 14.5 7.5 9l3 3L17 5M13 5h4v4" />,
    Watchlist: <path d="M10 3l2.2 4.6 5 .7-3.6 3.5.9 5L10 14.4 5.5 16.8l.9-5L2.8 8.3l5-.7z" />,
    Wallet: (
      <path d="M3 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM13.5 10.5H15" />
    ),
    Board: <path d="M4 16h3v-5H4zM8.5 16h3V5h-3zM13 16h3V8h-3z" />,
  };
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="size-5"
    >
      {paths[name]}
    </svg>
  );
}

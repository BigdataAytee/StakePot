import Link from 'next/link';

/**
 * The bar along the bottom of a phone.
 *
 * Everything else on this page is reachable by scrolling; these four are the
 * ones that must be reachable without it. It is hidden from `md` up, where the
 * top bar already carries the same destinations and a second navigation would
 * just be a duplicate.
 *
 * `pb-[env(safe-area-inset-bottom)]` is not decoration: without it the labels
 * sit under the home indicator on every iPhone since the X.
 */
export function MobileTabBar() {
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="mx-auto flex h-[60px] max-w-lg items-stretch">
        <Tab href="/" label="Home">
          <path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3v-4H7v4H4a1 1 0 0 1-1-1V9.5Z" />
        </Tab>
        <Tab href="/markets" label="Markets">
          <path d="M3 14.5 7.5 9l3 3L17 5" />
          <path d="M13 5h4v4" />
        </Tab>
        <Tab href="/leaderboard" label="Board">
          <path d="M4 16h3v-5H4v5Zm4.5 0h3V5h-3v11Zm4.5 0h3V8h-3v8Z" />
        </Tab>
        <Tab href="/wallet" label="Wallet">
          <path d="M3 7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
          <path d="M13.5 10.5h1.5" />
        </Tab>
      </ul>
    </nav>
  );
}

function Tab({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex-1">
      <Link
        href={href}
        className="flex h-full flex-col items-center justify-center gap-1 text-text-muted hover:text-text"
      >
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
          {children}
        </svg>
        <span className="text-[11px] font-bold leading-none">{label}</span>
      </Link>
    </li>
  );
}

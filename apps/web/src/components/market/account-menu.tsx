'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { clearToken, type Me } from '@/lib/session';

/**
 * Everything this app can do, from every screen.
 *
 * Most of the product was unreachable. The creator studio, the market wizard,
 * the account screen, verification, support and the entire fourteen-screen ops
 * console were all built, deployed and running — and nothing anywhere linked to
 * them, so from the outside they did not exist. Five destinations in the phone
 * bar and a footer of legal pages was the whole of the navigation.
 *
 * A menu rather than more tabs: the bar has room for five thumbs and the answer
 * to "I need six" is not a sixth tab at 60px wide. This is the overflow, and it
 * is in the header so it is the same control on a phone and a laptop.
 *
 * The ops console appears here only for staff. That is a courtesy, not a
 * control — every admin route is guarded server-side by the roles guard, and a
 * `user` who types `/admin` gets refused by the API, not by a hidden link. What
 * hiding it buys is that the other 99.9% of people are not offered a door they
 * cannot open.
 */
const STAFF: readonly string[] = [
  'admin',
  'support',
  'resolver',
  'trust_safety',
  'finance',
] as const;

interface Item {
  href: string;
  label: string;
  hint: string;
}

const PERSONAL: readonly Item[] = [
  { href: '/positions', label: 'Portfolio', hint: 'What you are holding, and what it is worth' },
  { href: '/wallet', label: 'Wallet', hint: 'Balance and history' },
  { href: '/account', label: 'Account', hint: 'Sessions, consents, referrals' },
  { href: '/account/limits', label: 'Limits', hint: 'Stake caps and cool-off' },
] as const;

const MAKE: readonly Item[] = [
  { href: '/create', label: 'Open a market', hint: 'Ask the question yourself' },
  { href: '/studio', label: 'Creator studio', hint: 'Your markets and your level' },
] as const;

const HELP: readonly Item[] = [
  { href: '/leaderboard', label: 'Leaderboard', hint: 'Who is actually right' },
  { href: '/support', label: 'Support', hint: 'Raise a ticket' },
  { href: '/rules', label: 'Rules', hint: 'How money moves' },
  { href: '/status', label: 'Status', hint: 'Is anything broken' },
] as const;

export function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Navigating is finishing with the menu. Without this it stays open over the
  // page it just took you to, which reads as a menu that failed to work.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (box.current !== null && !box.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const staff = STAFF.includes(me.role);
  const name = me.handle ?? me.displayName ?? me.email ?? me.phone ?? 'Your account';

  return (
    <div className="relative shrink-0" ref={box}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Your account and everything else"
        className="grid size-9 place-items-center rounded-md text-text-muted hover:bg-chip hover:text-text"
      >
        <svg viewBox="0 0 20 20" aria-hidden className="size-[18px]">
          <circle cx="10" cy="6.5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M3.8 17c.7-3.3 3.2-5 6.2-5s5.5 1.7 6.2 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          // `max-h` plus scroll rather than a taller panel: on a 390×670 phone
          // in landscape this list is longer than the viewport, and a menu whose
          // last item cannot be reached is worse than one that admits it scrolls.
          className="absolute right-0 top-11 z-50 max-h-[70vh] w-[248px] overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface py-1.5 shadow-lifted"
        >
          <p className="truncate px-3 py-1.5 text-xs font-semibold text-text-muted">{name}</p>

          <Group items={PERSONAL} />
          <Group items={MAKE} label="Create" />
          <Group items={HELP} label="Around here" />

          {staff && (
            <Group
              label="Staff"
              items={[
                {
                  href: '/admin',
                  label: 'Ops console',
                  hint: 'Money, queues, resolution, config',
                },
              ]}
            />
          )}

          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                clearToken();
                // A full load, not a router push: every store on the page is
                // holding data belonging to the session that just ended, and
                // the cheapest way to be certain none of it survives is not to
                // keep the page.
                window.location.href = '/';
              }}
              className="flex min-h-11 w-full items-center px-3 text-sm font-semibold text-fall hover:bg-chip"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({ items, label }: { items: readonly Item[]; label?: string }) {
  return (
    <div className="border-t border-border pt-1 first-of-type:border-t-0 first-of-type:pt-0">
      {label !== undefined && (
        <p className="px-3 pb-0.5 pt-1.5 font-mono text-[10px] uppercase tracking-widest text-text-muted">
          {label}
        </p>
      )}
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              role="menuitem"
              className="flex min-h-11 flex-col justify-center px-3 py-1.5 hover:bg-chip"
            >
              <span className="text-sm font-semibold leading-tight">{item.label}</span>
              <span className="text-xs leading-tight text-text-muted">{item.hint}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

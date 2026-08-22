'use client';

import {
  AlertTriangle,
  BarChart3,
  Flag,
  Gavel,
  LayoutDashboard,
  LifeBuoy,
  ShieldAlert,
  ShieldCheck,
  Menu,
  Sliders,
  Store,
  X,
  Sparkles,
  Server,
  Timer,
  Trophy,
  UserCog,
  Wallet,
  Droplets,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { CommandPalette } from '@/components/admin/command-palette';
import { admin, type DashboardView } from '@/lib/admin-api';

/**
 * The cockpit shell (§6.10).
 *
 * "Desktop-first... same tokens as §7.4 but in a denser, calmer register...
 * red strictly for alarms."
 *
 * §6.10 asks for an ink-green dark theme. The console is light, and the `dark`
 * class that used to be on this element had been doing nothing since the
 * design reference replaced the tokens: that reference is a light-only system,
 * so `semantic.dark` aliases `semantic.light` and the class resolved to the
 * same palette. A class implying a theme it does not apply is worse than no
 * class, so it is gone.
 *
 * Light is also the right answer under the standing rule that every screen
 * matches the reference — a dark console would be, precisely, a second visual
 * style. §6.10 in the architecture doc records the divergence. Reversing it
 * means putting real values back in `semantic.dark`, not restoring this class.
 *
 * What survives from §6.10 is the register rather than the palette: denser
 * type, tighter rows, `caution` for "needs attention", red strictly for
 * alarms.
 *
 * The status strip is the point of the layout: reconciliation, disputes and
 * pending approvals are visible from every screen, because those are the three
 * things that mean somebody has to do something now.
 */
const SCREENS = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/markets', label: 'Market Studio', icon: Store },
  { href: '/admin/drafts', label: 'Drafts', icon: Sparkles },
  { href: '/admin/moderation', label: 'Moderation', icon: ShieldAlert },
  { href: '/admin/prizes', label: 'Prizes', icon: Trophy },
  { href: '/admin/analytics', label: 'Analytics', icon: BarChart3 },
  { href: '/admin/resolution', label: 'Resolution', icon: Gavel },
  { href: '/admin/approvals', label: 'Approvals', icon: ShieldCheck },
  { href: '/admin/money', label: 'Money room', icon: Wallet },
  { href: '/admin/liquidity', label: 'Liquidity', icon: Droplets },
  { href: '/admin/support', label: 'Support desk', icon: LifeBuoy },
  { href: '/admin/lifecycle', label: 'Lifecycle', icon: Timer },
  { href: '/admin/creators', label: 'Creators desk', icon: UserCog },
  { href: '/admin/growth', label: 'Growth', icon: Flag },
  { href: '/admin/config', label: 'Platform config', icon: Sliders },
  { href: '/admin/system', label: 'System room', icon: Server },
] as const;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = (): void => {
      void admin
        .dashboard()
        .then((view) => {
          if (!cancelled) {
            setStatus(view);
            setError(null);
          }
        })
        .catch((caught: Error) => {
          if (!cancelled) setError(caught.message);
        });
    };
    load();
    // The strip is the alarm. It refreshes on its own so an operator who leaves
    // a screen open is not looking at a stale "all clear".
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pathname]);

  const reconciliationRed = status !== null && status.reconciliation.status !== 'clean';

  return (
    <div className="min-h-screen bg-surface text-text">
      {/* §6.10: ⌘K from anywhere. The console is fourteen screens deep. */}
      <CommandPalette />
      <div className="flex min-h-screen">
        {/*
          A drawer below 900px, a rail above it.
          
          It used to be a fixed 224px column at every width, which on a 393px
          phone left 170 pixels for the console itself — every market question
          wrapping to three words a line, and a health flag rendering as a
          vertical ribbon of single words. The whole admin surface is meant to
          be run from a phone; it was legible on exactly one of the two devices
          it is used from.
        */}
        <nav
          id="admin-nav"
          className={`${
            open
              ? 'fixed inset-y-0 left-0 z-40 w-64 overflow-y-auto bg-surface shadow-lifted'
              : 'hidden'
          } shrink-0 border-r border-border px-3 py-4 min-[900px]:static min-[900px]:block min-[900px]:w-56 min-[900px]:shadow-none`}
        >
          <p className="px-2 pb-4 font-mono text-xs uppercase tracking-widest text-text-muted">
            StakeAm ops
          </p>
          <p className="px-2 pb-3 font-mono text-xs text-text-muted">
            <kbd className="rounded-sm border border-border px-1">⌘K</kbd> to jump
          </p>
          <ul className="space-y-1">
            {SCREENS.map((screen) => {
              const active = pathname === screen.href;
              const badge =
                screen.href === '/admin/resolution'
                  ? (status?.queues.openDisputes ?? 0) + (status?.queues.resultsDue ?? 0)
                  : screen.href === '/admin/approvals'
                    ? (status?.queues.pendingApprovals ?? 0)
                    : 0;
              const Icon = screen.icon;
              return (
                <li key={screen.href}>
                  <Link
                    href={screen.href}
                    onClick={() => setOpen(false)}
                    className={`flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors ${
                      active ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'
                    }`}
                  >
                    <Icon size={15} />
                    <span>{screen.label}</span>
                    {badge > 0 && (
                      <span className="ml-auto rounded-sm bg-fall px-1.5 font-mono text-xs text-paper">
                        {badge}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        {open && (
          <button
            type="button"
            aria-label="Close the menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-30 bg-text/20 min-[900px]:hidden"
          />
        )}

        <div className="min-w-0 flex-1">
          <header className="flex items-center gap-x-4 gap-y-1 overflow-x-auto border-b border-border px-4 py-2.5 font-mono text-xs">
            {/* The drawer's handle. Only below 900px, where the rail is gone. */}
            <button
              type="button"
              aria-controls="admin-nav"
              aria-expanded={open}
              onClick={() => setOpen((current) => !current)}
              className="-ml-1 shrink-0 rounded-sm border border-border p-1.5 min-[900px]:hidden"
            >
              <span className="sr-only">{open ? 'Close the menu' : 'Open the menu'}</span>
              {open ? <X size={14} /> : <Menu size={14} />}
            </button>
            <StripItem
              label="reconciliation"
              value={status?.reconciliation.status ?? '—'}
              alarm={reconciliationRed}
            />
            <StripItem label="live markets" value={String(status?.activity.liveMarkets ?? '—')} />
            <StripItem
              label="open disputes"
              value={String(status?.queues.openDisputes ?? '—')}
              alarm={(status?.queues.openDisputes ?? 0) > 0}
              amber
            />
            <StripItem
              label="approvals waiting"
              value={String(status?.queues.pendingApprovals ?? '—')}
              alarm={(status?.queues.pendingApprovals ?? 0) > 0}
              amber
            />
            {error !== null && (
              <span className="ml-auto flex items-center gap-1.5 text-fall">
                <AlertTriangle size={13} /> {error}
              </span>
            )}
          </header>

          <main className="px-4 py-5 min-[900px]:px-5">{children}</main>
        </div>
      </div>
    </div>
  );
}

/**
 * §6.10's alarm discipline: red is money, amber is a queue, neutral is a fact.
 * Nothing decorative — an operator who sees red knows it is real.
 */
function StripItem({
  label,
  value,
  alarm = false,
  amber = false,
}: {
  label: string;
  value: string;
  alarm?: boolean;
  amber?: boolean;
}) {
  const tone = alarm ? (amber ? 'text-caution' : 'text-fall') : 'text-text';
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-text-muted">{label}</span>
      <span className={`tabular-nums ${tone}`}>{value}</span>
    </span>
  );
}

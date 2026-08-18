'use client';

import {
  AlertTriangle,
  Gavel,
  LayoutDashboard,
  LifeBuoy,
  ShieldCheck,
  Sparkles,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { admin, type DashboardView } from '@/lib/admin-api';

/**
 * The cockpit shell (§6.10).
 *
 * "Desktop-first... same tokens as §7.4 but in a denser, calmer register — ink-
 * green dark theme by default, gold strictly for money figures, red strictly for
 * alarms." The dark register comes from the tokens package's `.dark` class, so
 * this is the same palette the user app uses, not a second one.
 *
 * The status strip is the point of the layout: reconciliation, disputes and
 * pending approvals are visible from every screen, because those are the three
 * things that mean somebody has to do something now.
 */
const SCREENS = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/drafts', label: 'Drafts', icon: Sparkles },
  { href: '/admin/resolution', label: 'Resolution', icon: Gavel },
  { href: '/admin/approvals', label: 'Approvals', icon: ShieldCheck },
  { href: '/admin/money', label: 'Money room', icon: Wallet },
  { href: '/admin/support', label: 'Support desk', icon: LifeBuoy },
] as const;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [status, setStatus] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="dark min-h-screen bg-surface text-text">
      <div className="flex min-h-screen">
        <nav className="w-56 shrink-0 border-r border-border px-3 py-4">
          <p className="px-2 pb-4 font-mono text-xs uppercase tracking-widest text-text-muted">
            StakeAm ops
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

        <div className="min-w-0 flex-1">
          <header className="flex items-center gap-4 border-b border-border px-5 py-2.5 font-mono text-xs">
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

          <main className="px-5 py-5">{children}</main>
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
  const tone = alarm ? (amber ? 'text-money' : 'text-fall') : 'text-text';
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-text-muted">{label}</span>
      <span className={`tabular-nums ${tone}`}>{value}</span>
    </span>
  );
}

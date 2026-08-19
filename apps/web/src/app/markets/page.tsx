import Link from 'next/link';

import { api, type MarketSummary } from '@/lib/api';
import { AppHeader } from '@/components/app-header';
import { MarketCard } from '@/components/market-card';

// Prices move; a cached shelf is a stale shelf.
export const dynamic = 'force-dynamic';

/** The three views of §7.1's two shelves. */
const VIEWS = [
  { key: 'all', label: 'All' },
  { key: 'official', label: 'Official' },
  { key: 'community', label: 'Community' },
] as const;

type View = (typeof VIEWS)[number]['key'];

const isView = (value: string | undefined): value is View =>
  VIEWS.some((view) => view.key === value);

/**
 * §7.1 — markets home. Two shelves, official and community.
 *
 * The shelves are the top-level split because the trust model differs: official
 * markets are seeded by the platform, community ones are opened by a person who
 * has posted a bond and has to resolve them. That is worth saying on the page,
 * not just in the data model.
 *
 * They used to be two stacked sections and nothing else, which is fine on a
 * desktop and wrong on a phone: one full shelf of cards pushes the other one
 * clean off the screen, so the second shelf reads as missing rather than as
 * further down. The chips below are the fix — and they carry counts, because a
 * chip that says "Community 0" answers the question a chip that just says
 * "Community" makes you tap to find out.
 *
 * The choice lives in the URL rather than in component state, so a shelf can be
 * linked to and survives a reload, and the page stays a server component.
 */
/**
 * Its own title and description, so a tab, a search result and a pasted
 * link each say which page this is rather than just naming the product.
 */
export const metadata = {
  title: 'Markets',
  description:
    'Every open market on StakeAm, official and community — live prices, pot sizes and time to freeze.',
};

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ shelf?: string }>;
}) {
  const { shelf } = await searchParams;
  const view: View = isView(shelf) ? shelf : 'all';

  let markets: MarketSummary[] = [];
  let unreachable = false;

  try {
    markets = await api.markets();
  } catch {
    unreachable = true;
  }

  const official = markets.filter((m) => m.shelf === 'official');
  const community = markets.filter((m) => m.shelf === 'community');
  const counts: Record<View, number> = {
    all: markets.length,
    official: official.length,
    community: community.length,
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <AppHeader />

      {unreachable && (
        <p className="rounded-md border border-border bg-surface-raised p-4 text-sm text-text-muted">
          Can&apos;t reach the markets service. Start it with{' '}
          <code className="font-mono">pnpm dev</code> and refresh.
        </p>
      )}

      <nav aria-label="Shelf" className="mb-6 flex gap-2">
        {VIEWS.map(({ key, label }) => {
          const selected = key === view;
          return (
            <Link
              key={key}
              href={key === 'all' ? '/markets' : `/markets?shelf=${key}`}
              aria-current={selected ? 'page' : undefined}
              // min-h-11 is the 44px a thumb needs; this is the control the
              // whole screen is steered by on a phone.
              className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-bold transition-colors ${
                selected
                  ? 'border-rise bg-rise text-paper'
                  : 'border-border bg-surface-raised text-text-muted hover:border-rise'
              }`}
            >
              {label}
              <span
                className={`font-mono text-xs tabular-nums ${
                  selected ? 'text-paper/80' : 'text-text-muted'
                }`}
              >
                {counts[key]}
              </span>
            </Link>
          );
        })}
      </nav>

      {view !== 'community' && (
        <Shelf
          title="Official"
          blurb="Opened and settled by StakeAm against one named source."
          markets={official}
        />
      )}
      {view !== 'official' && (
        <Shelf
          title="Community"
          blurb="Opened by people who put up a bond to settle them honestly."
          markets={community}
        />
      )}
    </main>
  );
}

function Shelf({
  title,
  blurb,
  markets,
}: {
  title: string;
  blurb: string;
  markets: MarketSummary[];
}) {
  return (
    <section className="mb-10">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mb-4 text-sm text-text-muted">{blurb}</p>

      {markets.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-text-muted">
          Nothing open here yet.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {markets.map((market) => (
            <MarketCard key={market.id} market={market} />
          ))}
        </div>
      )}
    </section>
  );
}

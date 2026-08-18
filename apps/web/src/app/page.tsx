import { api, type MarketSummary } from '@/lib/api';
import { MarketCard } from '@/components/market-card';

// Prices move; a cached shelf is a stale shelf.
export const dynamic = 'force-dynamic';

/**
 * §7.1 — markets home. Two shelves, official and community.
 *
 * The shelves are the top-level split because the trust model differs: official
 * markets are seeded by the platform, community ones are opened by a person who
 * has posted a bond and has to resolve them. That is worth saying on the page,
 * not just in the data model.
 */
export default async function HomePage() {
  let markets: MarketSummary[] = [];
  let unreachable = false;

  try {
    markets = await api.markets();
  } catch {
    unreachable = true;
  }

  const official = markets.filter((m) => m.shelf === 'official');
  const community = markets.filter((m) => m.shelf === 'community');

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8">
        <h1 className="text-2xl font-black leading-none">StakeAm</h1>
        <p className="mt-2 text-md text-text-muted">
          Winners split the pot. No house, no house edge.
        </p>
      </header>

      {unreachable && (
        <p className="rounded-md border border-border bg-surface-raised p-4 text-sm text-text-muted">
          Can&apos;t reach the markets service. Start it with{' '}
          <code className="font-mono">pnpm dev</code> and refresh.
        </p>
      )}

      <Shelf
        title="Official"
        blurb="Opened and settled by StakeAm against one named source."
        markets={official}
      />
      <Shelf
        title="Community"
        blurb="Opened by people who put up a bond to settle them honestly."
        markets={community}
      />
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

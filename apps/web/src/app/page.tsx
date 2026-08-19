import { Suspense } from 'react';

import { FeaturedCarousel } from '@/components/home/featured-carousel';
import { HomeFilterBar } from '@/components/home/home-filter-bar';
import { HomeFooter } from '@/components/home/home-footer';
import { HomeMarketCard } from '@/components/home/home-market-card';
import { HomeNav } from '@/components/home/home-nav';
import { MobileTabBar } from '@/components/home/mobile-tab-bar';
import { TopicStrip } from '@/components/home/topic-strip';
import { api, type MarketDetail, type MarketSummary } from '@/lib/api';
import { SORTS, byBusiest, isSortKey, topicOf, topicsPresent } from '@/lib/home';

// Prices move. A cached front page is a front page showing yesterday's argument.
export const dynamic = 'force-dynamic';

/** How many markets get the full-size treatment at the top. */
const FEATURED = 4;

/**
 * The front door.
 *
 * This used to be a brochure: a headline, three "how it works" boxes, and four
 * cards near the bottom as evidence that the product existed. It read like an
 * ad for a prediction market rather than like one, and the thing a visitor came
 * to do — look at the questions — was below the fold behind an explanation they
 * had not asked for.
 *
 * So the page is now the product. Every market is on it, in a dense grid, with
 * a handful given the full-size treatment at the top; the search, the topics
 * and the sort sit above the grid; and the explaining has moved to where
 * somebody goes looking for it (the rules, the FAQ, the footer). A stranger
 * still understands what this is in under thirty seconds — from live questions
 * with live prices, which is a faster explanation than any paragraph.
 *
 * Everything the reader can change — the search, the topic, the shelf, the
 * order — lives in the query string, so every view of this page is a URL that
 * can be sent to somebody, and the whole grid stays on the server.
 */
export const metadata = {
  title: 'StakeAm · Nigeria’s prediction market',
  description:
    'Live odds on Nigerian politics, football, the naira, music and more. Pick a side, winners split the pot, and every market settles against one named source.',
};

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; topic?: string; shelf?: string; sort?: string }>;
}) {
  const { q, topic, shelf, sort } = await searchParams;

  let markets: MarketSummary[] = [];
  let unreachable = false;
  try {
    markets = await api.markets();
  } catch {
    // The front door still opens when the API does not. It loses the markets
    // and keeps the navigation, so a visitor can reach the status page rather
    // than a blank screen that tells them nothing.
    unreachable = true;
  }

  const open = markets.filter((market) => market.state !== 'resolved' && market.state !== 'voided');

  const query = (q ?? '').trim().toLowerCase();
  const shown = open
    .filter((market) =>
      shelf === 'official' || shelf === 'community' ? market.shelf === shelf : true,
    )
    .filter((market) => (topic === undefined ? true : topicOf(market).key === topic))
    .filter((market) =>
      query === ''
        ? true
        : `${market.question} ${market.sourceName} ${market.outcomes.map((o) => o.label).join(' ')}`
            .toLowerCase()
            .includes(query),
    );

  const compare = (
    SORTS.find((option) => option.key === (isSortKey(sort) ? sort : 'volume')) ?? SORTS[0]
  ).compare;
  const ordered = [...shown].sort(compare);

  // The featured strip follows whatever the reader has filtered to — a topic
  // view whose headline act is a market from another topic is a page arguing
  // with itself. Detail is fetched only for these few, because the carousel
  // shows a chart and a history the list endpoint does not carry.
  const candidates = [...shown]
    .filter((market) => market.state === 'active')
    .sort(byBusiest)
    .slice(0, FEATURED);
  const featured = (
    await Promise.all(
      candidates.map((market) => api.market(market.id).catch((): MarketDetail | null => null)),
    )
  ).filter((market): market is MarketDetail => market !== null);

  return (
    <>
      <Suspense fallback={<div className="h-[68px] border-b border-border" />}>
        <HomeNav />
      </Suspense>
      <Suspense fallback={<div className="h-12 border-b border-border" />}>
        {/* Label and count only — the topic's matcher is a RegExp, and a
            RegExp cannot cross into a client component. */}
        <TopicStrip
          topics={topicsPresent(open).map(({ topic: t, count }) => ({
            key: t.key,
            label: t.label,
            count,
          }))}
        />
      </Suspense>

      <main className="mx-auto max-w-[1350px] px-4 pb-24 pt-5 md:pb-10">
        {unreachable && (
          <p className="rounded-lg border border-border bg-surface-raised p-4 text-sm text-text-muted">
            The markets are not loading right now. Nothing is wrong with your account —{' '}
            <a href="/status" className="underline">
              platform status
            </a>{' '}
            says whether it is us.
          </p>
        )}

        {featured.length > 0 && <FeaturedCarousel markets={featured} />}

        <Suspense fallback={<div className="h-14" />}>
          <HomeFilterBar shown={ordered.length} total={open.length} />
        </Suspense>

        {ordered.length === 0 ? (
          <Empty query={query} filtered={open.length > 0} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {ordered.map((market) => (
              <HomeMarketCard key={market.id} market={market} />
            ))}
          </div>
        )}
      </main>

      <HomeFooter />
      <MobileTabBar />
    </>
  );
}

/**
 * Nothing matched — and which nothing it is matters.
 *
 * A search that found no market and a platform with no markets look identical
 * on screen and are entirely different problems; saying which one this is is
 * the difference between "try another word" and "come back later".
 */
function Empty({ query, filtered }: { query: string; filtered: boolean }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <p className="text-md font-bold">
        {filtered
          ? query === ''
            ? 'Nothing open under this filter.'
            : `No open market mentions “${query}”.`
          : 'No markets are open yet.'}
      </p>
      <p className="mt-2 text-sm text-text-muted">
        {filtered ? (
          <>
            Try another topic, or{' '}
            <a href="/" className="underline">
              see everything
            </a>
            .
          </>
        ) : (
          <>
            The first ones are on their way.{' '}
            <a href="/create" className="underline">
              Open one yourself
            </a>{' '}
            if you cannot wait.
          </>
        )}
      </p>
    </div>
  );
}

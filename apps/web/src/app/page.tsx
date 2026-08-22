import { Suspense } from 'react';

import { CategoryTabs } from '@/components/market/category-tabs';
import { LiveFeed } from '@/components/market/live-feed';
import { MarketCard } from '@/components/market/market-card';
import { ShelfToolbar } from '@/components/market/shelf-toolbar';
import { SearchDemand } from '@/components/market/search-demand';
import { SiteHeader } from '@/components/market/site-header';
import { TradeSheetHost } from '@/components/market/trade-sheet-host';
import { WatchGate, WatchlistEmpty } from '@/components/market/watch-gate';
import { MarketFooter } from '@/components/market/market-footer';
import { MobileNav } from '@/components/market/mobile-nav';
import { api, type MarketSummary } from '@/lib/api';
import { PAGE_WIDTH } from '@/lib/layout';
import { comparatorFor, topicOf, topicsPresent } from '@/lib/home';

// Prices move. A cached shelf is a shelf showing yesterday's argument.
export const dynamic = 'force-dynamic';

/**
 * The markets home — the front door and the product in one screen.
 *
 * Laid out exactly as docs/design-reference.html has it: a 60px header, a row
 * of categories, a line saying how many markets are showing and in what order,
 * and then nothing but markets. There is no explaining above the fold, because
 * live questions at live prices explain this faster than a paragraph does.
 *
 * Everything a reader can change — the search, the category, the shelf, the
 * order — lives in the query string, so every view of this page is a URL that
 * can be sent to somebody, and the grid itself stays on the server.
 */
export const metadata = {
  title: 'StakeAm · Nigeria’s prediction market',
  description:
    'Trade your view on Nigerian politics, football, the naira, music and more. Live prices, one named source per market, and winners paid from the pot.',
};

export default async function MarketsHome({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cat?: string; shelf?: string; sort?: string }>;
}) {
  const { q, cat, shelf, sort } = await searchParams;

  let markets: MarketSummary[] = [];
  let unreachable = false;
  try {
    markets = await api.markets();
  } catch {
    // The front door still opens when the API does not: it loses the markets
    // and keeps the navigation, so a visitor can reach the status page rather
    // than a blank screen that tells them nothing.
    unreachable = true;
  }

  const open = markets.filter((market) => market.state !== 'voided');

  const query = (q ?? '').trim().toLowerCase();
  const shown = open
    .filter((market) =>
      shelf === 'official' || shelf === 'community' ? market.shelf === shelf : true,
    )
    // `watch` is filtered in the browser — the server does not know what this
    // person starred. See WatchGate.
    .filter((market) =>
      cat === undefined || cat === 'all' || cat === 'watch' ? true : topicOf(market).key === cat,
    )
    .filter((market) =>
      query === ''
        ? true
        : `${market.question} ${market.sourceName} ${market.outcomes
            .map((outcome) => outcome.label)
            .join(' ')}`
            .toLowerCase()
            .includes(query),
    );

  const ordered = [...shown].sort(comparatorFor(sort));

  return (
    /*
       A column that fills the viewport, so the footer sits on the bottom edge
       rather than wherever the content happens to stop. With three markets on
       the shelf it was landing a third of the way down a laptop screen with
       500px of nothing under it, which reads as a page that failed to load
       rather than a shelf that is small today. `flex-1` on the main region is
       what does the work; everything else is unchanged.
    */
    <div className="flex min-h-screen flex-col">
      <Suspense fallback={<div className="h-[60px] border-b border-border" />}>
        <SiteHeader />
      </Suspense>

      <Suspense fallback={<div className="h-[43px] border-b border-border" />}>
        <CategoryTabs
          categories={topicsPresent(open).map(({ topic, count }) => ({
            key: topic.key,
            label: topic.label,
            count,
          }))}
          watchCount={0}
        />
      </Suspense>

      <main className={`flex-1 px-4 pb-[72px] sm:px-5 md:pb-0 ${PAGE_WIDTH}`}>
        {/* One subscription for the whole page, governed by the header switch. */}
        <LiveFeed marketIds={ordered.map((market) => market.id)} />

        {/*
          §2.14b's unmet-demand signal. The header search filters through the
          query string, so no request ever reached the search route and the
          opportunity feed was running on nothing.
        */}
        {query !== '' && <SearchDemand query={query} results={ordered.length} />}

        {unreachable && (
          <p className="mt-4 rounded-xl border border-border p-4 text-base text-text-muted">
            The markets are not loading right now. Nothing is wrong with your account —{' '}
            <a href="/status" className="text-brand underline">
              platform status
            </a>{' '}
            says whether it is us.
          </p>
        )}

        <Suspense fallback={<div className="h-[46px]" />}>
          <ShelfToolbar
            shown={ordered.length}
            total={open.length}
            counts={{
              all: open.length,
              official: open.filter((market) => market.shelf === 'official').length,
              community: open.filter((market) => market.shelf === 'community').length,
            }}
          />
        </Suspense>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5 pb-10 pt-3.5">
          {ordered.map((market) => (
            <Suspense key={market.id}>
              <WatchGate marketId={market.id}>
                <MarketCard market={market} />
              </WatchGate>
            </Suspense>
          ))}
        </div>

        <Suspense>
          <WatchlistEmpty />
        </Suspense>

        {ordered.length === 0 && (
          <div className="py-16 text-center text-text-muted">
            {query === '' ? (
              <>
                <p className="font-semibold text-text">Nothing open under this filter.</p>
                <p className="mt-1 text-base">
                  Try another category, or{' '}
                  <a href="/" className="text-brand underline">
                    see everything
                  </a>
                  .
                </p>
              </>
            ) : (
              <>
                <p className="font-semibold text-text">No markets match that search.</p>
                <p className="mt-1 text-base">
                  Nothing open mentions “{query}”.{' '}
                  <a href="/" className="text-brand underline">
                    Clear it
                  </a>
                  .
                </p>
              </>
            )}
          </div>
        )}
      </main>

      <MarketFooter />

      <Suspense>
        <MobileNav />
      </Suspense>

      {/* One sheet for the whole grid — a price button opens it in place
          rather than sending the reader off to a page first. */}
      <TradeSheetHost />
    </div>
  );
}

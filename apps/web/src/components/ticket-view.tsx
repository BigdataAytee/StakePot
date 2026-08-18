'use client';

import { useEffect, useMemo, useState } from 'react';

import { ArgumentBar } from '@/components/argument-bar';
import { LivingNumber } from '@/components/living-number';
import { MoneyStrip } from '@/components/money-strip';
import { OutcomeButtons } from '@/components/outcome-buttons';
import { PriceChart, type Timeframe } from '@/components/price-chart';
import { RulesCard } from '@/components/rules-card';
import { SeedPanel } from '@/components/seed-panel';
import { ShareSheet } from '@/components/share-sheet';
import { TradeSheet, type TradeIntent } from '@/components/trade-sheet';
import { useMarketFeed } from '@/hooks/use-market-feed';
import { api, type MarketDetail, type PricePoint, type SeedComposition } from '@/lib/api';
import { recordView } from '@/lib/creator-api';
import { STATE_LABEL, percent, untilFreeze } from '@/lib/format';
import { useLivePrices } from '@/store/live-prices';

/**
 * §7.2 — the Ticket View.
 *
 * Assembled in the order the spec lays out, because that order is the argument:
 * the chart says how we got here, the bar says who is winning now, the money
 * strip says whether the market is worth trading, and only then does it ask you
 * to trade. Rules sit below, where someone checks them before committing.
 */
export function TicketView({
  initial,
  initialHistory,
}: {
  initial: MarketDetail;
  initialHistory: PricePoint[];
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>('1D');
  const [history, setHistory] = useState<PricePoint[]>(initialHistory);
  const [intent, setIntent] = useState<TradeIntent | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [composition, setComposition] = useState<SeedComposition | null>(null);

  const headline = initial.outcomes[0];
  useMarketFeed(initial.id);

  const seed = useLivePrices((state) => state.seed);
  const live = useLivePrices((state) => state.markets[initial.id]);

  useEffect(() => {
    seed(initial.id, {
      prices: Object.fromEntries(initial.outcomes.map((o) => [o.id, o.price])),
      pot: initial.pot,
      at: 0,
    });
  }, [initial, seed]);

  useEffect(() => {
    setToken(window.localStorage.getItem('stakeam.token'));
  }, []);

  // A seeded market's composition, and a seeding round's terms while it is open.
  // Official markets and Path A community markets have neither, so they never
  // ask (§2.4).
  const seeded = initial.activationPath === 'seeded' || initial.state === 'seeding';
  useEffect(() => {
    if (!seeded) return;
    let cancelled = false;
    void api
      .seed(initial.id)
      .then((found) => {
        if (!cancelled) setComposition(found);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initial.id, seeded]);

  useEffect(() => {
    if (headline === undefined) return;
    let cancelled = false;
    // Binary asks for the headline series only; a multi-outcome market needs
    // every candidate's line, so the outcome filter is dropped.
    const only = initial.outcomes.length === 2 ? headline.id : undefined;
    void api
      .history(initial.id, only, timeframe)
      .then((points) => {
        if (!cancelled) setHistory(points);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initial.id, headline, timeframe, live?.at]);

  const prices = live?.prices ?? {};
  const segments = useMemo(
    () =>
      initial.outcomes.map((o) => ({
        id: o.id,
        label: o.label,
        price: prices[o.id] ?? o.price,
        ordinal: o.ordinal,
        isOther: o.isOther,
      })),
    [initial.outcomes, prices],
  );

  // §2.14d's views→stakes conversion starts here. Sent once per mount, tagged
  // with where the reader came from, so `?src=share` on a pasted link is what
  // makes "traffic sources" a count rather than a guess.
  useEffect(() => {
    const source =
      typeof window === 'undefined'
        ? undefined
        : (new URLSearchParams(window.location.search).get('src') ?? undefined);
    recordView(initial.id, source);
  }, [initial.id]);

  const headlinePrice = headline === undefined ? 0 : percent(prices[headline.id] ?? headline.price);
  const tradingOpen = initial.state === 'active';

  return (
    <main className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-5">
        <div className="flex items-center justify-between gap-3">
          <span
            className={`rounded-sm px-1.5 py-0.5 font-mono text-xs ${
              tradingOpen ? 'bg-rise text-paper' : 'bg-border text-text-muted'
            }`}
          >
            {STATE_LABEL[initial.state] ?? initial.state.toUpperCase()}
          </span>
          {tradingOpen && (
            <span className="font-mono text-xs text-text-muted">
              Freezes in {untilFreeze(initial.eventDate)}
            </span>
          )}
        </div>

        <h1 className="mt-3 text-xl font-black leading-tight">{initial.question}</h1>

        {/* §2.14c's byline. A community market is somebody's promise, so it
            carries their name and what their record has earned them. */}
        {initial.creator?.handle != null && (
          <p className="mt-2 flex items-center gap-2 font-mono text-xs text-text-muted">
            <a
              href={`/c/${initial.creator.handle}`}
              className="text-rise underline underline-offset-2"
            >
              @{initial.creator.handle}
            </a>
            {initial.creator.badge !== null && (
              <span className="rounded-full bg-rise px-1.5 py-0.5 text-[10px] font-bold text-paper">
                {initial.creator.badge}
              </span>
            )}
            {initial.creator.cleanResolutions > 0 && (
              <span>{initial.creator.cleanResolutions} clean resolutions</span>
            )}
          </p>
        )}

        <div className="mt-4 flex items-baseline justify-between gap-3">
          <p className="flex items-baseline gap-2">
            <LivingNumber value={headlinePrice} suffix="%" className="text-2xl font-black" />
            <span className="text-md text-text-muted">{headline?.label}</span>
          </p>
          <ShareSheet marketId={initial.id} question={initial.question} />
        </div>
      </header>

      {/* (a) the hero */}
      <PriceChart
        points={history}
        outcomes={initial.outcomes}
        annotations={initial.annotations}
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
      />

      {/* (b) the argument bar */}
      <div className="mt-5">
        {/* Multi-outcome tickets get their names and prices from the chart
            legend directly above, so the bar is left as pure shape. */}
        <ArgumentBar segments={segments} showLabels={initial.outcomes.length === 2} />
      </div>

      {/* (c) money strip */}
      <div className="mt-5">
        <MoneyStrip
          pot={live?.pot ?? initial.pot}
          volume24h={initial.volume24h}
          traders={initial.traderCount}
          feeBps={initial.feeBps}
        />
      </div>

      {/* (d) priced buttons — tapping one slides up the Trade Ticket */}
      <div className="mt-5">
        <OutcomeButtons
          outcomes={initial.outcomes}
          livePrices={prices}
          disabled={!tradingOpen}
          onPick={(outcome) => setIntent({ outcome, side: 'buy' })}
        />
        {!tradingOpen && (
          <p className="mt-2 text-sm text-text-muted">
            {initial.state === 'resolved'
              ? 'This market has settled.'
              : initial.state === 'seeding'
                ? 'Sponsors are still filling the seed. Trading opens the moment the round fills.'
                : initial.state === 'draft'
                  ? 'Waiting on the creator’s symmetric seed.'
                  : initial.state === 'voided'
                    ? 'This market voided — every stake was refunded in full.'
                    : 'Trading is frozen — the event has started.'}
          </p>
        )}
      </div>

      {composition !== null && (
        <div className="mt-5">
          <SeedPanel
            composition={composition}
            token={token}
            onChanged={() => window.location.reload()}
          />
        </div>
      )}

      {/* (f) below the fold */}
      <div className="mt-6">
        <RulesCard market={initial} />
      </div>

      <TradeSheet
        market={initial}
        intent={intent}
        livePrices={prices}
        token={token}
        onClose={() => setIntent(null)}
        onFilled={() => window.location.reload()}
      />
    </main>
  );
}

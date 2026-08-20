'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import Link from 'next/link';

import { ArgumentBar } from '@/components/argument-bar';
import { LivingNumber } from '@/components/living-number';
import { LiveChanceGauge, LivePercent } from '@/components/market/live-percent';
import { binaryPair } from '@/lib/home';
import { authed } from '@/lib/session';
import { takeTrade } from '@/lib/pending-trade';
import { MarketIcon } from '@/components/market/market-icon';
import { SiteHeader } from '@/components/market/site-header';
import { ChallengeButton } from '@/components/market/challenge-button';
import { FundingActivation } from '@/components/market/funding-activation';
import { MobileBuyBar } from '@/components/market/mobile-buy-bar';
import { ResolutionStatus } from '@/components/market/resolution-status';
import { ResolvedReceipt } from '@/components/market/resolved-receipt';
import { TradePanel } from '@/components/market/trade-panel';
import { WatchStar } from '@/components/market/watch-star';
import { PriceChart, type Timeframe } from '@/components/price-chart';
import { RulesCard } from '@/components/rules-card';
import { SeedPanel } from '@/components/seed-panel';
import { ShareSheet } from '@/components/share-sheet';
import { Sparkline } from '@/components/sparkline';
import { TakeThread } from '@/components/take-thread';
import { TradeSheet, type TradeIntent } from '@/components/trade-sheet';
import { useMarketFeed } from '@/hooks/use-market-feed';
import { api, type MarketDetail, type PricePoint, type SeedComposition } from '@/lib/api';
import { PAGE_WIDTH } from '@/lib/layout';
import { recordView } from '@/lib/creator-api';
import { STATE_LABEL, dateTime, money, percent, untilFreeze } from '@/lib/format';
import { PositionPanel } from './position-panel';
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
  // Which outcome the chart and the side panel are showing. Null until the
  // reader picks one from the list, so the market opens on its headline.
  const [picked, setPicked] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [composition, setComposition] = useState<SeedComposition | null>(null);
  // Bumped after a fill so the position panel re-reads rather than showing the
  // holding the user had before the trade they just made.
  const [filled, setFilled] = useState(0);

  const headline = initial.outcomes[0];
  useMarketFeed(initial.id);

  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  /**
   * The side somebody already picked, one screen back.
   *
   * A price button on a card is a decision, not a link to a page — pressing
   * "Yes 62k" and landing on a market with nothing selected asks the person to
   * make the same choice twice, and the second time without the number that
   * made them press it. So the card carries the outcome in `?side=`, and the
   * ticket opens on it with the sheet already up.
   *
   * The parameter is cleared as soon as it is read. It is an instruction, not
   * a location: left in place, closing the sheet and reloading would re-open a
   * ticket the person had just dismissed, and the back button would walk them
   * through the same sheet on the way out.
   */
  useEffect(() => {
    /*
     * `?sell=` is the portfolio's way in: a holding somebody wants out of opens
     * the sheet already on the sell side with the position loaded, because
     * looking at a losing position and deciding to close it is one decision,
     * and making it two clicks is how somebody ends up still holding it.
     */
    const exiting = params.get('sell');
    if (exiting !== null) {
      const outcome = initial.outcomes.find((row) => row.id === exiting);
      if (outcome !== undefined && initial.state === 'active') {
        // The sell slider is bounded by what is actually held, and the
        // portfolio link carries only which outcome. Asking the API rather than
        // trusting a number from the query string: a bound supplied by the URL
        // is a bound anybody can edit.
        void authed<{ outcomeId: string; shares: string }[]>('/me/positions')
          .then((rows) => {
            const held = rows.find((row) => row.outcomeId === exiting)?.shares;
            if (held === undefined || Number.parseFloat(held) <= 0) return;
            setIntent({ outcome, side: 'sell', held });
            setPicked(outcome.id);
          })
          .catch(() => undefined);
      }
      router.replace(pathname, { scroll: false });
      return;
    }

    const requested = params.get('side');
    if (requested === null) return;

    const outcome = initial.outcomes.find((row) => row.id === requested);
    // An outcome that is not on this market, or a market that has stopped
    // trading, drops the instruction rather than opening a ticket that cannot
    // be filled.
    if (outcome !== undefined && initial.state === 'active') {
      // If they were sent to sign in from a half-composed trade, the amount
      // they had typed is waiting — put it back rather than making them decide
      // it a second time.
      const pending = takeTrade(initial.id);
      const amount = pending?.outcomeId === outcome.id ? pending.amount : '';
      setIntent({ outcome, side: 'buy', ...(amount === '' ? {} : { amount }) });
      setPicked(outcome.id);
    }
    router.replace(pathname, { scroll: false });
  }, [params, pathname, router, initial.outcomes, initial.state]);

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

  const tradingOpen = initial.state === 'active';

  // §7.2e: a market still gathering backers has no price history worth
  // reading, so the chart area becomes the activation view instead.
  const funding = initial.state === 'funding' || initial.state === 'seeding';
  // §7.2c's pot-growth sparkline. The history endpoint already returns the pot
  // beside each price snapshot, so this costs no extra request.
  const potSeries = history.map((point) => point.pot);

  const selected =
    initial.outcomes.find((row) => row.id === picked) ?? headline ?? initial.outcomes[0];
  const selectedPrice = selected === undefined ? 0 : percent(prices[selected.id] ?? selected.price);
  /** The Yes side, when there is one — the dial's subject. */
  const dial = binaryPair(initial)?.[0] ?? null;

  return (
    <>
      <SiteHeader />

      <main
        className={`px-4 pb-[88px] pt-4 sm:px-5 min-[860px]:pb-16 min-[860px]:pt-[18px] ${PAGE_WIDTH}`}
      >
        <Link
          href="/"
          className="mb-3.5 inline-flex items-center gap-1.5 rounded-md bg-chip px-3 py-2 text-base font-semibold text-text-muted hover:text-text"
        >
          ← All markets
        </Link>

        {/*
          The question, then the things you can do to it.

          On a phone the actions take their own line. In one row they were
          three shrink-resistant controls against a `flex-1` heading with no
          minimum, so the heading lost every time — at 390px the question wrapped
          one word per line down a column about eight characters wide, which is
          the least readable possible rendering of the single most important
          sentence on the screen. `min-w-0` alone would not save it; the actions
          have to leave the row.
        */}
        <div className="mb-1.5 flex flex-wrap items-start gap-x-3.5 gap-y-2.5">
          <MarketIcon id={initial.id} question={initial.question} size={56} radius={12} />
          <h1 className="min-w-0 flex-1 text-xl font-bold leading-[1.25]">{initial.question}</h1>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <WatchStar marketId={initial.id} question={initial.question} size={34} />
            <ShareSheet marketId={initial.id} question={initial.question} />
            <ChallengeButton marketId={initial.id} />
          </div>
        </div>

        {/* The headline probability, on the one screen where a reader has come
            specifically to look at it. Only for Yes/No: a candidate market has
            no single number to put on a dial, and picking the leader's would
            invent a headline the question does not have. */}
        {dial !== null && (
          <div className="mb-1 flex justify-end min-[860px]:justify-start">
            <LiveChanceGauge
              marketId={initial.id}
              outcomeId={dial.id}
              fallback={dial.price}
              size={90}
              label={`${dial.label.toLowerCase()} chance`}
            />
          </div>
        )}

        {/* §2.14c's byline. A community market is somebody's promise, so it
            carries their name and what their record has earned them. */}
        {initial.creator?.handle != null && (
          <p className="flex items-center gap-2 text-sm text-text-muted">
            <a href={`/c/${initial.creator.handle}`} className="text-brand underline">
              @{initial.creator.handle}
            </a>
            {initial.creator.badge !== null && (
              <span className="rounded-full bg-brand px-1.5 py-0.5 text-[10px] font-bold text-paper">
                {initial.creator.badge}
              </span>
            )}
            {initial.creator.cleanResolutions > 0 && (
              <span>{initial.creator.cleanResolutions} clean resolutions</span>
            )}
          </p>
        )}

        <div className="mb-4 mt-2.5 flex flex-wrap gap-[18px] text-sm text-text-muted">
          <span className="flex items-center gap-1.5">
            <span>
              <b className="text-text">{money(live?.pot ?? initial.pot)}</b> pot
            </span>
            <Sparkline points={potSeries} width={48} height={14} />
          </span>
          <span>
            <b className="text-text">{money(initial.volume24h)}</b> 24h vol.
          </span>
          <span>
            <b className="text-text">{initial.traderCount}</b>{' '}
            {initial.traderCount === 1 ? 'trader' : 'traders'}
          </span>
          <span>
            <b className="text-text">{(initial.feeBps / 100).toFixed(1)}%</b> fee
          </span>
          {tradingOpen ? (
            <span>
              Freezes in <b className="text-text">{untilFreeze(initial.eventDate)}</b>
            </span>
          ) : (
            <span className="font-semibold uppercase tracking-wide">
              {STATE_LABEL[initial.state] ?? initial.state}
            </span>
          )}
          <span>
            Ends <b className="text-text">{dateTime(initial.eventDate)}</b>
          </span>
        </div>

        {/* Two columns down to 860px, one below it — the reference's own
            breakpoint, which is where 330px of trade panel stops leaving the
            chart a readable width. */}
        <div className="grid items-start gap-[22px] min-[860px]:grid-cols-[1fr_330px]">
          <div>
            {funding ? (
              <FundingActivation market={initial} composition={composition} />
            ) : (
              <div className="rounded-xl border border-border p-4">
                <div className="mb-1 flex flex-wrap items-baseline gap-2.5">
                  <span className="text-base font-semibold text-text-muted">{selected?.label}</span>
                  <LivingNumber value={selectedPrice} suffix="%" className="text-2xl font-bold" />
                </div>

                <PriceChart
                  points={history}
                  outcomes={initial.outcomes}
                  annotations={initial.annotations}
                  timeframe={timeframe}
                  onTimeframeChange={setTimeframe}
                />

                {/* The argument bar: who is winning, as one shape. */}
                <div className="mt-4">
                  <ArgumentBar segments={segments} showLabels={initial.outcomes.length === 2} />
                </div>
              </div>
            )}

            <ResolvedReceipt market={initial} />
            <ResolutionStatus market={initial} />

            <div className="mt-4 overflow-hidden rounded-xl border border-border">
              <div className="flex border-b border-border px-3.5 py-2.5 text-sm font-semibold text-text-muted">
                <span>Outcome</span>
                <span className="ml-auto">Chance</span>
              </div>
              {initial.outcomes.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setPicked(row.id)}
                  className={`flex w-full items-center gap-2.5 border-b border-border px-3.5 py-2.5 text-left text-[13.5px] last:border-b-0 hover:bg-chip ${
                    row.id === selected?.id ? 'bg-brand/[.06]' : ''
                  }`}
                >
                  <span className="flex-1 font-medium">{row.label}</span>
                  <span className="text-xs text-text-muted">{money(row.staked)} staked</span>
                  <LivePercent
                    marketId={initial.id}
                    outcomeId={row.id}
                    fallback={row.price}
                    className="font-bold"
                  />
                </button>
              ))}
            </div>

            {composition !== null && (
              <div className="mt-4">
                <SeedPanel
                  composition={composition}
                  token={token}
                  onChanged={() => window.location.reload()}
                />
              </div>
            )}

            <PositionPanel
              market={initial}
              livePrices={prices}
              refreshKey={filled}
              onSell={(outcome, held) => setIntent({ outcome, side: 'sell', held })}
            />

            <div className="mt-4">
              <RulesCard market={initial} />
            </div>

            {/* §2.15a: the market page *is* the community space — no separate
                forum, because the argument and the money belong on one screen. */}
            <TakeThread
              marketId={initial.id}
              outcomes={initial.outcomes.map((outcome) => ({
                label: outcome.label,
                ordinal: outcome.ordinal,
              }))}
              resolved={initial.state === 'resolved'}
              signedIn={token !== null}
            />
          </div>

          {selected !== undefined && (
            <TradePanel
              market={initial}
              outcome={selected}
              livePrices={prices}
              onPick={(row) => setPicked(row.id)}
              onFilled={() => setFilled((count) => count + 1)}
            />
          )}
        </div>
      </main>

      {/* The phone's primary action, in place of the side panel it has no
          room for. */}
      <MobileBuyBar
        market={initial}
        livePrices={prices}
        onBuy={(outcome) => {
          setPicked(outcome.id);
          setIntent({ outcome, side: 'buy' });
        }}
      />

      {/* Kept for the two paths that are not the side panel: a price button
          pressed on the grid, and selling out of a position. */}
      <TradeSheet
        market={initial}
        intent={intent}
        livePrices={prices}
        token={token}
        onClose={() => setIntent(null)}
        onFilled={() => {
          setFilled((count) => count + 1);
          window.location.reload();
        }}
      />
    </>
  );
}

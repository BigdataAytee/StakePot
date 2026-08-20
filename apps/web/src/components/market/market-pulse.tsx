'use client';

import { useEffect, useState } from 'react';

import { api, type MarketPulse } from '@/lib/api';
import { money } from '@/lib/format';
import { elapsed } from '@/lib/liveness';

/** How often the pulse is re-read when nothing arrives over the socket. */
const POLL_MS = 20_000;

/**
 * How busy this market is, right now.
 *
 * Three readouts and a ticker, and every one of them is counted from trades
 * that executed. Nothing here is a price and nothing here may be read as one —
 * which is why "pressure" says what it is measuring in the label rather than
 * in a tooltip: it is the buy share of the last half-hour's trades, and a
 * reader who takes it for an implied probability has been misled by this
 * screen, not by themselves.
 *
 * Refreshed by the price socket rather than by its own timer, mostly. A tick
 * arrives when a trade lands, which is exactly when these numbers change; the
 * poll underneath it is there for the other direction, where a market goes
 * quiet and the *absence* of trades is the thing that has to keep updating.
 */
export function MarketPulse({
  marketId,
  /** Bumped by the live feed when a trade moves this market's price. */
  tradedAt,
}: {
  marketId: string;
  tradedAt?: number | undefined;
}) {
  const [pulse, setPulse] = useState<MarketPulse | null>(null);

  useEffect(() => {
    let live = true;
    const read = (): void => {
      api
        .pulse(marketId)
        .then((next) => {
          if (live) setPulse(next);
        })
        .catch(() => undefined);
    };

    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [marketId, tradedAt]);

  if (pulse === null) {
    return (
      <div
        role="status"
        aria-label="Reading market activity"
        className="mt-3 h-[86px] rounded-xl border border-border bg-surface-raised motion-safe:animate-pulse"
      />
    );
  }

  return (
    <section
      aria-label="Market activity"
      className="mt-3 overflow-hidden rounded-xl border border-border bg-surface-raised"
    >
      <div className="grid grid-cols-2 divide-x divide-border border-b border-border sm:grid-cols-3">
        <Stat
          value={String(pulse.tradesPerHour)}
          unit="trades/hr"
          note={<Trend trend={pulse.trend} />}
        />
        <Stat
          value={String(pulse.tradersActive)}
          unit={pulse.tradersActive === 1 ? 'trader' : 'traders'}
          note={<>active in {pulse.activeMinutes}m</>}
        />
        {/* Last, and on its own line on a phone: it is the row that most needs
            its label read, so it does not get squeezed into a third of 390px. */}
        <div className="col-span-2 border-t border-border px-3.5 py-2.5 sm:col-span-1 sm:border-t-0">
          <Pressure pressure={pulse.pressure} />
        </div>
      </div>

      <Ticker pulse={pulse} />
    </section>
  );
}

function Stat({ value, unit, note }: { value: string; unit: string; note: React.ReactNode }) {
  return (
    <div className="px-3.5 py-2.5">
      <p className="flex items-baseline gap-1.5">
        <b className="font-mono text-lg tabular-nums">{value}</b>
        <span className="text-fine text-text-muted">{unit}</span>
      </p>
      <p className="mt-0.5 text-fine text-text-muted">{note}</p>
    </div>
  );
}

/**
 * Whether the last half-hour was busier than the one before it.
 *
 * Suppressed to "steady" below a handful of trades by the API, so this never
 * draws an arrow from a sample of three. An arrow is a claim about a market's
 * direction of travel and three trades cannot support one.
 */
function Trend({ trend }: { trend: MarketPulse['trend'] }) {
  if (trend === 'steady') return <>steady</>;
  return (
    <span className={trend === 'rising' ? 'text-rise' : 'text-fall'}>
      <span aria-hidden>{trend === 'rising' ? '▲' : '▼'}</span> {trend}
    </span>
  );
}

/**
 * Which way recent trades went — as a bar, with the words that stop it being
 * mistaken for a price.
 *
 * A bar this shape sitting on a market screen looks like a probability, so the
 * label does the work the shape cannot: "of the last 14 trades" is a count of
 * things that happened, and it is written on the readout rather than beside
 * it.
 */
function Pressure({ pressure }: { pressure: MarketPulse['pressure'] }) {
  const total = pressure.buys + pressure.sells;

  if (pressure.buyShare === null) {
    return (
      <>
        <p className="text-note text-text-muted">No trades in the last {pressure.windowMinutes}m</p>
        <p className="mt-0.5 text-fine text-text-muted">Recent activity, not the price</p>
      </>
    );
  }

  const buyPct = Math.round(pressure.buyShare * 100);

  return (
    <>
      <p className="flex items-baseline justify-between gap-2 text-fine">
        <span className="font-mono font-bold text-rise">{pressure.buys} buying</span>
        <span className="font-mono font-bold text-fall">{pressure.sells} selling</span>
      </p>
      <div
        className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-chip"
        role="img"
        aria-label={`${pressure.buys} of the last ${total} trades were buys, over ${pressure.windowMinutes} minutes`}
      >
        <span className="bg-rise" style={{ width: `${buyPct}%` }} />
        <span className="flex-1 bg-fall" />
      </div>
      <p className="mt-1 text-fine text-text-muted">
        Of the last {total} trades · {pressure.windowMinutes}m · not a price
      </p>
    </>
  );
}

/**
 * The trades themselves, newest first.
 *
 * The counts above say how much is happening; this says what. It is the part
 * that makes a quiet market legible — three lines an hour apart is a different
 * market from three lines a minute apart, and no summary statistic carries
 * that.
 */
function Ticker({ pulse }: { pulse: MarketPulse }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = (): void => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  if (pulse.ticker.length === 0) {
    return (
      <p className="px-3.5 py-3 text-note text-text-muted">
        Nothing has traded yet. This fills in from the first one.
      </p>
    );
  }

  return (
    <>
      {/*
        Scrolls, and says so with a fade rather than by chopping a row in half
        at the bottom edge. A half-drawn line of numbers on a money screen
        reads as a rendering fault; a fade reads as "there is more".
      */}
      <div className="relative">
        <ol className="max-h-44 overflow-y-auto text-note">
          {pulse.ticker.map((trade) => (
            <li
              key={trade.id}
              className="flex items-baseline gap-2 border-b border-border px-3.5 py-1.5 last:border-b-0"
            >
              <span className="font-mono text-fine text-text-muted">{trade.actor}</span>
              <span className={`font-semibold ${trade.side === 'buy' ? 'text-rise' : 'text-fall'}`}>
                {trade.side === 'buy' ? 'bought' : 'sold'}
              </span>
              <span className="min-w-0 flex-1 truncate">{trade.label}</span>
              <span className="whitespace-nowrap font-mono tabular-nums">{money(trade.cost)}</span>
              <span className="whitespace-nowrap font-mono tabular-nums text-text-muted">
                {Math.round(Number.parseFloat(trade.price) * 100)}%
              </span>
              {/* The age, to the second while it is seconds. On a stream this is
                  the difference between a market being traded and one being
                  looked at, and it is the fact a row of prices cannot carry. */}
              <span className="w-9 whitespace-nowrap text-right font-mono text-fine text-text-muted">
                {now === null ? '' : elapsed(now - new Date(trade.ts).getTime())}
              </span>
            </li>
          ))}
        </ol>
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-surface-raised to-transparent"
        />
      </div>
      <p className="border-t border-border px-3.5 py-2 text-fine text-text-muted">
        Executed trades, newest first. Codes, not names — and a new code on every market.
      </p>
    </>
  );
}

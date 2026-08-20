'use client';

import { Sparkline } from '@/components/sparkline';
import { countdown, dateTime, money, percent, settlesOn, untilFreeze } from '@/lib/format';
import { PriceChange } from './price-change';

/**
 * The ticket's quote row.
 *
 * The facts were all on the page already, strung along one line as prose — "pot
 * · 24h vol. · traders · fee · freezes in · ends" — which reads as a caption
 * and scans as nothing. A quote page does not do that: it puts each figure in
 * its own cell with its label above it, in a fixed order, so a reader who has
 * seen one ticket knows where to look on every other one.
 *
 * Order is deliberate and is the order of the questions somebody actually asks:
 * what does a share cost, which way has it gone, how much is riding on it, when
 * do I find out.
 *
 * The countdown appears only inside a day. A clock ticking beside a market that
 * settles in three weeks trains people to ignore the clock beside the one
 * settling in three hours, which is the only one that needed a clock.
 */
export function QuoteStrip({
  price,
  change24h,
  pot,
  potSeries,
  volume24h,
  traders,
  feeBps,
  eventDate,
  tradingOpen,
  stateLabel,
  target,
}: {
  /** The headline outcome's price, 0–1. */
  price: number;
  change24h: number | null;
  pot: string;
  potSeries: string[];
  volume24h: string;
  traders: number;
  feeBps: number;
  eventDate: string;
  tradingOpen: boolean;
  stateLabel: string;
  /**
   * The level a threshold market is measured against, and the latest published
   * value where one is known — the reference's "Price To Beat / Current Price".
   */
  target?: { label: string; value: string; latest?: string | undefined } | undefined;
}) {
  const ends = countdown(eventDate);

  return (
    <div className="mb-4 mt-3 rounded-xl border border-border bg-surface-raised">
      <dl className="grid grid-cols-2 divide-x divide-y divide-border sm:grid-cols-4 sm:divide-y-0">
        <Cell label="Price per share">
          <span className="font-mono text-lg font-bold">{Math.round(percent(price))}%</span>
          <PriceChange change={change24h} className="ml-1.5" />
        </Cell>

        <Cell label="Pot">
          <span className="flex items-center gap-1.5">
            <span className="font-mono text-lg font-bold text-money">{money(pot)}</span>
            <Sparkline points={potSeries} width={40} height={14} />
          </span>
        </Cell>

        <Cell label="24h volume">
          <span className="font-mono text-lg font-bold">{money(volume24h)}</span>
          <span className="ml-1.5 text-xs text-text-muted">
            {traders} {traders === 1 ? 'trader' : 'traders'}
          </span>
        </Cell>

        <Cell label="Settles">
          <span className="font-mono text-lg font-bold">{settlesOn(eventDate)}</span>
          {ends !== null && (
            <span className="ml-1.5 rounded-sm bg-caution-bg px-1.5 py-0.5 font-mono text-[10px] font-bold text-caution">
              {ends}
            </span>
          )}
        </Cell>
      </dl>

      {/*
        The threshold, when there is one.

        "Will the naira close below ₦1,500" is a question about a level, and a
        ticket that shows only the probability leaves the reader holding half of
        it — they still have to go and find out where the naira actually is. The
        row is absent rather than empty when no level is known, because an
        empty "latest" reads as "nobody is watching".
      */}
      {target !== undefined && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-border px-3.5 py-2.5 text-sm">
          <span className="text-text-muted">{target.label}</span>
          <span className="font-mono font-bold">{target.value}</span>
          {target.latest !== undefined && (
            <>
              <span className="text-text-muted">Latest</span>
              <span className="font-mono font-bold">{target.latest}</span>
            </>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3.5 py-2 text-xs text-text-muted">
        <span>
          Fee <b className="font-mono text-text">{(feeBps / 100).toFixed(1)}%</b>
        </span>
        {tradingOpen ? (
          <span>
            Freezes in <b className="font-mono text-text">{untilFreeze(eventDate)}</b>
          </span>
        ) : (
          <span className="font-semibold uppercase tracking-wide">{stateLabel}</span>
        )}
        <span>
          Ends <b className="text-text">{dateTime(eventDate)}</b>
        </span>
      </div>
    </div>
  );
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3.5 py-2.5">
      <dt className="text-[10.5px] font-semibold uppercase tracking-[.05em] text-text-muted">
        {label}
      </dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline leading-none">{children}</dd>
    </div>
  );
}

'use client';

import Link from 'next/link';

import type { MarketSummary } from '@/lib/api';
import { STATE_LABEL, kobo, money } from '@/lib/format';
import { ArgumentBar } from './argument-bar';
import { FreezeCountdown, FrozenBadge, useFreeze } from './market/freeze-notice';
import { Sparkline } from './sparkline';

/**
 * §7.1 — the market card: "question, live headline % with a mini sparkline of
 * the last 24h, pot size, time-to-freeze, state badge."
 *
 * The argument bar appears here in miniature, which is what makes it the brand
 * rather than a chart decoration: the same object, same colours, same meaning,
 * at every size.
 */
export function MarketCard({ market }: { market: MarketSummary }) {
  const headline = market.outcomes[0];
  // Past its freeze time counts as not live even while the state column still
  // says `active` — the sweep that flips it runs on a schedule and can be late,
  // and a card that reads ACTIVE beside a market the API refuses is a card that
  // sends somebody to a dead Buy button.
  const freeze = useFreeze(market);
  const live = market.state === 'active' && !freeze.frozen;

  return (
    <Link
      href={`/market/${market.id}`}
      className="block rounded-lg border border-border bg-surface-raised p-4 transition-colors hover:border-rise focus-visible:outline focus-visible:outline-2 focus-visible:outline-rise"
    >
      <div className="flex items-center justify-between gap-3">
        {!live && freeze.frozen && market.state !== 'resolved' && market.state !== 'voided' ? (
          <FrozenBadge />
        ) : (
          <span
            className={`rounded-sm px-1.5 py-0.5 font-mono text-xs ${
              live ? 'bg-rise text-paper' : 'bg-border text-text-muted'
            }`}
          >
            {STATE_LABEL[market.state] ?? market.state.toUpperCase()}
          </span>
        )}
        <span className="font-mono text-xs text-text-muted">
          {live ? <FreezeCountdown market={market} /> : market.shelf}
        </span>
      </div>

      <h3 className="mt-3 text-md font-bold leading-snug">{market.question}</h3>

      <div className="mt-3 flex items-end justify-between gap-4">
        <div>
          <span className="font-mono text-xl font-black tabular-nums">
            {headline === undefined ? '—' : kobo(headline.price)}
          </span>
          <span className="ml-1.5 text-sm text-text-muted">{headline?.label}</span>
        </div>
        <Sparkline points={market.sparkline ?? []} />
      </div>

      <div className="mt-3">
        <ArgumentBar
          size="mini"
          segments={market.outcomes.map((o) => ({
            id: o.id,
            label: o.label,
            price: o.price,
            ordinal: o.ordinal,
            isOther: o.isOther,
          }))}
        />
      </div>

      <p className="mt-3 font-mono text-xs text-text-muted">
        Pot <span className="text-money">{money(market.pot)}</span>
      </p>
    </Link>
  );
}

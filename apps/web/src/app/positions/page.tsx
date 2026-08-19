'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { PageShell, PageTitle } from '@/components/market/page-shell';
import { exactMoney, money, percent } from '@/lib/format';
import { authed, getToken, useSession } from '@/lib/session';

/**
 * §7.1's "My positions": "open positions with live P&L, closed history,
 * pending payouts."
 *
 * Positions were only ever visible one market at a time, on the ticket. That
 * is fine for deciding whether to sell and useless for the question people
 * actually have, which is "how am I doing" — a question you cannot answer by
 * opening eleven tabs.
 *
 * Two figures, kept apart on purpose. **Staked** is what a position cost,
 * which is a fact. **Now worth** is a mark-to-market at the live price, which
 * is an estimate, and selling would return that less the early-exit fee.
 * Presenting the second as money in hand is how a screen like this ends up
 * lying to somebody.
 */
interface Position {
  marketId: string;
  marketQuestion: string;
  marketState: string;
  shelf: string;
  outcomeId: string;
  outcomeLabel: string;
  shares: string;
  avgPrice: string;
  price: string;
  realizedPnl: string;
  won: boolean | null;
  settledAt: string | null;
}

export default function PositionsPage() {
  const { me, loading } = useSession();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getToken() === null) return;
    void authed<Position[]>('/me/positions?all=1')
      .then(setPositions)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'could not load your positions'),
      );
  }, []);

  const { open, settled, totals } = useMemo(() => split(positions ?? []), [positions]);

  if (!loading && me === null) {
    return (
      <PageShell>
        <p className="text-base text-text-muted">
          <Link href="/login" className="font-semibold text-brand underline">
            Log in
          </Link>{' '}
          to see your positions.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageTitle
        title="Positions"
        blurb="Everything you are holding, and everything that has settled."
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Total label="Staked in open markets" value={money(totals.staked)} />
        <Total
          label="Now worth"
          value={money(totals.value)}
          note="At today’s prices. Selling returns this less the exit fee."
        />
        <Total
          label="Settled profit"
          value={money(totals.realized)}
          tone={Number.parseFloat(totals.realized) >= 0 ? 'up' : 'down'}
          note="Already in your balance."
        />
      </div>

      {error !== null && (
        <p role="alert" className="mt-4 rounded-md bg-fall-bg px-3 py-2 text-sm text-fall">
          {error}
        </p>
      )}

      {positions === null && error === null && (
        <p className="mt-4 text-sm text-text-muted">Loading…</p>
      )}

      {positions !== null && positions.length === 0 && (
        <p className="mt-6 rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-muted">
          Nothing yet.{' '}
          <Link href="/" className="font-semibold text-brand underline">
            Find a market
          </Link>{' '}
          and your first stake will show up here the moment it fills.
        </p>
      )}

      {open.length > 0 && (
        <section className="mt-8">
          <h2 className="text-md font-bold">Open</h2>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {open.map((position) => (
              <OpenRow key={`${position.marketId}:${position.outcomeId}`} position={position} />
            ))}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section className="mt-8">
          <h2 className="text-md font-bold">Settled</h2>
          <p className="text-sm text-text-muted">
            What each one paid, straight from the market that settled it.
          </p>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {settled.map((position) => (
              <SettledRow key={`${position.marketId}:${position.outcomeId}`} position={position} />
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}

/**
 * Open, settled, and the three totals.
 *
 * A position on a resolved market is settled even if shares remain on the row
 * — payout does not delete the position, so `shares > 0` is not the test.
 * `won === null` is: it means nothing has decided this one yet.
 */
function split(positions: Position[]) {
  const open = positions.filter(
    (position) => position.won === null && Number.parseFloat(position.shares) > 0,
  );
  const settled = positions
    .filter((position) => position.won !== null)
    .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''));

  const staked = open.reduce(
    (sum, position) =>
      sum + Number.parseFloat(position.shares) * Number.parseFloat(position.avgPrice),
    0,
  );
  const value = open.reduce(
    (sum, position) => sum + Number.parseFloat(position.shares) * Number.parseFloat(position.price),
    0,
  );
  const realized = positions.reduce(
    (sum, position) => sum + Number.parseFloat(position.realizedPnl),
    0,
  );

  return {
    open,
    settled,
    totals: { staked: staked.toFixed(2), value: value.toFixed(2), realized: realized.toFixed(2) },
  };
}

function Total({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'up' | 'down';
}) {
  return (
    <div className="rounded-xl border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-[.05em] text-text-muted">{label}</p>
      <p
        className={`mt-1 font-mono text-2xl font-bold tabular-nums ${
          tone === 'up' ? 'text-money' : tone === 'down' ? 'text-fall' : ''
        }`}
      >
        {value}
      </p>
      {note !== undefined && <p className="mt-1 text-sm text-text-muted">{note}</p>}
    </div>
  );
}

function OpenRow({ position }: { position: Position }) {
  const shares = Number.parseFloat(position.shares);
  const cost = shares * Number.parseFloat(position.avgPrice);
  const value = shares * Number.parseFloat(position.price);
  const change = cost === 0 ? 0 : (value - cost) / cost;
  const up = value >= cost;

  return (
    <li>
      <Link
        href={`/market/${position.marketId}`}
        className="flex items-start justify-between gap-4 p-4 hover:bg-chip"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold">{position.marketQuestion}</span>
          <span className="mt-0.5 block text-sm text-text-muted">
            {/*
              Percent, not kobo. `kobo()` renders "62k", which is right in the
              trade sheet where the surrounding words say kobo — and reads as
              ₦62,000 here, sitting inline beside ₦880.79 and ₦266.60. It also
              lets the entry price be compared directly with the "now 71%"
              underneath it, which is the comparison somebody is making.
            */}
            {shares.toFixed(2)} shares of{' '}
            <span className="font-semibold text-text">{position.outcomeLabel}</span> at{' '}
            {Math.round(percent(position.avgPrice))}%
            {position.marketState !== 'active' && (
              <span className="ml-2 rounded-full bg-chip px-1.5 py-0.5 font-mono text-xs">
                {position.marketState}
              </span>
            )}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-mono text-base font-bold tabular-nums">
            {exactMoney(value.toFixed(2))}
          </span>
          <span
            className={`block font-mono text-sm tabular-nums ${up ? 'text-money' : 'text-fall'}`}
          >
            {up ? '+' : ''}
            {Math.round(change * 100)}%
          </span>
          <span className="mt-0.5 block font-mono text-xs text-text-muted">
            now {Math.round(percent(position.price))}%
          </span>
        </span>
      </Link>
    </li>
  );
}

/**
 * A settled row.
 *
 * §7.4: "losses get quiet dignity — result shown plainly, no shame
 * animations." A loss is a grey line saying what happened, not a red one
 * saying it louder.
 */
function SettledRow({ position }: { position: Position }) {
  const won = position.won === true;

  return (
    <li>
      <Link
        href={`/market/${position.marketId}`}
        className="flex items-start justify-between gap-4 p-4 hover:bg-chip"
      >
        <span className="min-w-0">
          <span className="block text-base font-semibold">{position.marketQuestion}</span>
          <span className="mt-0.5 block text-sm text-text-muted">
            You were on {position.outcomeLabel} · {won ? 'it came in' : 'it did not'}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span
            className={`block font-mono text-base font-bold tabular-nums ${
              won ? 'text-money' : 'text-text-muted'
            }`}
          >
            {Number.parseFloat(position.realizedPnl) >= 0 ? '+' : ''}
            {exactMoney(position.realizedPnl)}
          </span>
        </span>
      </Link>
    </li>
  );
}

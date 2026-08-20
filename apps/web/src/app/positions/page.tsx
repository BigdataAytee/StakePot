'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { PageShell, PageTitle } from '@/components/market/page-shell';
import { Sparkline } from '@/components/sparkline';
import { exactMoney, money, percent } from '@/lib/format';
import { authed, getToken, useSession } from '@/lib/session';

/**
 * §7.1's portfolio: "open positions with live P&L, closed history, pending
 * payouts."
 *
 * The screen answers one question — how am I doing — and it has to answer it in
 * the top eighty pixels, because that is the whole reason somebody opens it.
 * Everything below is the working: which holdings, at what price, moving which
 * way.
 *
 * Three figures are kept carefully apart, because collapsing them is how a
 * screen like this starts lying:
 *
 *   **Available** is money. It is in the wallet and it will still be there
 *   tomorrow whatever the market does.
 *
 *   **In positions** is a mark-to-market at the live price. Selling would
 *   return that *less the early-exit fee*, and a settled market may return
 *   nothing at all. It is an estimate and is labelled as one.
 *
 *   **Realised** is history: what settled positions actually paid.
 *
 * Total portfolio value is the first two added together, which is the honest
 * sum — it is what the account is worth right now if prices froze, not what it
 * is worth guaranteed.
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
  settlesAt: string;
  /** Where this outcome's price stood 24h ago; null on a younger market. */
  price24hAgo: string | null;
  change24h: number | null;
  series: { t: number; p: number }[];
}

export default function PortfolioPage() {
  const { me, loading } = useSession();
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getToken() === null) return;
    void authed<Position[]>('/me/positions?all=1')
      .then(setPositions)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'could not load your portfolio'),
      );
  }, []);

  const available = Number.parseFloat(me?.available ?? '0');
  const { open, settled, totals } = useMemo(
    () => split(positions ?? [], available),
    [positions, available],
  );

  if (!loading && me === null) {
    return (
      <PageShell>
        <p className="text-base text-text-muted">
          <Link href="/login" className="font-semibold text-brand underline">
            Log in
          </Link>{' '}
          to see your portfolio.
        </p>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageTitle
        title="Portfolio"
        blurb="Everything you are holding, what it is worth, and what has settled."
      />

      {/* The answer, before the working. */}
      <section className="rounded-xl border border-border bg-surface-raised p-4">
        <p className="text-xs font-semibold uppercase tracking-[.06em] text-text-muted">
          Total portfolio value
        </p>
        <p className="mt-1 font-mono text-[32px] font-bold leading-none">
          {exactMoney(totals.total)}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-sm">
          <Delta label="Today" value={totals.today} />
          <Delta label="All time" value={totals.allTime} />
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
          <Split label="Available" value={money(available)} note="Yours to trade with." />
          <Split
            label="In positions"
            value={money(totals.marked)}
            note="At today’s prices, before the exit fee."
          />
        </dl>
      </section>

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
          No positions yet — take your first position on a market you have a view on.
          <br />
          <Link href="/" className="mt-2 inline-block font-semibold text-brand underline">
            Find a market
          </Link>
        </p>
      )}

      {open.length > 0 && (
        <section className="mt-8">
          <h2 className="text-md font-bold">Holdings</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {open.map((position) => (
              <Holding key={`${position.marketId}:${position.outcomeId}`} position={position} />
            ))}
          </ul>
        </section>
      )}

      {settled.length > 0 && (
        <section className="mt-8">
          <h2 className="text-md font-bold">Closed</h2>
          <p className="text-sm text-text-muted">
            What each one paid, straight from the market that settled it.
          </p>
          <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {settled.map((position) => (
              <ClosedRow key={`${position.marketId}:${position.outcomeId}`} position={position} />
            ))}
          </ul>
        </section>
      )}
    </PageShell>
  );
}

/**
 * One holding.
 *
 * A row, not a table cell, because at 390px a seven-column table is a
 * horizontal scrollbar with data hidden inside it. The figures are stacked in
 * the order somebody reads them: what it is, what it is doing, what it cost.
 *
 * The whole row links to the market with the sheet already in sell mode —
 * looking at a losing position and wanting out of it is one gesture, and making
 * it two is how somebody ends up holding it.
 */
function Holding({ position }: { position: Position }) {
  const shares = Number.parseFloat(position.shares);
  const avg = Number.parseFloat(position.avgPrice);
  const now = Number.parseFloat(position.price);
  const cost = shares * avg;
  const value = shares * now;
  const pnl = value - cost;
  const yes = /^yes$/i.test(position.outcomeLabel);
  const no = /^no$/i.test(position.outcomeLabel);

  return (
    <li className="rounded-xl border border-border bg-surface-raised p-3.5 transition-shadow hover:shadow-soft">
      <Link href={`/market/${position.marketId}?sell=${position.outcomeId}`} className="block">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-base font-semibold leading-snug">
              {position.marketQuestion}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span
                className={`rounded-sm px-1.5 py-0.5 font-bold ${
                  yes
                    ? 'bg-rise-bg text-rise'
                    : no
                      ? 'bg-fall-bg text-fall'
                      : 'bg-chip text-text-muted'
                }`}
              >
                {position.outcomeLabel.toUpperCase()}
              </span>
              <span className="font-mono">{shares.toFixed(2)} shares</span>
              <span aria-hidden>·</span>
              <span>
                avg <span className="font-mono">{Math.round(percent(avg))}%</span>
              </span>
              <span aria-hidden>·</span>
              <span>
                now <span className="font-mono">{Math.round(percent(now))}%</span>
              </span>
            </p>
          </div>

          <Sparkline points={position.series.map((point) => String(point.p))} width={64} />
        </div>

        <div className="mt-2.5 flex items-end justify-between gap-3 border-t border-border pt-2.5">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted">
              Value now
            </p>
            <p className="font-mono text-md font-bold">{money(value)}</p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[.05em] text-text-muted">
              Unrealised
            </p>
            <p className={`font-mono text-md font-bold ${pnl >= 0 ? 'text-rise' : 'text-fall'}`}>
              {pnl >= 0 ? '+' : '−'}
              {money(Math.abs(pnl))}
            </p>
          </div>
        </div>
      </Link>
    </li>
  );
}

function ClosedRow({ position }: { position: Position }) {
  const realised = Number.parseFloat(position.realizedPnl);
  return (
    <li className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <Link
          href={`/market/${position.marketId}`}
          className="line-clamp-2 text-sm font-semibold hover:underline"
        >
          {position.marketQuestion}
        </Link>
        <p className="mt-0.5 text-xs text-text-muted">
          {position.outcomeLabel.toUpperCase()} ·{' '}
          {position.won === true ? 'settled in your favour' : 'settled against you'}
        </p>
      </div>
      <p
        className={`shrink-0 font-mono text-sm font-bold ${
          realised >= 0 ? 'text-rise' : 'text-fall'
        }`}
      >
        {realised >= 0 ? '+' : '−'}
        {money(Math.abs(realised))}
      </p>
    </li>
  );
}

/**
 * Split open from closed, and work out the four headline figures.
 *
 * A position on a resolved market is closed even if shares remain on the row —
 * payout does not delete the position, so `shares > 0` is not the test.
 * `won === null` is: it means nothing has decided this one yet.
 */
function split(positions: Position[], available: number) {
  const open = positions.filter(
    (position) => position.won === null && Number.parseFloat(position.shares) > 0,
  );
  const settled = positions
    .filter((position) => position.won !== null)
    .sort((a, b) => (b.settledAt ?? '').localeCompare(a.settledAt ?? ''));

  const sum = (rows: Position[], of: (row: Position) => number) =>
    rows.reduce((total, row) => total + of(row), 0);

  const shares = (row: Position) => Number.parseFloat(row.shares);
  const marked = sum(open, (row) => shares(row) * Number.parseFloat(row.price));
  const cost = sum(open, (row) => shares(row) * Number.parseFloat(row.avgPrice));

  /*
   * Today's move on the open book.
   *
   * Priced against where each holding stood 24h ago, and holdings younger than
   * that contribute nothing rather than their whole gain — a position opened an
   * hour ago has not "made" its entire unrealised profit today, and counting it
   * as though it had would make the figure meaningless on exactly the day
   * somebody trades most.
   */
  const today = sum(open, (row) =>
    row.price24hAgo === null
      ? 0
      : shares(row) * (Number.parseFloat(row.price) - Number.parseFloat(row.price24hAgo)),
  );

  /*
   * All-time P&L is realised plus unrealised — what has been banked and what is
   * still riding. Realised is summed over every position, open ones included:
   * selling part of a holding banks a result without closing it.
   */
  const realised = sum(positions, (row) => Number.parseFloat(row.realizedPnl));

  return {
    open,
    settled,
    totals: {
      total: (available + marked).toFixed(2),
      marked: marked.toFixed(2),
      today: today.toFixed(2),
      allTime: (realised + (marked - cost)).toFixed(2),
    },
  };
}

/** A signed figure with the arrow that says which way, for a glance. */
function Delta({ label, value }: { label: string; value: string }) {
  const amount = Number.parseFloat(value);
  const up = amount >= 0;
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-text-muted">{label}</span>
      <span className={`font-mono font-bold ${up ? 'text-rise' : 'text-fall'}`}>
        <span aria-hidden>{up ? '▲' : '▼'}</span> {up ? '+' : '−'}
        {money(Math.abs(amount))}
      </span>
    </span>
  );
}

function Split({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-mono text-md font-bold">{value}</dd>
      <dd className="text-xs text-text-muted">{note}</dd>
    </div>
  );
}

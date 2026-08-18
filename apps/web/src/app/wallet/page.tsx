'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AppHeader } from '@/components/app-header';
import { dateTime, exactMoney, money } from '@/lib/format';
import { authed, getToken, useSession } from '@/lib/session';

interface HistoryRow {
  id: string;
  type: string;
  amount: string;
  createdAt: string;
  marketId: string | null;
  marketQuestion: string | null;
  ref: string | null;
}

/**
 * §2.16d — "available vs escrowed ('in open markets'), full transaction history
 * (stakes, wins, exits, fees, deposits, withdrawals — from the ledger, so it's
 * complete by construction)".
 *
 * Every row here is a ledger row. Nothing is summarised, derived or rounded for
 * display beyond the money formatter, because the point of showing somebody
 * their history is that it agrees with the books to the kobo.
 */
const LABELS: Record<string, string> = {
  signup_bonus: 'Bonus',
  trade_buy: 'Stake',
  trade_sell: 'Early exit',
  stake: 'Stake',
  seed: 'Seed',
  payout: 'Winnings',
  refund: 'Refund',
  fee_platform: 'Platform fee',
  fee_creator: 'Creator fee',
  bond_post: 'Bond posted',
  bond_refund: 'Bond returned',
  bond_forfeit: 'Bond forfeited',
  prize: 'Prize',
  adjustment: 'Adjustment',
};

export default function WalletPage() {
  const { me, loading } = useSession();
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (getToken() === null) return;
    void authed<HistoryRow[]>('/me/wallet/history')
      .then(setHistory)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'could not load your history'),
      );
  }, []);

  if (!loading && me === null) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <AppHeader />
        <p className="text-md text-text-muted">
          <Link href="/login" className="font-bold underline">
            Log in
          </Link>{' '}
          to see your wallet.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <AppHeader />

      <h1 className="text-2xl font-black leading-none">Wallet</h1>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <p className="font-mono text-xs uppercase tracking-widest text-text-muted">Available</p>
          <p className="mt-1.5 font-mono text-2xl font-black tabular-nums text-money">
            {me === null ? '—' : money(me.available)}
          </p>
          <p className="mt-1 text-sm text-text-muted">Yours to stake or hold.</p>
        </div>
        <div className="rounded-lg border border-border bg-surface-raised p-4">
          <p className="font-mono text-xs uppercase tracking-widest text-text-muted">
            In open markets
          </p>
          <p className="mt-1.5 font-mono text-2xl font-black tabular-nums">
            {me === null ? '—' : money(me.escrowed)}
          </p>
          <p className="mt-1 text-sm text-text-muted">Held in escrow until those markets settle.</p>
        </div>
      </div>

      <h2 className="mt-10 text-lg font-bold">History</h2>
      <p className="mb-4 text-sm text-text-muted">
        Every money event on your account, straight from the ledger.
      </p>

      {error !== null && (
        <p
          role="alert"
          className="rounded-md border border-fall bg-surface-raised px-3 py-2 text-sm text-fall"
        >
          {error}
        </p>
      )}

      {history === null && error === null && (
        <p className="font-mono text-sm text-text-muted">Loading…</p>
      )}

      {history !== null && history.length === 0 && (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-text-muted">
          Nothing here yet. Your first stake will show up the moment it fills.
        </p>
      )}

      {history !== null && history.length > 0 && (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-raised">
          {history.map((row) => {
            const credit = !row.amount.startsWith('-');
            return (
              <li key={row.id} className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="text-md font-bold">{labelFor(row)}</p>
                  {row.marketQuestion !== null && row.marketId !== null && (
                    <Link
                      href={`/market/${row.marketId}`}
                      className="mt-0.5 block truncate text-sm text-text-muted underline"
                    >
                      {row.marketQuestion}
                    </Link>
                  )}
                  <p className="mt-0.5 font-mono text-xs text-text-muted">
                    {dateTime(row.createdAt)}
                  </p>
                </div>
                <span
                  className={`shrink-0 font-mono text-md font-black tabular-nums ${
                    credit ? 'text-money' : 'text-text'
                  }`}
                >
                  {credit ? '+' : ''}
                  {exactMoney(row.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

/**
 * The row's name.
 *
 * `signup_bonus` covers both the starter balance and the Tier 1 verification
 * bonus, so on a new account the history showed two identical "Bonus" lines
 * for two different things. The ledger already distinguishes them by ref —
 * the screen just was not reading it.
 */
function labelFor(row: HistoryRow): string {
  if (row.type === 'signup_bonus') {
    if (row.ref?.startsWith('tier1-bonus:') === true) return 'Verification bonus';
    if (row.ref?.startsWith('signup:') === true) return 'Starter balance';
  }
  return LABELS[row.type] ?? row.type;
}

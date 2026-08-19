'use client';

import { useEffect, useState } from 'react';

import { API_URL, type MarketDetail } from '@/lib/api';
import { exactMoney, kobo, money } from '@/lib/format';
import { getToken } from '@/lib/session';

/**
 * §7.2g's receipt — what the pot became, and what it became for you.
 *
 * The product's whole pitch is receipts, and until now a resolved market
 * showed a state label: the payout math rendered for *sharing*
 * (`/api/result/[id]`) but never for the person who actually won it. This is
 * that panel, in the app, where they are.
 *
 * Every figure comes from the ledger via `GET /markets/:id/receipt` rather
 * than being recomputed here. That is deliberate: a receipt is the thing
 * somebody screenshots and argues with, so the number on it must be the number
 * that moved their balance, not a second opinion about it.
 */
interface Receipt {
  outcomeLabel: string | null;
  distributed: string;
  fee: string;
  perShare: string;
  winningShares: string;
  you: { shares: string; payout: string; won: boolean } | null;
}

export function ResolvedReceipt({ market }: { market: MarketDetail }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  useEffect(() => {
    if (market.state !== 'resolved') return undefined;
    let cancelled = false;
    const token = getToken();

    void fetch(`${API_URL}/markets/${market.id}/receipt`, {
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((found: Receipt | null) => {
        if (!cancelled) setReceipt(found);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [market.id, market.state]);

  if (market.state !== 'resolved' || receipt === null) return null;

  const you = receipt.you;

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-border">
      <header className="flex items-center gap-2 border-b border-border bg-rise-bg px-4 py-3">
        <CheckIcon />
        <h2 className="text-md font-bold text-rise">
          {receipt.outcomeLabel ?? 'Resolved'}
          <span className="font-medium"> won this market</span>
        </h2>
      </header>

      <dl className="px-4 py-3">
        <Line label="Pot distributed" value={money(receipt.distributed)} />
        <Line label="Fee" value={money(receipt.fee)} />
        <Line
          label="Per winning share"
          value={`${kobo(receipt.perShare)} · ${exactMoney(receipt.perShare)}`}
        />
      </dl>

      {you !== null && (
        <div
          className={`border-t border-border px-4 py-3 ${you.won ? 'bg-rise-bg/40' : 'bg-chip'}`}
        >
          {you.won ? (
            <>
              <p className="text-sm text-text-muted">
                You held{' '}
                <span className="font-mono font-semibold text-text">
                  {Number.parseFloat(you.shares).toFixed(2)}
                </span>{' '}
                shares of {receipt.outcomeLabel}.
              </p>
              <p className="mt-1 text-xl font-bold text-money">{exactMoney(you.payout)}</p>
              <p className="text-sm text-text-muted">paid into your balance</p>
            </>
          ) : (
            // §7.4: "losses get quiet dignity — result shown plainly, no shame
            // animations." No red, no exclamation, one line.
            <p className="text-sm text-text-muted">
              You were on the other side of this one. Nothing was paid out on your position.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1 text-sm">
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className="size-4 shrink-0">
      <circle cx="10" cy="10" r="9" className="fill-rise" />
      <path
        d="M6 10.5l2.5 2.5L14 7.5"
        fill="none"
        className="stroke-paper"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

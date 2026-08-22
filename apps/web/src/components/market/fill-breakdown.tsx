'use client';

import { useEffect, useState } from 'react';

import type { TradeQuote } from '@/lib/api';
import { quoteTrade } from '@/lib/orderbook-api';
import { money } from '@/lib/format';

/** How long the amount has to stop changing before a quote is asked for. */
const SETTLE_MS = 250;

/**
 * What this trade would actually do, split by where it fills.
 *
 * The single most important thing on the trade sheet, and the reason it is a
 * component rather than a line: **matched and pot are different promises.**
 *
 *   - Matched pays ₦1 a share, exactly, out of money a counterparty has
 *     already escrowed. The number is known now and cannot move.
 *   - Pot pays a share of a pot that is still filling. The number is an
 *     estimate and will change as other people trade.
 *
 * Rolled into one figure they read as the same kind of promise, and the person
 * finding out otherwise finds out at settlement. So the two legs get their own
 * rows, their own words — *exact* against *estimate* — and their own colour
 * weight, and the estimate never appears without the word.
 */
export function FillBreakdown({
  marketId,
  outcomeId,
  amount,
  limitKobo,
  /** Rendered only for buys; a pot sell has no counterparty to match against. */
  active,
  onSplit,
}: {
  marketId: string;
  outcomeId: string;
  amount: string;
  limitKobo: number | null;
  active: boolean;
  /**
   * Told whenever the answer changes, so the sheet can stand down its own
   * pot-only summary.
   *
   * Two numbers for one trade is worse than one wrong number, and the panel
   * above this was built when the pot was the only place a trade could go —
   * its "shares you get" is the pot leg alone. Rather than teach it to split,
   * it is silenced whenever this component has the fuller answer.
   */
  onSplit?: (split: boolean) => void;
}) {
  const [quote, setQuote] = useState<TradeQuote | null>(null);

  useEffect(() => {
    const value = Number.parseFloat(amount);
    if (!active || !Number.isFinite(value) || value <= 0) {
      setQuote(null);
      return undefined;
    }

    // Debounced: the amount changes on every keystroke and every chip, and a
    // quote per keystroke is a request per keystroke on a money screen.
    let live = true;
    const timer = window.setTimeout(() => {
      void quoteTrade({ marketId, outcomeId, amount, limitKobo }).then((next) => {
        if (live) setQuote(next);
      });
    }, SETTLE_MS);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [marketId, outcomeId, amount, limitKobo, active]);

  const legs =
    quote === null ? 0 : [quote.matched, quote.pot, quote.resting].filter((l) => l !== null).length;
  // Shown when there is more than one leg, or when anything at all would rest —
  // a trade that is entirely a pot fill needs no table telling it so, but one
  // that will not fill today most certainly does.
  const split = quote !== null && (legs > 1 || quote.resting !== null || quote.matched !== null);

  useEffect(() => {
    onSplit?.(split);
  }, [split, onSplit]);

  if (quote === null || !split) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-border bg-surface">
      <ul className="divide-y divide-border text-note">
        {quote.matched !== null && (
          <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
            <span className="font-mono font-bold tabular-nums">{money(quote.matched.cost)}</span>
            <span className="text-text-muted">
              matching{quote.matched.priceKobo === null ? '' : ` at ${quote.matched.priceKobo}k`}
            </span>
            <span className="ml-auto whitespace-nowrap">
              <b className="font-mono tabular-nums text-rise">{money(quote.matched.exactPayout)}</b>{' '}
              <span className="text-fine font-semibold uppercase tracking-[.04em] text-rise">
                exact
              </span>
            </span>
          </li>
        )}

        {quote.pot !== null && (
          <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
            <span className="font-mono font-bold tabular-nums">{money(quote.pot.cost)}</span>
            <span className="text-text-muted">
              from the pot
              {quote.pot.averageKobo === null ? '' : ` at ~${quote.pot.averageKobo}k`}
            </span>
            <span className="ml-auto whitespace-nowrap">
              <b className="font-mono tabular-nums">{money(quote.pot.shares)}</b>{' '}
              <span className="text-fine font-semibold uppercase tracking-[.04em] text-text-muted">
                estimate
              </span>
            </span>
          </li>
        )}

        {quote.resting !== null && (
          <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2">
            <span className="font-mono font-bold tabular-nums">{money(quote.resting.locked)}</span>
            <span className="text-text-muted">
              rests at {quote.resting.priceKobo}k until somebody takes it
            </span>
          </li>
        )}
      </ul>

      {/*
        Said once, under the rows, rather than as a tooltip on each. The
        distinction is the whole point of the panel and it should not be
        something a reader has to go looking for.
      */}
      <p className="border-t border-border px-3 py-1.5 text-fine text-text-muted">
        {quote.matched !== null && quote.pot !== null
          ? 'Matched pays exactly ₦1 a share from your counterparty’s stake. The pot pays a share of the pot, so that figure moves.'
          : quote.matched !== null
            ? 'Matched pays exactly ₦1 a share from your counterparty’s stake.'
            : 'A pot payout is a share of the pot, so it moves as others trade.'}
      </p>

      {quote.warnings.map((warning) => (
        <p
          key={warning}
          className="border-t border-border bg-caution-bg px-3 py-2 text-fine text-caution"
        >
          {warning}
        </p>
      ))}
    </div>
  );
}

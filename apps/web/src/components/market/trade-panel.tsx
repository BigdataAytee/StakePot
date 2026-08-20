'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import type { MarketDetail, OutcomeView } from '@/lib/api';
import { closedReason, exactMoney, kobo, money, percent } from '@/lib/format';
import { binaryPair } from '@/lib/home';
import { rememberTrade, signInHref } from '@/lib/pending-trade';
import { placeTrade } from '@/lib/place-trade';
import { blockerFor, useTradeAllowance } from '@/lib/trade-allowance';
import { usePublicConfig } from '@/lib/public-config';
import { getToken } from '@/lib/session';
import { quote } from '@/lib/trade-quote';

/** Additive quick-adds, as the reference has them, plus everything you hold. */
const QUICK = [500, 1000, 5000];

/**
 * The detail page's trade panel — the reference's `.tradebox`.
 *
 * It sits in the right column and sticks below the header, because on this
 * page the chart is what you read and the panel is what you act on, and
 * scrolling the argument should not scroll away the thing that lets you answer
 * it.
 *
 * A Yes/No market gets the two-sided toggle. Anything else does not: in a
 * multi-outcome market the outcomes sum to 1 and there is no "No" share to
 * buy, so the side is chosen by picking a candidate from the list beside this
 * panel, and this shows what backing that candidate costs.
 */
export function TradePanel({
  market,
  outcome,
  livePrices,
  onPick,
  onFilled,
}: {
  market: MarketDetail;
  outcome: OutcomeView;
  livePrices: Record<string, string>;
  onPick: (outcome: OutcomeView) => void;
  onFilled: () => void;
}) {
  const config = usePublicConfig();
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(getToken());
  }, []);

  const binary = binaryPair(market);
  const price = Number.parseFloat(livePrices[outcome.id] ?? outcome.price);
  const closed = market.state !== 'active';

  const preview = useMemo(
    () =>
      quote({
        market,
        outcome,
        side: 'buy',
        amount,
        price,
        exitFeeRate: config?.exitFeeRate ?? 0,
      }),
    [market, outcome, amount, price, config],
  );

  // §7.2d/§2.12: the same limits the sheet surfaces, on the panel that does
  // the same job on a laptop.
  const allowance = useTradeAllowance();
  const blocker = blockerFor(allowance, amount, money);

  const tone = /^yes$/i.test(outcome.label)
    ? 'bg-rise'
    : /^no$/i.test(outcome.label)
      ? 'bg-fall'
      : 'bg-brand';

  function add(step: number) {
    const current = Number.parseFloat(amount);
    setAmount(String(Math.round(((Number.isFinite(current) ? current : 0) + step) * 100) / 100));
  }

  /** Same dead end the sheet had, and the same way out of it. */
  function signIn(route: '/login' | '/signup'): void {
    const pending = { marketId: market.id, outcomeId: outcome.id, amount };
    rememberTrade(pending);
    router.push(signInHref(pending, route));
  }

  async function submit() {
    if (token === null) {
      signIn('/login');
      return;
    }
    if (preview === null) return;
    setSubmitting(true);
    setQueued(false);
    setError(null);
    try {
      await placeTrade({
        marketId: market.id,
        outcomeId: outcome.id,
        side: 'buy',
        amount,
        token,
        reason,
        onQueued: () => setQueued(true),
      });
      setAmount('');
      setReason('');
      onFilled();
      router.refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
      setQueued(false);
    }
  }

  return (
    <aside
      // Named the same way the sheet is. They are the two halves of one
      // control — the same trade, drawn for the screen that is asking — and
      // anything reaching for "the trade surface" should not have to know
      // which viewport it is on.
      aria-label={`Trade ${outcome.label}`}
      className="hidden rounded-xl bg-chip p-4 min-[860px]:sticky min-[860px]:top-[76px] min-[860px]:block"
    >
      <p className="mb-2.5 text-[13.5px] font-semibold">{outcome.label}</p>

      {binary !== null && (
        <div className="mb-2.5 flex gap-2">
          {binary.map((side) => {
            const on = side.id === outcome.id;
            const yes = /^yes$/i.test(side.label);
            return (
              <button
                key={side.id}
                type="button"
                onClick={() => onPick(side)}
                aria-pressed={on}
                className={`flex-1 rounded-md border py-2.5 text-center text-base font-bold transition-colors ${
                  on
                    ? yes
                      ? 'border-rise bg-rise text-paper'
                      : 'border-fall bg-fall text-paper'
                    : 'border-border bg-surface text-text-muted hover:text-text'
                }`}
              >
                {side.label} {kobo(livePrices[side.id] ?? side.price)}
              </button>
            );
          })}
        </div>
      )}

      {closed ? (
        <p className="rounded-md bg-surface p-3 text-sm text-text-muted">
          {closedReason(market.state, market.fundingClosesAt)}
        </p>
      ) : (
        <>
          <div className="mb-2.5 flex items-center gap-2">
            <label className="sr-only" htmlFor="panel-amount">
              How much are you putting in?
            </label>
            <div className="relative min-w-0 flex-1">
              <input
                id="panel-amount"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
                placeholder="₦0"
                className="h-[42px] w-full rounded-lg border border-border bg-surface px-3 pr-9 font-mono text-lg font-semibold outline-none focus:border-brand"
              />
              {amount !== '' && (
                <button
                  type="button"
                  onClick={() => setAmount('')}
                  aria-label="Clear the amount"
                  className="absolute right-0.5 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-md text-text-muted hover:bg-chip hover:text-text"
                >
                  ×
                </button>
              )}
            </div>
            {QUICK.map((step) => (
              <button
                key={step}
                type="button"
                onClick={() => add(step)}
                className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs font-semibold text-text-muted transition-transform hover:border-text hover:text-text active:scale-press"
              >
                +{step >= 1000 ? `${step / 1000}k` : step}
              </button>
            ))}
          </div>

          <div className="mb-1 flex justify-between text-sm text-text-muted">
            <span>Price per share</span>
            <span className="font-mono">
              {kobo(price)} · {Math.round(percent(price))}%
            </span>
          </div>
          <div className="mb-1 flex justify-between text-sm text-text-muted">
            <span>Shares you get</span>
            <span className="font-mono">{preview === null ? '—' : preview.shares.toFixed(2)}</span>
          </div>
          <div className="mb-1 flex justify-between text-sm text-text-muted">
            <span>Payout if correct</span>
            <b className="font-mono text-base text-money">
              {preview?.estWin == null ? '—' : exactMoney(preview.estWin)}
            </b>
          </div>

          {preview !== null && Math.abs(preview.priceAfter - price) > 0.005 && (
            <p className="mt-2 text-sm text-text-muted">
              This trade moves {outcome.label} to{' '}
              <span className="font-mono">{Math.round(percent(preview.priceAfter))}%</span>.
            </p>
          )}

          {/* §2.15a's reason prompt — optional, one line, and it posts to the
              thread under your name with the position attached. */}
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            aria-label="Why? Optional, posts to the thread"
            placeholder="Why? One line, optional."
            className="mt-2.5 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
          />

          {blocker !== null && (
            <p
              className={`mt-2 rounded-md px-3 py-2 text-sm ${
                blocker.hard ? 'bg-fall-bg text-fall' : 'bg-surface text-text-muted'
              }`}
            >
              {blocker.message}
            </p>
          )}

          {error !== null && <p className="mt-2 text-sm text-fall">{error}</p>}

          {token === null && (
            <p className="mt-2 rounded-md bg-surface px-3 py-2 text-sm text-text-muted">
              You need an account to stake.{' '}
              <button
                type="button"
                onClick={() => signIn('/login')}
                className="font-bold text-brand underline"
              >
                Sign in
              </button>{' '}
              or{' '}
              <button
                type="button"
                onClick={() => signIn('/signup')}
                className="font-bold text-brand underline"
              >
                create one
              </button>
              . We&apos;ll bring you back here with this amount ready.
            </p>
          )}

          {/* Same sentence, same place, on the surface a laptop uses. */}
          <p className="mt-2 text-xs leading-snug text-text-muted">
            Positions can lose their full value. Winners are paid from the pot.
          </p>

          <button
            type="button"
            onClick={() => void submit()}
            disabled={
              submitting || (token !== null && (preview === null || blocker?.hard === true))
            }
            className={`mt-2 w-full rounded-lg py-3 text-md font-bold text-paper transition-transform active:scale-press disabled:opacity-45 ${tone}`}
          >
            {token === null
              ? 'Sign in to stake'
              : queued
                ? 'Order placed — confirming…'
                : submitting
                  ? 'Placing…'
                  : preview === null
                    ? `Buy ${outcome.label}`
                    : `Buy ${outcome.label} · ${exactMoney(preview.total)}`}
          </button>
        </>
      )}
    </aside>
  );
}

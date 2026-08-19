'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpDown, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { OutcomeView } from '@/lib/api';

import { exactMoney, kobo, percent } from '@/lib/format';
import { placeTrade } from '@/lib/place-trade';
import { usePublicConfig } from '@/lib/public-config';
import { quote } from '@/lib/trade-quote';

/** The quick chips §7.2d specifies for amount-first entry. */
const AMOUNT_CHIPS = [500, 1000, 2000, 5000];

/**
 * What the sheet needs to quote a trade.
 *
 * Structural rather than `MarketDetail`, because the same sheet now opens from
 * the grid — where a card holds a summary — as well as from the ticket. Both
 * shapes carry these fields; asking for the detail would have meant fetching a
 * whole market to price a button somebody has already pressed.
 */
export interface TradeMarket {
  id: string;
  question: string;
  state: string;
  pot: string;
  liquidity: string;
  outcomes: OutcomeView[];
}

export interface TradeIntent {
  outcome: OutcomeView;
  side: 'buy' | 'sell';
  /** Shares held, when selling. */
  held?: string;
}

/**
 * §7.2d — the Trade Ticket.
 *
 * "Prices live on the buttons, and buying happens in a slide-up sheet — never a
 * bookmaker-style betslip page." Amount-first by default, because that is the
 * question our audience is actually answering: not "how many shares", but "how
 * much am I putting in".
 *
 * The figures beneath update as they type, including the slippage note, so the
 * price impact is stated before the trade rather than discovered after it.
 * There is one primary action and no limit-order controls: the formula always
 * fills.
 */
export function TradeSheet({
  market,
  intent,
  livePrices,
  token,
  onClose,
  onFilled,
}: {
  market: TradeMarket;
  intent: TradeIntent | null;
  livePrices: Record<string, string>;
  token: string | null;
  onClose: () => void;
  onFilled: () => void;
}) {
  const config = usePublicConfig();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [submitting, setSubmitting] = useState(false);
  /** The queue took it but has not executed it yet — §11's "order placed". */
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (intent === null) return;
    setSide(intent.side);
    setAmount('');
    setQueued(false);
    setError(null);
  }, [intent]);

  const outcome = intent?.outcome ?? null;
  const price = outcome === null ? 0 : Number.parseFloat(livePrices[outcome.id] ?? outcome.price);

  /**
   * The engine's closed form, run client-side purely to show the figures live:
   * Δ = L·ln((e^(m/L) − 1 + p)/p). The API recomputes everything server-side —
   * this never decides what a trade costs, only what the sheet says it will.
   */
  const preview = useMemo(
    () =>
      outcome === null
        ? null
        : quote({
            market,
            outcome,
            side,
            amount,
            price,
            exitFeeRate: config?.exitFeeRate ?? 0,
          }),
    [amount, price, side, market, outcome, config],
  );

  const closed = market.state !== 'active';

  // Yes is green, No is red, and anything else is the primary blue — the
  // reference's three cases. A candidate in a multi-outcome market is the
  // third: it is neither side of a yes/no question.
  const tone =
    outcome === null
      ? 'bg-brand'
      : /^yes$/i.test(outcome.label)
        ? 'bg-rise'
        : /^no$/i.test(outcome.label)
          ? 'bg-fall'
          : 'bg-brand';

  async function submit(): Promise<void> {
    if (outcome === null || preview === null) return;
    if (token === null) {
      setError('Sign in to trade.');
      return;
    }

    setSubmitting(true);
    setQueued(false);
    setError(null);
    try {
      await placeTrade({
        marketId: market.id,
        outcomeId: outcome.id,
        side,
        amount,
        token,
        reason,
        onQueued: () => setQueued(true),
      });
      onFilled();
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSubmitting(false);
      setQueued(false);
    }
  }

  return (
    <AnimatePresence>
      {intent !== null && outcome !== null && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-ink/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden
          />

          <motion.div
            role="dialog"
            aria-label={`Trade ${outcome.label}`}
            className="fixed inset-x-0 bottom-0 z-50 mx-auto max-w-lg rounded-t-xl border border-border bg-surface-raised p-5 shadow-lifted"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120) onClose();
            }}
          >
            <div className="mx-auto mb-4 h-1 w-10 rounded-sm bg-border" aria-hidden />

            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-text-muted">{market.question}</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-lg font-bold">
                    {side === 'buy' ? 'Buy' : 'Sell'} {outcome.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSide(side === 'buy' ? 'sell' : 'buy')}
                    className="rounded-sm border border-border p-1 text-text-muted hover:text-text"
                    aria-label="Switch between buying and selling"
                  >
                    <ArrowUpDown size={14} />
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="text-text-muted hover:text-text"
              >
                <X size={18} />
              </button>
            </div>

            <label className="block">
              <span className="text-sm text-text-muted">
                {side === 'buy' ? 'How much are you putting in?' : 'How many shares?'}
              </span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
                placeholder="0"
                disabled={closed}
                className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-3 font-mono text-xl tabular-nums outline-none focus:border-brand focus-visible:ring-1 focus-visible:ring-brand"
              />
            </label>

            {side === 'buy' && (
              <div className="mt-2 flex gap-2">
                {AMOUNT_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    disabled={closed}
                    onClick={() => setAmount(String(chip))}
                    className="flex-1 rounded-md border border-border bg-surface py-2 font-mono text-sm text-text-muted transition-colors hover:border-text hover:text-text active:scale-press"
                  >
                    ₦{chip >= 1000 ? `${chip / 1000}k` : chip}
                  </button>
                ))}
              </div>
            )}

            {side === 'sell' && intent.held !== undefined && (
              <div className="mt-2 flex gap-2">
                {[0.25, 0.5, 1].map((fraction) => (
                  <button
                    key={fraction}
                    type="button"
                    onClick={() =>
                      setAmount((Number.parseFloat(intent.held!) * fraction).toFixed(6))
                    }
                    className="flex-1 rounded-md border border-border bg-surface py-2 font-mono text-sm text-text-muted transition-colors hover:border-text hover:text-text active:scale-press"
                  >
                    {fraction === 1 ? 'All' : `${fraction * 100}%`}
                  </button>
                ))}
              </div>
            )}

            <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
              <Row
                label="Price per share"
                value={`${kobo(price)} · ${Math.round(percent(price))}%`}
              />
              {preview !== null && side === 'buy' && (
                <>
                  <Row label="Shares you get" value={preview.shares.toFixed(2)} />
                  <Row label="Total" value={exactMoney(preview.total)} emphasis />
                  {preview.estWin !== null && (
                    <Row
                      label="Est. to win"
                      value={exactMoney(preview.estWin)}
                      hint="estimate"
                      emphasis
                    />
                  )}
                </>
              )}
              {preview !== null && side === 'sell' && (
                <>
                  <Row label="Proceeds" value={exactMoney(preview.gross)} />
                  <Row
                    label={`Early-exit fee${
                      config === null ? '' : ` (${(config.exitFeeRate * 100).toFixed(0)}%)`
                    }`}
                    value={`−${exactMoney(preview.fee)}`}
                  />
                  <Row label="You receive" value={exactMoney(preview.total)} emphasis />
                </>
              )}
            </dl>

            {preview !== null && side === 'buy' && Math.abs(preview.priceAfter - price) > 0.005 && (
              <p className="mt-3 text-sm text-text-muted">
                This trade moves {outcome.label} to{' '}
                <span className="font-mono">{Math.round(percent(preview.priceAfter))}%</span>.
              </p>
            )}

            {/* §2.15a's reason prompt: "optional one-line 'why?' at trade time,
                feeding the thread — the best forecasting education new users
                can get." Optional and public, said plainly, because it posts
                under their name with the position attached. */}
            {side === 'buy' && !closed && (
              <div className="mt-4">
                <label className="block text-sm font-semibold" htmlFor="trade-reason">
                  Why? <span className="font-normal text-text-muted">(optional)</span>
                </label>
                <input
                  id="trade-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={500}
                  placeholder="One line. It goes on the thread with your position."
                  className="mt-1.5 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
                />
              </div>
            )}

            {error !== null && <p className="mt-3 text-sm text-fall">{error}</p>}

            <button
              type="button"
              onClick={() => void submit()}
              disabled={closed || submitting || preview === null}
              className={`mt-4 w-full rounded-lg py-3 text-md font-bold text-paper transition-transform active:scale-press disabled:opacity-45 ${tone}`}
            >
              {closed
                ? `Trading is ${market.state === 'resolved' ? 'over' : 'frozen'}`
                : queued
                  ? 'Order placed — confirming…'
                  : submitting
                    ? 'Placing…'
                    : side === 'buy'
                      ? 'Stake am'
                      : 'Sell shares'}
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function Row({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-text-muted">
        {label}
        {hint !== undefined && <span className="ml-1 text-xs">({hint})</span>}
      </dt>
      <dd className={`font-mono tabular-nums ${emphasis ? 'text-money' : ''}`}>{value}</dd>
    </div>
  );
}

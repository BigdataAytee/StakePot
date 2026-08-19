'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpDown, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { OutcomeView } from '@/lib/api';

import { exactMoney, kobo, money, percent } from '@/lib/format';
import { placeTrade } from '@/lib/place-trade';
import { blockerFor, useTradeAllowance } from '@/lib/trade-allowance';
import { usePublicConfig } from '@/lib/public-config';
import { costOfShares, quote } from '@/lib/trade-quote';

/** The quick chips §7.2d specifies for amount-first entry. */
const AMOUNT_CHIPS = [500, 1000, 2000, 5000];

/** §7.2d's shares-entry steppers, for the advanced mode. */
const SHARE_STEPS = [-100, -10, 10, 100];

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
  /**
   * §7.2d's advanced toggle. Amount-first is the default because "how much am
   * I putting in" is the question this audience is actually answering; shares
   * -first is for the reader who is pricing the position instead.
   */
  const [mode, setMode] = useState<'amount' | 'shares'>('amount');
  const [submitting, setSubmitting] = useState(false);
  /** The queue took it but has not executed it yet — §11's "order placed". */
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (intent === null) return;
    setSide(intent.side);
    setMode('amount');
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
  const preview = useMemo(() => {
    if (outcome === null) return null;
    // In shares mode the typed figure is a share count, so it is converted to
    // its cost first and then priced by the same quote as everything else —
    // one curve, read from whichever end the reader is holding.
    const asMoney =
      side === 'buy' && mode === 'shares'
        ? (costOfShares({ market, outcome, shares: amount })?.toString() ?? '')
        : amount;

    return quote({
      market,
      outcome,
      side,
      amount: asMoney,
      price,
      exitFeeRate: config?.exitFeeRate ?? 0,
    });
  }, [amount, mode, price, side, market, outcome, config]);

  const closed = market.state !== 'active';

  // §7.2d/§2.12: what the account may stake, read when the sheet opens so it
  // can be said before they commit rather than after the API refuses.
  const allowance = useTradeAllowance(intent === null ? 0 : 1);
  // Selling reduces exposure, so no cap or stake limit can bind it.
  const blocker = side === 'sell' ? null : blockerFor(allowance, amount, money);

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
                    className="grid size-11 shrink-0 place-items-center rounded-md border border-border text-text-muted hover:text-text"
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
                className="-mr-2 -mt-2 grid size-11 shrink-0 place-items-center rounded-md text-text-muted hover:text-text"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex items-baseline justify-between gap-3">
              <label className="text-sm text-text-muted" htmlFor="trade-amount">
                {side === 'sell'
                  ? 'How many shares?'
                  : mode === 'shares'
                    ? 'How many shares?'
                    : 'How much are you putting in?'}
              </label>
              {/* §7.2d's advanced toggle. Selling is already shares-first, so
                  it has nothing to switch between. */}
              {side === 'buy' && (
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === 'amount' ? 'shares' : 'amount');
                    setAmount('');
                  }}
                  className="-mr-2 flex h-11 items-center px-2 text-xs font-semibold text-brand hover:underline"
                >
                  {mode === 'amount' ? 'Enter shares' : 'Enter amount'}
                </button>
              )}
            </div>

            <input
              id="trade-amount"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
              placeholder="0"
              disabled={closed}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-3 font-mono text-xl tabular-nums outline-none focus:border-brand focus-visible:ring-1 focus-visible:ring-brand"
            />

            {side === 'buy' && mode === 'amount' && (
              <div className="mt-2 flex gap-2">
                {AMOUNT_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    disabled={closed}
                    onClick={() => setAmount(String(chip))}
                    className="h-11 flex-1 rounded-md border border-border bg-surface font-mono text-sm text-text-muted transition-colors hover:border-text hover:text-text active:scale-press"
                  >
                    ₦{chip >= 1000 ? `${chip / 1000}k` : chip}
                  </button>
                ))}
              </div>
            )}

            {side === 'buy' && mode === 'shares' && (
              <div className="mt-2 flex gap-2">
                {SHARE_STEPS.map((step) => (
                  <button
                    key={step}
                    type="button"
                    disabled={closed}
                    onClick={() => {
                      const current = Number.parseFloat(amount);
                      const next = (Number.isFinite(current) ? current : 0) + step;
                      // A stepper cannot take you below nothing.
                      setAmount(next <= 0 ? '' : String(Math.round(next * 100) / 100));
                    }}
                    className="h-11 flex-1 rounded-md border border-border bg-surface font-mono text-sm text-text-muted transition-colors hover:border-text hover:text-text active:scale-press"
                  >
                    {step > 0 ? `+${step}` : step}
                  </button>
                ))}
              </div>
            )}

            {/* §7.2d: "slider or chips for partial/full exit". A slider,
                because a position is a continuous quantity and 25/50/100 are
                three of the infinitely many exits somebody might want. */}
            {side === 'sell' && intent.held !== undefined && (
              <div className="mt-3">
                <input
                  type="range"
                  min={0}
                  max={Number.parseFloat(intent.held)}
                  step={Number.parseFloat(intent.held) / 100}
                  value={Number.parseFloat(amount) || 0}
                  onChange={(event) => setAmount(event.target.value)}
                  aria-label="How much of this position to sell"
                  className="w-full accent-fall"
                />
                <div className="mt-1 flex justify-between text-xs text-text-muted">
                  <span>0</span>
                  <button
                    type="button"
                    onClick={() => setAmount(intent.held as string)}
                    className="font-semibold text-brand hover:underline"
                  >
                    Sell all {Number.parseFloat(intent.held).toFixed(2)}
                  </button>
                </div>
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
                  className="mt-1.5 h-11 w-full rounded-md border border-border bg-surface px-3 text-sm outline-none focus:border-brand"
                />
              </div>
            )}

            {blocker !== null && (
              <p
                className={`mt-3 rounded-md px-3 py-2 text-sm ${
                  blocker.hard ? 'bg-fall-bg text-fall' : 'bg-chip text-text-muted'
                }`}
              >
                {blocker.message}
              </p>
            )}

            {error !== null && <p className="mt-3 text-sm text-fall">{error}</p>}

            <button
              type="button"
              onClick={() => void submit()}
              disabled={closed || submitting || preview === null || blocker?.hard === true}
              className={`mt-4 h-12 w-full rounded-lg text-md font-bold text-paper transition-transform active:scale-press disabled:opacity-45 ${tone}`}
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

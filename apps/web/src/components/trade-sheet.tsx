'use client';

import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUpDown, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { useFreeze } from './market/freeze-notice';
import type { OutcomeView } from '@/lib/api';

import { exactMoney, kobo, money, percent } from '@/lib/format';
import { placeTrade } from '@/lib/place-trade';
import { FillBreakdown } from '@/components/market/fill-breakdown';
import { rememberTrade, signInHref } from '@/lib/pending-trade';
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
  /**
   * Required, not optional. The sheet is the last screen between a person and
   * a trade, so it is the one place that must not be able to open on a market
   * it cannot answer the freeze question about — and an optional field would
   * make that a runtime accident rather than a compile error.
   */
  eventDate: string;
  freezeAt?: string | null;
  freezeReason?: string | null;
  outcomes: OutcomeView[];
}

export interface TradeIntent {
  outcome: OutcomeView;
  side: 'buy' | 'sell';
  /** Shares held, when selling. */
  held?: string;
  /**
   * Pre-filled amount, used to restore a trade somebody was composing before
   * they were sent to sign in. Absent everywhere else, because a sheet that
   * opens with a number already in it has made a decision on their behalf.
   */
  amount?: string;
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
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  /**
   * §7.2d's advanced toggle. Amount-first is the default because "how much am
   * I putting in" is the question this audience is actually answering; shares
   * -first is for the reader who is pricing the position instead.
   */
  const [mode, setMode] = useState<'amount' | 'shares'>('amount');
  /**
   * The price the trader will not go above, in kobo, or null for "at the
   * market price".
   *
   * Null by default and stays null unless somebody opens the control. A limit
   * is a power feature: it is the difference between a trade that happens now
   * and one that might happen later, and defaulting anybody into "later" would
   * be the sheet quietly not doing what the button said.
   */
  const [limitKobo, setLimitKobo] = useState<number | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);
  /**
   * Whether the fill breakdown has a fuller answer than the summary below it.
   *
   * The summary was written when the pot was the only venue, so its "shares you
   * get" is the pot leg alone — beside a breakdown reading ₦600 matched and
   * ₦1,400 from the pot, it was a third number that agreed with neither.
   */
  const [split, setSplit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** The queue took it but has not executed it yet — §11's "order placed". */
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Bumped on every chip press so the field can acknowledge it.
   *
   * A counter rather than a boolean: two presses of the same chip are two
   * events, and a boolean that is already true cannot restart an animation —
   * which is exactly the case where the feedback matters most, because the
   * amount changed by the same step twice and the digits are the only other
   * evidence.
   */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (intent === null) return;
    setSide(intent.side);
    setMode('amount');
    setAmount(intent.amount ?? '');
    setLimitKobo(null);
    setLimitOpen(false);
    setSplit(false);
    setQueued(false);
    setError(null);
    setTick(0);
  }, [intent]);

  const outcome = intent?.outcome ?? null;
  const freeze = useFreeze(market);
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

  /**
   * Leave for the sign-in screen, and leave a note.
   *
   * Both the sentence above the button and the button itself come here when
   * there is no session, because a signed-out person pressing "Place trade" has
   * said exactly what they want and deserves the flow rather than a refusal.
   */
  function signIn(route: '/login' | '/signup'): void {
    if (outcome === null) return;
    const pending = { marketId: market.id, outcomeId: outcome.id, amount };
    rememberTrade(pending);
    router.push(signInHref(pending, route));
  }

  async function submit(): Promise<void> {
    if (outcome === null || preview === null) return;
    if (token === null) {
      signIn('/login');
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
        // Buys only: a pot sell returns shares to the curve at whatever it is
        // paying, and there is no counterparty to name a price to.
        ...(side === 'buy' && limitKobo !== null ? { limitKobo } : {}),
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

            {/*
              Frozen: the sheet opens and says why, rather than not opening.
              A tap that produces nothing reads as a broken app, and the person
              tapping has money on this market — they are owed the sentence.
            */}
            {freeze.frozen ? (
              <div className="py-4 text-center">
                <p className="text-md font-bold">{freeze.message}</p>
                <p className="mt-1.5 text-sm text-text-muted">
                  No new stakes and no exits. Your position stays visible and settles when the
                  result is in.
                </p>
                <button
                  type="button"
                  onClick={onClose}
                  className="mt-4 w-full rounded-lg border border-border py-3 text-md font-bold"
                >
                  Close
                </button>
              </div>
            ) : (
              <>
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

                <div className="relative mt-1">
                  <input
                    id="trade-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
                    placeholder="0"
                    disabled={closed}
                    // `key` on the tick restarts the flash: an animation already
                    // running does not replay, and the third tap of ₦500 is the
                    // one that most needs to look like it landed.
                    key={tick}
                    className={`w-full rounded-md border bg-surface px-3 py-3 pr-12 font-mono text-xl tabular-nums focus:border-brand focus-visible:ring-1 focus-visible:ring-brand ${
                      tick > 0 ? 'motion-safe:animate-chip-tick border-brand' : 'border-border'
                    }`}
                  />
                  {amount !== '' && !closed && (
                    <button
                      type="button"
                      onClick={() => {
                        setAmount('');
                        setTick(0);
                      }}
                      aria-label="Clear the amount"
                      className="absolute right-1 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-md text-text-muted hover:bg-chip hover:text-text"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>

                {side === 'buy' && mode === 'amount' && (
                  <div className="mt-2 flex gap-2">
                    {AMOUNT_CHIPS.map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        disabled={closed}
                        // Adds rather than replaces. A row of chips that each
                        // overwrite the field can only ever express four amounts;
                        // adding lets four chips reach any multiple of ₦500, which
                        // is how people actually arrive at a number — ₦500 twice
                        // and a ₦1k is ₦2,000, and nobody had to open a keyboard.
                        onClick={() => {
                          const current = Number.parseFloat(amount);
                          const next = (Number.isFinite(current) ? current : 0) + chip;
                          setAmount(String(Math.round(next * 100) / 100));
                          setTick((count) => count + 1);
                        }}
                        className="h-11 flex-1 rounded-md border border-border bg-surface font-mono text-sm text-text-muted transition-colors hover:border-text hover:text-text active:scale-press"
                      >
                        +₦{chip >= 1000 ? `${chip / 1000}k` : chip}
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

                {/*
                  The limit price, folded away until it is wanted.

                  A limit changes what the button means — from "buy this now"
                  to "buy this if it gets there" — so it is a deliberate act
                  rather than a field somebody tabs into by accident. Buys
                  only: a pot sell returns shares to the curve at whatever it
                  is paying, and there is nobody on the other side to name a
                  price to.
                */}
                {side === 'buy' && !closed && (
                  <div className="mt-3">
                    {!limitOpen ? (
                      <button
                        type="button"
                        onClick={() => setLimitOpen(true)}
                        className="min-h-11 text-note font-semibold text-brand underline underline-offset-2 sm:min-h-0"
                      >
                        Set a price
                      </button>
                    ) : (
                      <div className="rounded-md border border-border bg-surface p-3">
                        <label
                          className="flex flex-wrap items-center gap-2 text-note"
                          htmlFor="trade-limit"
                        >
                          <span className="text-text-muted">Pay no more than</span>
                          <span className="flex items-baseline">
                            <input
                              id="trade-limit"
                              inputMode="numeric"
                              value={limitKobo === null ? '' : String(limitKobo)}
                              onChange={(event) => {
                                const parsed = Number.parseInt(event.target.value, 10);
                                setLimitKobo(
                                  Number.isFinite(parsed) && parsed >= 1 && parsed <= 99
                                    ? parsed
                                    : null,
                                );
                              }}
                              placeholder={String(Math.round(percent(price)))}
                              className="w-14 rounded-sm border border-border bg-surface-raised px-2 py-1 text-right font-mono tabular-nums"
                            />
                            <span className="ml-0.5 font-mono">k</span>
                          </span>
                          <span className="text-text-muted">a share</span>
                          <button
                            type="button"
                            onClick={() => {
                              setLimitKobo(null);
                              setLimitOpen(false);
                            }}
                            className="ml-auto min-h-11 text-fine text-text-muted underline underline-offset-2 sm:min-h-0"
                          >
                            At the market price
                          </button>
                        </label>
                        <p className="mt-1.5 text-fine text-text-muted">
                          Whatever cannot be filled at this price or better waits on the book until
                          somebody takes the other side. Nothing fills above it.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Where this trade would actually fill, and on what terms. */}
                <FillBreakdown
                  marketId={market.id}
                  outcomeId={outcome.id}
                  amount={mode === 'amount' ? amount : (money?.toString() ?? '')}
                  limitKobo={limitKobo}
                  active={side === 'buy'}
                  onSplit={setSplit}
                />

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
                      {/* Suppressed when the breakdown above is showing the
                          trade leg by leg: these figures are the pot's alone,
                          and a third number that agrees with neither of the
                          two above it is worse than no number. `Total` stays —
                          it is what leaves the balance either way. */}
                      {!split && (
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
                      {split && <Row label="Total" value={exactMoney(preview.total)} emphasis />}
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

                {preview !== null &&
                  side === 'buy' &&
                  Math.abs(preview.priceAfter - price) > 0.005 && (
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
                      className="mt-1.5 h-11 w-full rounded-md border border-border bg-surface px-3 text-sm focus:border-brand"
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

                {/*
              The signed-out prompt. It was a red sentence set by a failed
              submit — the colour of a refusal, the behaviour of nothing at
              all — so it read as an error the person had caused and offered
              no way out of it. It is now stated before they press anything,
              and both routes out of it are one tap.
            */}
                {token === null && !closed && (
                  <p className="mt-3 rounded-md bg-chip px-3 py-2.5 text-sm text-text-muted">
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

                {/*
              Said where the money is committed, not in a policy page.
              §2.16's honesty rule, and the one line that has to survive every
              future round of copy polish: a market position is not a deposit,
              and the sentence that says so belongs directly above the button
              that takes it.
            */}
                {!closed && (
                  <p className="mt-3 text-xs leading-snug text-text-muted">
                    Positions can lose their full value. Winners are paid from the pot.
                  </p>
                )}

                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={
                    closed ||
                    submitting ||
                    // Signed out, the button is a sign-in link in disguise, so it
                    // must not inherit the quote's disabled state: there is nothing
                    // to quote until they have an account, and a greyed-out button
                    // is how the old dead end looked.
                    (token !== null && (preview === null || blocker?.hard === true))
                  }
                  className={`mt-4 h-12 w-full rounded-lg text-md font-bold text-paper transition-transform active:scale-press disabled:opacity-45 ${tone}`}
                >
                  {closed
                    ? `Trading is ${market.state === 'resolved' ? 'over' : 'frozen'}`
                    : token === null
                      ? 'Sign in to stake'
                      : queued
                        ? 'Order placed — confirming…'
                        : submitting
                          ? 'Placing…'
                          : side === 'buy'
                            ? 'Place trade'
                            : 'Sell shares'}
                </button>
              </>
            )}
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

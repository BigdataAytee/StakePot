'use client';

import { useCallback, useEffect, useState } from 'react';

import { api, type MarketBook, type MarketDetail, type OpenOrder } from '@/lib/api';
import { cancelOrder, myOrders } from '@/lib/orderbook-api';
import { money } from '@/lib/format';

/** How often the depth is re-read when nothing else prompts it. */
const POLL_MS = 15_000;

/**
 * The book, and your own orders in it.
 *
 * Absent entirely on a market without one, which is most of them — a panel of
 * empty rows would say "nobody is here" about a market that has no book at
 * all, and those are different facts.
 *
 * Two halves, because they answer different questions. Depth answers "what can
 * I get right now, and at what price"; My Orders answers "what of mine is
 * still waiting, and can I have it back". The second half is the one with a
 * button on it, so it goes last.
 */
export function OrderBookPanel({
  market,
  token,
  /** Bumped after a fill so the book re-reads rather than showing what it was. */
  refreshKey = 0,
}: {
  market: MarketDetail;
  token: string | null;
  refreshKey?: number;
}) {
  const [book, setBook] = useState<MarketBook | null>(null);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .book(market.id)
      .then(setBook)
      .catch(() => undefined);
    if (token !== null) {
      void myOrders(token, market.id)
        .then(setOrders)
        .catch(() => undefined);
    }
  }, [market.id, token]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  if (book === null || !book.enabled) return null;

  const [first, second] = market.outcomes;
  const empty = book.asks.length === 0 && book.bids.length === 0;

  async function cancel(orderId: string): Promise<void> {
    if (token === null) return;
    setCancelling(orderId);
    setError(null);
    try {
      await cancelOrder(token, orderId);
      // Optimistic removal *and* a reload: the row should go the instant it is
      // tapped, and the locked figure beside the wallet should be the server's.
      setOrders((current) => current.filter((order) => order.id !== orderId));
      load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setCancelling(null);
    }
  }

  return (
    <section
      aria-label="Order book"
      className="mt-4 overflow-hidden rounded-xl border border-border bg-surface-raised"
    >
      <header className="flex items-baseline gap-2 border-b border-border px-3.5 py-2">
        <h2 className="text-fine font-semibold uppercase tracking-[.05em] text-text-muted">
          Order book
        </h2>
        {/* The distinction that has to survive everywhere: a matched share pays
            ₦1 flat, out of money somebody has already put up. */}
        <p className="text-fine text-text-muted">Matched with other traders · exact payout</p>
      </header>

      {empty ? (
        <p className="px-3.5 py-4 text-note text-text-muted">
          Nothing resting yet. Set a price on a trade and the unfilled part waits here for somebody
          to take the other side.
        </p>
      ) : (
        <div className="grid grid-cols-2 divide-x divide-border">
          <Side label={first?.label ?? 'Yes'} levels={book.asks} tone="rise" />
          {/* Mirrored, because the book stores one price and this column is the
              other side of it: a resting bid at 60 on YES is 40 kobo of NO,
              which is the number the person pressing "Buy NO" pays. Showing
              the raw 60 here would be the book's bookkeeping leaking onto a
              trading screen. */}
          <Side label={second?.label ?? 'No'} levels={book.bids} tone="fall" mirror />
        </div>
      )}

      {token !== null && orders.length > 0 && (
        <div className="border-t border-border">
          <h3 className="px-3.5 pt-2.5 text-fine font-semibold uppercase tracking-[.05em] text-text-muted">
            Your open orders
          </h3>
          <ul className="mt-1">
            {orders.map((order) => {
              const remaining = Number(order.shares) - Number(order.filled);
              return (
                <li
                  key={order.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3.5 py-2 text-note first:border-t-0"
                >
                  <span className="font-medium">{order.label}</span>
                  <span className="font-mono tabular-nums">{order.priceKobo}k</span>
                  <span className="text-text-muted">
                    <span className="font-mono tabular-nums text-text">
                      {remaining.toLocaleString('en-NG', { maximumFractionDigits: 0 })}
                    </span>{' '}
                    shares left
                  </span>
                  <span className="text-fine text-text-muted">{money(order.locked)} locked</span>
                  <button
                    type="button"
                    onClick={() => void cancel(order.id)}
                    disabled={cancelling === order.id}
                    className="ml-auto min-h-11 rounded-md px-2.5 text-note font-semibold text-fall underline underline-offset-2 disabled:opacity-50 sm:min-h-0 sm:py-1"
                  >
                    {cancelling === order.id ? 'Cancelling…' : 'Cancel'}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-border px-3.5 py-2 text-fine text-text-muted">
            Cancelling returns the locked amount to your balance straight away. Anything still
            resting is cancelled and refunded when the market freezes.
          </p>
          {error !== null && (
            <p className="border-t border-border bg-fall/10 px-3.5 py-2 text-note text-fall">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * One side's levels, best first.
 *
 * The naira figure is the point — "₦40,000 available at 62k" is what a trader
 * can act on, where a share count needs arithmetic first.
 */
function Side({
  label,
  levels,
  tone,
  mirror = false,
}: {
  label: string;
  levels: { priceKobo: number; shares: string; naira: string }[];
  tone: 'rise' | 'fall';
  /** Show ₦1 less the stored price — the other side of the same quote. */
  mirror?: boolean;
}) {
  return (
    <div className="px-3.5 py-2.5">
      <p className={`text-fine font-semibold ${tone === 'rise' ? 'text-rise' : 'text-fall'}`}>
        Buy {label}
      </p>
      {levels.length === 0 ? (
        <p className="mt-1 text-fine text-text-muted">Nothing offered</p>
      ) : (
        <ol className="mt-1 space-y-1">
          {levels.map((level) => (
            <li
              key={level.priceKobo}
              className="flex items-baseline justify-between gap-2 text-note"
            >
              <span className="font-mono font-bold tabular-nums">
                {mirror ? 100 - level.priceKobo : level.priceKobo}k
              </span>
              <span className="font-mono tabular-nums text-text-muted">{money(level.naira)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

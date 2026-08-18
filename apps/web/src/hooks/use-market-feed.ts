'use client';

import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';

import { API_URL } from '@/lib/api';
import { useLivePrices, type LiveMarket } from '@/store/live-prices';

let socket: Socket | null = null;

/** One connection per tab, shared across every component that watches a market. */
function connection(): Socket {
  socket ??= io(API_URL, { path: '/realtime', transports: ['websocket'] });
  return socket;
}

interface Tick extends LiveMarket {
  marketId: string;
}

/**
 * Subscribe to one market's live prices.
 *
 * Subscription is per market, not per connection: a viewer reading one ticket
 * should not be sent every other market's traffic (§12).
 */
export function useMarketFeed(marketId: string): void {
  const apply = useLivePrices((state) => state.apply);

  useEffect(() => {
    const client = connection();
    const onTick = (tick: Tick): void => {
      if (tick.marketId !== marketId) return;
      apply(marketId, { prices: tick.prices, pot: tick.pot, at: tick.at });
    };

    const subscribe = (): void => {
      client.emit('subscribe', marketId);
    };
    subscribe();
    client.on('connect', subscribe);
    client.on('price_changed', onTick);

    return () => {
      client.emit('unsubscribe', marketId);
      client.off('price_changed', onTick);
      client.off('connect', subscribe);
    };
  }, [marketId, apply]);
}

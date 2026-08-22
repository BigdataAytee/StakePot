'use client';

import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';

import { API_URL } from '@/lib/api';
import { useLiveMode } from '@/store/live-mode';
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
 * Subscribe to the live prices of however many markets are on screen.
 *
 * Subscription is per market, not per connection: a viewer reading one ticket
 * should not be sent every other market's traffic (§12). A grid asks for the
 * page it is showing, a ticket asks for one, and both go down the same socket.
 *
 * The header's LIVE switch is what `enabled` carries. Turning it off does not
 * merely stop applying ticks — it unsubscribes, so the server stops sending
 * them. Anything else would be a switch that lies about what it saves.
 */
export function useMarketFeeds(marketIds: string[], enabled = true): void {
  const apply = useLivePrices((state) => state.apply);
  // Sorted and joined so that the same set in a different order does not tear
  // every subscription down and build it again on each render.
  const key = [...marketIds].sort().join(',');

  useEffect(() => {
    if (!enabled || key === '') return undefined;
    const ids = key.split(',');
    const wanted = new Set(ids);
    const client = connection();

    const onTick = (tick: Tick): void => {
      if (!wanted.has(tick.marketId)) return;
      apply(tick.marketId, { prices: tick.prices, pot: tick.pot, at: tick.at });
    };

    // Re-sent on reconnect: the server holds subscriptions per socket, so a
    // dropped connection is a silently empty feed until they are asked for
    // again.
    const subscribe = (): void => {
      for (const id of ids) client.emit('subscribe', id);
    };

    subscribe();
    client.on('connect', subscribe);
    client.on('price_changed', onTick);

    return () => {
      for (const id of ids) client.emit('unsubscribe', id);
      client.off('price_changed', onTick);
      client.off('connect', subscribe);
    };
  }, [key, enabled, apply]);
}

/** One market's live prices — the ticket's case. */
export function useMarketFeed(marketId: string): void {
  const live = useLiveMode((state) => state.live);
  useMarketFeeds([marketId], live);
}

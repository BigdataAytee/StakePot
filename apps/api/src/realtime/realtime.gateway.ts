import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';

import { env } from '../config/env';
import { logger } from '../logger';
import { PriceCacheService, type PriceTick } from './price-cache.service';

/**
 * The realtime gateway (§2.3, §12).
 *
 * Clients subscribe per market — a viewer watching one ticket is not sent every
 * other market's traffic. Ticks are coalesced on a 250ms window, which §12 asks
 * for on hot markets: on election night a market can take dozens of trades a
 * second, and no human reads a number that changes forty times a second. It
 * also matches the 250ms `priceTick` animation, so each frame the UI draws is a
 * real state, never one it was interrupted mid-way through.
 *
 * socket.io is attached to the existing HTTP server directly rather than
 * through @nestjs/websockets — the manifest lists `socket.io`, and the adapter
 * packages would be two dependencies bought for a thin wrapper.
 */
@Injectable()
export class RealtimeGateway implements OnModuleDestroy {
  private io: Server | null = null;
  private unsubscribe: (() => void) | null = null;

  /** marketId → tick waiting for its window to close. */
  private readonly pending = new Map<string, PriceTick>();
  private flushTimer: NodeJS.Timeout | null = null;

  private static readonly COALESCE_MS = 250;

  constructor(private readonly prices: PriceCacheService) {}

  attach(server: HttpServer): void {
    this.io = new Server(server, {
      cors: { origin: env.WEB_ORIGIN, credentials: true },
      path: '/realtime',
      serveClient: false,
    });

    this.io.on('connection', (socket) => {
      socket.on('subscribe', (marketId: unknown) => {
        if (typeof marketId !== 'string' || marketId.length === 0) return;
        void socket.join(`market:${marketId}`);
      });
      socket.on('unsubscribe', (marketId: unknown) => {
        if (typeof marketId !== 'string') return;
        void socket.leave(`market:${marketId}`);
      });
    });

    this.unsubscribe = this.prices.onTick((tick) => this.enqueue(tick));
    logger.info({ path: '/realtime' }, 'realtime gateway attached');
  }

  /**
   * Hold the newest tick per market until the window closes.
   *
   * Deliberately last-write-wins rather than a queue: a price is a current
   * state, not an event log, and a viewer who missed three intermediate values
   * has missed nothing. The chart's own history comes from `price_history`.
   */
  private enqueue(tick: PriceTick): void {
    this.pending.set(tick.marketId, tick);
    if (this.flushTimer !== null) return;

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = [...this.pending.values()];
      this.pending.clear();
      for (const pending of batch) {
        this.io?.to(`market:${pending.marketId}`).emit('price_changed', pending);
      }
    }, RealtimeGateway.COALESCE_MS);
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    void this.io?.close();
  }
}

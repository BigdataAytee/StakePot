import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { env } from '../config/env';

/**
 * Live prices in Redis, and the pub/sub spine behind the realtime gateway.
 *
 * §11: "Read path never touches the write path. Prices, charts, market lists
 * and leaderboards are served from Redis and read replicas. Only trades hit the
 * primary. A million viewers watching prices costs the trading engine nothing."
 *
 * §12 scales this by fanning out through Redis pub/sub so any gateway node can
 * serve any subscriber. That shape is here from the start — it costs nothing at
 * one node and is the difference between scaling and rewriting later.
 */
export interface PriceTick {
  readonly marketId: string;
  /** Outcome id → price as a decimal string. */
  readonly prices: Record<string, string>;
  readonly pot: string;
  readonly at: number;
}

export const PRICE_CHANNEL = 'stakeam:price_changed';

@Injectable()
export class PriceCacheService implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly listeners = new Set<(tick: PriceTick) => void>();

  constructor() {
    this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
    this.subscriber = this.redis.duplicate();
    void this.redis.connect().catch(() => undefined);
    void this.subscriber
      .connect()
      .then(() => this.subscriber.subscribe(PRICE_CHANNEL))
      .catch(() => undefined);

    this.subscriber.on('message', (channel, payload) => {
      if (channel !== PRICE_CHANNEL) return;
      try {
        const tick = JSON.parse(payload) as PriceTick;
        for (const listener of this.listeners) listener(tick);
      } catch {
        // A malformed tick is dropped rather than taking the gateway down;
        // the next trade republishes the truth a moment later.
      }
    });
  }

  private static key(marketId: string): string {
    return `market:${marketId}:prices`;
  }

  /** Cache the new prices and tell every gateway node. */
  async publish(tick: PriceTick): Promise<void> {
    await this.redis
      .multi()
      .set(PriceCacheService.key(tick.marketId), JSON.stringify(tick), 'EX', 86_400)
      .publish(PRICE_CHANNEL, JSON.stringify(tick))
      .exec();
  }

  /** Last known prices without touching Postgres. */
  async read(marketId: string): Promise<PriceTick | null> {
    const raw = await this.redis.get(PriceCacheService.key(marketId));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as PriceTick;
    } catch {
      return null;
    }
  }

  onTick(listener: (tick: PriceTick) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
    this.subscriber.disconnect();
  }
}

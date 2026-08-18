import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import {
  RateLimiterRedis,
  RateLimiterMemory,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';

import { env } from '../config/env';
import { logger } from '../logger';
import { RATE_LIMITS, type LimitClass } from './rate-limits';

export class RateLimitedError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = 'RateLimitedError';
  }
}

/**
 * §12's "rate limiting per user/IP at the LB and per-endpoint".
 *
 * Counters live in Redis because §12 puts them there and because the API is
 * meant to run as several stateless nodes — an in-process limiter would give
 * each node its own budget and multiply every limit by the replica count.
 *
 * When Redis is unreachable the limiter falls back to an in-memory one rather
 * than failing open or failing closed. Failing open removes the control exactly
 * when the platform is already degraded; failing closed turns a cache outage
 * into a total outage. A per-node budget is wrong by a factor of the replica
 * count, and that is the least bad of the three.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly redis: Redis | null;
  private readonly limiters = new Map<string, RateLimiterAbstract>();

  constructor() {
    try {
      this.redis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
      });
      void this.redis.connect().catch((error: unknown) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'rate limiter could not reach redis — falling back to per-node counters',
        );
      });
    } catch {
      this.redis = null;
    }
  }

  private limiterFor(limitClass: LimitClass, scope: 'user' | 'ip'): RateLimiterAbstract | null {
    const rule = RATE_LIMITS[limitClass];
    const budget = scope === 'user' ? rule.perUser : rule.perIp;
    // A class can decline an IP budget entirely — see LimitRule.perIp.
    if (budget === undefined) return null;

    const key = `${limitClass}:${scope}`;
    const existing = this.limiters.get(key);
    if (existing !== undefined) return existing;
    const options = {
      keyPrefix: `rl:${key}`,
      points: budget.points,
      duration: budget.duration,
      blockDuration: budget.blockDuration,
    };

    const limiter =
      this.redis === null
        ? new RateLimiterMemory(options)
        : new RateLimiterRedis({
            ...options,
            storeClient: this.redis,
            insuranceLimiter: new RateLimiterMemory(options),
          });

    this.limiters.set(key, limiter);
    return limiter;
  }

  /**
   * Consume one unit against both the user and the IP budget.
   *
   * Both, not either: a single account spraying from one address should trip
   * the user limit, and a farm of accounts behind one address should trip the
   * IP limit. Checking only one leaves the other pattern unbounded.
   */
  async consume(params: { limitClass: LimitClass; userId?: string; ip?: string }): Promise<void> {
    const rule = RATE_LIMITS[params.limitClass];

    const checks: Promise<unknown>[] = [];
    if (params.userId !== undefined) {
      const byUser = this.limiterFor(params.limitClass, 'user');
      if (byUser !== null) checks.push(byUser.consume(params.userId));
    }
    // A class with no IP budget is limited by account alone.
    if (params.ip !== undefined && params.ip.length > 0) {
      const byIp = this.limiterFor(params.limitClass, 'ip');
      if (byIp !== null) checks.push(byIp.consume(params.ip));
    }
    if (checks.length === 0) return;

    try {
      await Promise.all(checks);
    } catch (caught) {
      // rate-limiter-flexible rejects with the limiter's own result object
      // rather than an Error when the budget is spent.
      const wait =
        typeof caught === 'object' && caught !== null && 'msBeforeNext' in caught
          ? Math.ceil(Number((caught as { msBeforeNext: number }).msBeforeNext) / 1000)
          : rule.perUser.blockDuration;
      throw new RateLimitedError(rule.message, Math.max(wait, 1));
    }
  }

  /** What is left, for a caller that wants to show it rather than be surprised. */
  async remaining(limitClass: LimitClass, userId: string): Promise<number> {
    // Every class has a per-user budget, so this limiter always exists; the
    // null branch is the type system's, not a real state.
    const limiter = this.limiterFor(limitClass, 'user');
    const result = limiter === null ? null : await limiter.get(userId);
    return result === null
      ? RATE_LIMITS[limitClass].perUser.points
      : Math.max(0, result.remainingPoints);
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }
}

import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Trade } from '@prisma/client';
import Redis from 'ioredis';

import { ThreadService } from '../community-layer/thread.service';
import { NotificationsService } from '../notifications/notifications.service';
import { env } from '../config/env';
import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { RgBlockedError } from '../rg/rg.service';
import { InsufficientFundsError } from '../wallet/wallet.service';
import { TradeError, TradeService, type BuyInput, type SellInput } from './trade.service';
import { EngineError } from '@stakeam/engine';

/**
 * Whether an error is a *refusal* — a user-meaningful "no" — rather than the
 * platform failing.
 *
 * The distinction decides what the waiting caller is told. A refusal travels to
 * them verbatim: "insufficient funds", "your stake limit", "market frozen" are
 * all things the person can act on. Masking those behind "could not be
 * processed" turns an answer into a support ticket. Anything else really is
 * ours, and gets the generic message plus a loud log line.
 */
const isRefusal = (error: unknown): error is Error =>
  error instanceof TradeError ||
  error instanceof InsufficientFundsError ||
  error instanceof RgBlockedError ||
  error instanceof EngineError;

/** One market's stream. All of its trades land here, in submission order. */
const streamFor = (marketId: string): string => `stakeam:trades:{${marketId}}`;
/** The set of markets with a stream, so the worker knows where to look. */
const ACTIVE_MARKETS = 'stakeam:trades:active';
/** Per-market lock, so exactly one consumer drains a market at a time. */
const lockFor = (marketId: string): string => `stakeam:trades:lock:{${marketId}}`;
const GROUP = 'trade-workers';

/**
 * A trade on its way to being executed.
 *
 * `reason` rides along with it rather than being posted by the caller after the
 * fact: §2.15a's take has to carry the position the trade created, so it can
 * only be written once the trade has been written — and a queued trade is
 * written by the worker, minutes after the caller has gone. Posting it at the
 * point of execution is the only place that is true for every path.
 */
export type QueuedRequest = (({ kind: 'buy' } & BuyInput) | ({ kind: 'sell' } & SellInput)) & {
  /** §2.15a's optional one-line "why?", captured on the trade ticket. */
  readonly reason?: string;
};

export interface QueueOutcome {
  readonly status: 'filled' | 'queued' | 'rejected';
  readonly requestId: string;
  readonly trade?: Trade;
  readonly reason?: string;
}

/**
 * §11's per-market ordered queue.
 *
 * "Every trade/stake/exit request is published to a message queue partitioned by
 * `market_id`... All events for one market land in one partition, consumed in
 * order by exactly one Trade Worker at a time. Within a market: strict sequence,
 * no race conditions, no locks fighting. Across markets: unlimited parallelism."
 *
 * Redis Streams rather than Kafka, per §12: Kafka is the *scale* answer and is
 * deliberately not installed. One stream per market gives the partitioning for
 * free — a market's entries are in one place and read in ID order — and a short
 * per-market lock gives "exactly one worker at a time" without workers needing
 * to agree on ownership.
 *
 * **The queue is an accelerator, not a dependency.** If Redis is unreachable the
 * submit path executes inline against the same `TradeService`, which is still
 * correct: the row lock it takes serialises writers per market on its own. A
 * platform that stops accepting money because a cache is down has traded one
 * failure for a worse one.
 *
 * What the queue adds over the lock is §11's backpressure: a burst is absorbed
 * as stream entries instead of as database connections held open waiting on a
 * lock, which is the difference between a slow market and an outage on
 * election night.
 */
@Injectable()
export class TradeQueueService implements OnModuleInit, OnModuleDestroy {
  private redis: Redis | null = null;
  private consumer: Redis | null = null;
  private draining = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly name = `worker-${process.pid}`;
  /** Tail of each market's in-process inline chain — see executeInline. */
  private readonly inlineTail = new Map<string, Promise<void>>();

  constructor(
    private readonly trades: TradeService,
    private readonly prisma: PrismaService,
    private readonly threads: ThreadService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      this.redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
      this.consumer = this.redis.duplicate();
      await this.redis.connect();
      await this.consumer.connect();
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'trade queue could not reach redis — trades will execute inline',
      );
      this.redis = null;
      this.consumer = null;
      return;
    }

    // Polled rather than blocking: one loop serves every market, and a market
    // with nothing pending must not hold a connection open waiting for it.
    this.timer = setInterval(() => void this.drainAll(), 50);
    logger.info('trade queue ready — per-market streams');
  }

  /** Whether the queue is carrying trades, for the health endpoint. */
  get enabled(): boolean {
    return this.redis !== null;
  }

  /**
   * Submit a trade.
   *
   * Waits briefly for the worker to execute it, because a trader pressing
   * "Stake am" wants to know whether they got filled and at what price. If the
   * queue is backed up the call returns `queued` rather than holding the
   * connection — §11's "users see 'order placed' instantly (accepted into
   * queue) and confirmation when executed".
   */
  async submit(request: QueuedRequest, waitMs = 5_000): Promise<QueueOutcome> {
    const redis = this.redis;
    if (redis === null) {
      // Inline fallback. Same service, same row lock, same guarantees.
      return this.executeInline(request);
    }

    // Idempotency (§11) before anything is enqueued: a retried submit must not
    // add a second entry to the stream, even if the first is still pending.
    const existing = await this.prisma.trade.findUnique({
      where: { requestId: request.requestId },
    });
    if (existing !== null)
      return { status: 'filled', requestId: request.requestId, trade: existing };

    try {
      await redis.xadd(streamFor(request.marketId), '*', 'payload', JSON.stringify(request));
      await redis.sadd(ACTIVE_MARKETS, request.marketId);
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'could not enqueue trade — executing inline',
      );
      return this.executeInline(request);
    }

    // Nudge the loop rather than waiting for the next tick.
    void this.drain(request.marketId);

    // Waiters watch Redis, not Postgres. The worker announces each outcome with
    // a short-lived key, so a submit that is waiting costs no database
    // connections — this matters more than it looks: on a small pool (CI has
    // two cores, so Prisma gives five connections), a handful of waiters
    // polling the trades table starved the very transaction they were waiting
    // on, and the queue timed out against itself. The database is consulted
    // once, at the end, as a belt-and-braces check in case the announcement
    // write was lost.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const announced = await redis
        .mget(filledKey(request.requestId), rejectionKey(request.requestId))
        .catch(() => [null, null]);

      if (announced[0] !== null) {
        const filled = await this.prisma.trade.findUnique({
          where: { requestId: request.requestId },
        });
        if (filled !== null) {
          return { status: 'filled', requestId: request.requestId, trade: filled };
        }
      }
      if (announced[1] != null) {
        return { status: 'rejected', requestId: request.requestId, reason: announced[1] };
      }
      await sleep(50);
    }

    const lastLook = await this.prisma.trade.findUnique({
      where: { requestId: request.requestId },
    });
    if (lastLook !== null) {
      return { status: 'filled', requestId: request.requestId, trade: lastLook };
    }
    return { status: 'queued', requestId: request.requestId };
  }

  /** What happened to a submitted request, for a client that stopped waiting. */
  async outcomeOf(requestId: string): Promise<QueueOutcome> {
    const trade = await this.prisma.trade.findUnique({ where: { requestId } });
    if (trade !== null) return { status: 'filled', requestId, trade };

    const rejection = await this.redis?.get(rejectionKey(requestId)).catch(() => null);
    if (rejection != null) return { status: 'rejected', requestId, reason: rejection };

    return { status: 'queued', requestId };
  }

  /**
   * The Redis-down path, serialised per market *before* the database.
   *
   * The row lock alone makes concurrent inline trades correct, but each one
   * waiting on that lock is parked inside an open transaction holding a pooled
   * connection — and on a small pool a burst on one market starves itself into
   * "unable to start a transaction" (observed on CI's two-core runner, where
   * Prisma's pool is five). Chaining same-market requests in-process means at
   * most one of a market's trades occupies a connection at a time, which is
   * §11's ordering discipline applied to the fallback too. Different markets
   * still run in parallel; per-process ordering is weaker than the queue's
   * cross-node ordering, but the fallback was never cross-node ordered — the
   * row lock is what holds then, exactly as documented above.
   */
  private async executeInline(request: QueuedRequest): Promise<QueueOutcome> {
    const previous = this.inlineTail.get(request.marketId) ?? Promise.resolve();
    const outcome = previous.then(() => this.runInline(request));
    const tail = outcome.then(
      () => undefined,
      () => undefined,
    );
    this.inlineTail.set(request.marketId, tail);
    void tail.then(() => {
      if (this.inlineTail.get(request.marketId) === tail) {
        this.inlineTail.delete(request.marketId);
      }
    });
    return outcome;
  }

  private async runInline(request: QueuedRequest): Promise<QueueOutcome> {
    try {
      const trade =
        request.kind === 'buy' ? await this.trades.buy(request) : await this.trades.sell(request);
      await this.postReason(request);
      await this.confirm(trade);
      return { status: 'filled', requestId: request.requestId, trade };
    } catch (error) {
      if (isRefusal(error)) {
        return { status: 'rejected', requestId: request.requestId, reason: error.message };
      }
      throw error;
    }
  }

  /** Drain every market that has anything waiting. */
  private async drainAll(): Promise<void> {
    if (this.draining || this.redis === null) return;
    this.draining = true;
    try {
      const markets = await this.redis.smembers(ACTIVE_MARKETS);
      // Markets in parallel, entries within a market in order — §11 exactly.
      await Promise.all(markets.map((marketId) => this.drain(marketId)));
    } catch {
      // A failed poll is the next tick's problem.
    } finally {
      this.draining = false;
    }
  }

  /**
   * Drain one market, in order, alone.
   *
   * The lock is what makes "exactly one Trade Worker at a time" true across
   * several API nodes. Short-lived and self-expiring: a worker that dies
   * mid-drain must not wedge a market until somebody notices.
   */
  private async drain(marketId: string): Promise<void> {
    const redis = this.redis;
    const consumer = this.consumer;
    if (redis === null || consumer === null) return;

    const lock = lockFor(marketId);
    const held = await redis.set(lock, this.name, 'EX', 30, 'NX').catch(() => null);
    if (held === null) return;

    try {
      await this.ensureGroup(marketId);

      for (;;) {
        const batch = (await consumer
          .xreadgroup('GROUP', GROUP, this.name, 'COUNT', 20, 'STREAMS', streamFor(marketId), '>')
          .catch(() => null)) as [string, [string, string[]][]][] | null;

        const entries = batch?.[0]?.[1] ?? [];
        if (entries.length === 0) break;

        for (const [id, fields] of entries) {
          await this.execute(marketId, id, fields);
        }
      }

      // Nothing left: stop the poll loop from waking for this market.
      const remaining = await redis.xlen(streamFor(marketId)).catch(() => 1);
      if (remaining === 0) await redis.srem(ACTIVE_MARKETS, marketId).catch(() => undefined);
    } finally {
      await redis.del(lock).catch(() => undefined);
    }
  }

  private async execute(marketId: string, id: string, fields: string[]): Promise<void> {
    const consumer = this.consumer;
    const redis = this.redis;
    if (consumer === null || redis === null) return;

    const index = fields.indexOf('payload');
    const raw = index === -1 ? null : fields[index + 1];
    if (raw === undefined || raw === null) {
      await consumer.xack(streamFor(marketId), GROUP, id).catch(() => undefined);
      return;
    }

    let request: QueuedRequest;
    try {
      request = JSON.parse(raw) as QueuedRequest;
    } catch {
      await consumer.xack(streamFor(marketId), GROUP, id).catch(() => undefined);
      return;
    }

    try {
      const trade =
        request.kind === 'buy' ? await this.trades.buy(request) : await this.trades.sell(request);
      // Before the announcement, not after: the announcement is what releases
      // the waiting caller, and a caller released ahead of its own take reloads
      // the market to find the thread without it.
      await this.postReason(request);
      await this.confirm(trade);
      // Announce the fill so waiters never have to poll the database for it.
      await redis.set(filledKey(request.requestId), '1', 'EX', 300).catch(() => undefined);
    } catch (error) {
      if (isRefusal(error)) {
        // A refusal is an answer, not a failure: the caller is waiting for it,
        // and retrying it would refuse identically for ever.
        await redis
          .set(rejectionKey(request.requestId), error.message, 'EX', 300)
          .catch(() => undefined);
      } else {
        // Anything else is ours. Acknowledged so one poisoned entry cannot
        // block the market behind it, and logged loudly because a trade the
        // platform dropped is a trade somebody is still waiting on.
        logger.error(
          {
            marketId,
            requestId: request.requestId,
            error: error instanceof Error ? error.message : String(error),
          },
          'trade worker failed to execute a queued trade',
        );
        await redis
          .set(rejectionKey(request.requestId), 'that trade could not be processed', 'EX', 300)
          .catch(() => undefined);
      }
    } finally {
      // Trimmed as well as acknowledged: the stream is a work queue, not the
      // record. `trades` is the record.
      await consumer.xack(streamFor(marketId), GROUP, id).catch(() => undefined);
      await redis.xdel(streamFor(marketId), id).catch(() => undefined);
    }
  }

  /**
   * §2.15a's reason prompt, posted the moment the trade it explains exists.
   *
   * Best-effort by construction: a take refused by the comment rules — a rate
   * limit, a tripped word, an account that cannot comment — must never unwind a
   * trade that has already settled. The stake is the commitment; the sentence
   * beside it is not.
   */
  private async postReason(request: QueuedRequest): Promise<void> {
    const text = request.reason?.trim() ?? '';
    if (text.length === 0) return;
    await this.threads
      .post({
        marketId: request.marketId,
        userId: request.userId,
        text,
        fromTrade: true,
      })
      .catch(() => undefined);
  }

  /**
   * The receipt for a fill.
   *
   * `trade_confirmed` has been in the notification taxonomy since the service
   * was written and nothing ever sent one — the type existed, the inbox never
   * showed a trade. It reads as a broker's confirmation because that is what it
   * is: side, size, instrument, price.
   *
   * Best-effort for the same reason the take is: a notification that fails must
   * never unwind a trade that has already settled.
   */
  private async confirm(trade: {
    id: string;
    userId: string;
    marketId: string;
    outcomeId: string;
    side: string;
    shares: unknown;
    cost: unknown;
  }): Promise<void> {
    try {
      const outcome = await this.prisma.outcome.findUnique({
        where: { id: trade.outcomeId },
        select: { label: true, priceCurrent: true },
      });
      if (outcome === null) return;
      const shares = Number(String(trade.shares)).toFixed(2);
      const kobo = Math.round(Number(String(outcome.priceCurrent)) * 100);
      const verb = trade.side === 'buy' ? 'Bought' : 'Sold';
      await this.notifications.notify({
        userId: trade.userId,
        type: 'trade_confirmed',
        body: `${verb} ${shares} shares ${outcome.label.toUpperCase()} @ ${kobo}k.`,
        data: { marketId: trade.marketId, tradeId: trade.id },
      });
    } catch {
      // See above.
    }
  }

  private async ensureGroup(marketId: string): Promise<void> {
    try {
      await this.consumer?.xgroup('CREATE', streamFor(marketId), GROUP, '0', 'MKSTREAM');
    } catch (error) {
      // BUSYGROUP just means another worker created it first.
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    await this.consumer?.quit().catch(() => undefined);
    await this.redis?.quit().catch(() => undefined);
  }
}

const rejectionKey = (requestId: string): string => `stakeam:trades:rejected:${requestId}`;
const filledKey = (requestId: string): string => `stakeam:trades:filled:${requestId}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

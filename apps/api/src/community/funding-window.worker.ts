import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';

import { env } from '../config/env';
import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityService } from './community.service';
import { SeedService } from './seed.service';

const QUEUE = 'funding-window';

/**
 * `window` is the funding window's deadline — Path A activates or voids, Path B
 * re-checks the participation floor. `seeding` is a syndicate round's deadline:
 * fill or refund. Two deadlines, two jobs, so a market that has both cannot lose
 * one to the other's job id.
 */
type CloseKind = 'window' | 'seeding';

interface CloseJob {
  readonly marketId: string;
  readonly kind: CloseKind;
}

/**
 * The funding-window job (§2.4).
 *
 * bullmq rather than a cron sweep because the deadline is per market and the
 * work is money: a job carries its own retry and its own dead-letter, and a
 * missed window is not something a `setInterval` should be trusted with.
 *
 * The job id is the market id, so scheduling twice is a no-op and a redelivery
 * cannot void a market twice — `closeFundingWindow` is idempotent by state as
 * well, because at-least-once delivery means both belts are needed.
 */
@Injectable()
export class FundingWindowWorker implements OnModuleInit, OnModuleDestroy {
  private queue: Queue<CloseJob> | null = null;
  private worker: Worker<CloseJob> | null = null;

  constructor(
    private readonly community: CommunityService,
    private readonly seeds: SeedService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = { url: env.REDIS_URL };

    this.queue = new Queue<CloseJob>(QUEUE, { connection });
    this.worker = new Worker<CloseJob>(
      QUEUE,
      async (job) => {
        const { marketId, kind } = job.data;
        const result =
          kind === 'seeding'
            ? await this.seeds.closeSeedingRound(marketId)
            : await this.community.closeWindow(marketId);
        logger.info({ marketId, kind, ...result }, 'community deadline handled');
        return result;
      },
      { connection, concurrency: 4 },
    );

    this.worker.on('failed', (job, error) => {
      logger.error(
        { marketId: job?.data.marketId, error: error.message },
        'community deadline job failed — the market keeps its deadline until it succeeds',
      );
    });

    // Rebuild the schedule from Postgres on every boot. A lost Redis must not
    // mean a market whose window never closes and whose escrow never comes back.
    try {
      const rearmed = await this.rearmOpenWindows();
      logger.info({ rearmed }, 'community deadlines re-armed from the database');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'could not re-arm community deadlines — open windows will not close until this succeeds',
      );
    }
  }

  /** Schedule a market's funding-window close. Safe to call more than once. */
  async schedule(marketId: string, closesAt: Date): Promise<void> {
    await this.enqueue(marketId, 'window', closesAt);
  }

  /** Schedule a seeding round's deadline (Rulebook Part 3 §3). */
  async scheduleSeedingRound(marketId: string, roundEndsAt: Date): Promise<void> {
    await this.enqueue(marketId, 'seeding', roundEndsAt);
  }

  private async enqueue(marketId: string, kind: CloseKind, at: Date): Promise<void> {
    const delay = Math.max(0, at.getTime() - Date.now());
    const options: JobsOptions = {
      // bullmq rejects a colon in a job id — it is the delimiter in its own key
      // space. A dash keeps the two deadlines distinct without fighting it.
      jobId: `${kind}-${marketId}`,
      delay,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 604_800 },
      removeOnFail: false,
    };
    await this.queue?.add('close', { marketId, kind }, options);
  }

  /**
   * Re-arm every open window on boot.
   *
   * A queue is not a source of truth. If Redis is lost, the markets still sit in
   * `funding` in Postgres with their deadlines, and money is still escrowed —
   * so the database is what the schedule is rebuilt from.
   */
  async rearmOpenWindows(): Promise<number> {
    // Every market with a deadline still on it, whichever path it took: Path A
    // waiting to activate, and Path B already trading with a floor still to
    // meet. The deadline is a column, so a re-arm cannot drift from what the
    // market was actually promised.
    const windows = await this.prisma.market.findMany({
      where: {
        shelf: 'community',
        fundingClosesAt: { not: null },
        state: { in: ['funding', 'active'] },
      },
      select: { id: true, fundingClosesAt: true },
    });

    for (const market of windows) {
      if (market.fundingClosesAt === null) continue;
      await this.schedule(market.id, market.fundingClosesAt);
    }

    const rounds = await this.prisma.syndicate.findMany({
      where: { state: 'open' },
      select: { marketId: true, roundEndsAt: true },
    });
    for (const round of rounds) {
      await this.scheduleSeedingRound(round.marketId, round.roundEndsAt);
    }

    return windows.length + rounds.length;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

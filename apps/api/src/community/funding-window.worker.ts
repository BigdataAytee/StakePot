import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';

import { env } from '../config/env';
import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';
import { CommunityService } from './community.service';

const QUEUE = 'funding-window';

interface CloseJob {
  readonly marketId: string;
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
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    const connection = { url: env.REDIS_URL };

    this.queue = new Queue<CloseJob>(QUEUE, { connection });
    this.worker = new Worker<CloseJob>(
      QUEUE,
      async (job) => {
        const result = await this.community.closeFundingWindow(job.data.marketId);
        logger.info({ marketId: job.data.marketId, ...result }, 'funding window closed');
        return result;
      },
      { connection, concurrency: 4 },
    );

    this.worker.on('failed', (job, error) => {
      logger.error(
        { marketId: job?.data.marketId, error: error.message },
        'funding window job failed — market stays in funding until it succeeds',
      );
    });
  }

  /** Schedule a market's window close. Safe to call more than once. */
  async schedule(marketId: string, closesAt: Date): Promise<void> {
    const delay = Math.max(0, closesAt.getTime() - Date.now());
    const options: JobsOptions = {
      jobId: marketId,
      delay,
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 604_800 },
      removeOnFail: false,
    };
    await this.queue?.add('close', { marketId }, options);
  }

  /**
   * Re-arm every open window on boot.
   *
   * A queue is not a source of truth. If Redis is lost, the markets still sit in
   * `funding` in Postgres with their deadlines, and money is still escrowed —
   * so the database is what the schedule is rebuilt from.
   */
  async rearmOpenWindows(windowHours: number): Promise<number> {
    const open = await this.prisma.market.findMany({
      where: { shelf: 'community', state: 'funding' },
      select: { id: true, createdAt: true },
    });

    for (const market of open) {
      await this.schedule(
        market.id,
        new Date(market.createdAt.getTime() + windowHours * 3_600_000),
      );
    }
    return open.length;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

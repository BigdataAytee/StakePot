import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type JobsOptions } from 'bullmq';

import { env } from '../config/env';
import { logger } from '../logger';
import { NudgeService } from '../creator/nudge.service';
import { OpportunityService } from '../creator/opportunity.service';
import { AbuseService } from '../hardening/abuse.service';
import { LedgerAuditService } from '../hardening/ledger-audit.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { ResearchService } from '../intel/research.service';
import { MarketHealthService } from '../market/health.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { ResolutionFlowService } from '../resolution/resolution-flow.service';
import { SupportService } from '../support/support.service';
import { CommunityService } from './community.service';
import { SeedService } from './seed.service';

const QUEUE = 'funding-window';

/**
 * `window` is the funding window's deadline — Path A activates or voids, Path B
 * re-checks the participation floor. `seeding` is a syndicate round's deadline:
 * fill or refund. `dispute` is the 48h window on a proposed result. Three
 * deadlines, three job ids, so a market that carries more than one cannot lose
 * one to another's.
 *
 * `health-sweep` runs Part 5 of the ticket-creation checklist over everything
 * live — the lopsided split, the early whale, the settlement nobody has
 * prepared — and records what fires, so rule 43's post-mortem can say what went
 * wrong during the market rather than only how it ended.
 *
 * `research-sweep` is the intelligence layer's heartbeat. Without it nothing
 * reads a source, so every context panel, evidence panel and dossier is
 * permanently empty — and empty is exactly what "quiet news week" looks like,
 * which is why it went unnoticed until somebody went looking for the caller.
 *
 * `freeze-sweep` is the odd one out: a repeatable job rather than a deadline,
 * flipping markets whose event has started into `pending_resolution` so the
 * shelf stops saying LIVE during the match. `nudge-sweep` and
 * `opportunity-sweep` are the same shape — §2.14's prompts and demand signals
 * are states of the platform rather than per-market deadlines.
 */
type CloseKind =
  | 'window'
  | 'seeding'
  | 'dispute'
  | 'freeze-sweep'
  | 'sla-sweep'
  | 'nudge-sweep'
  | 'opportunity-sweep'
  | 'leaderboard-sweep'
  | 'abuse-sweep'
  | 'health-sweep'
  | 'research-sweep'
  | 'reconciliation'
  | 'ledger-audit';

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
    private readonly resolutions: ResolutionFlowService,
    private readonly support: SupportService,
    private readonly nudges: NudgeService,
    private readonly opportunities: OpportunityService,
    private readonly leaderboards: LeaderboardService,
    private readonly abuse: AbuseService,
    private readonly health: MarketHealthService,
    private readonly research: ResearchService,
    private readonly reconciliation: ReconciliationService,
    private readonly ledgerAudit: LedgerAuditService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const connection = { url: env.REDIS_URL };

    this.queue = new Queue<CloseJob>(QUEUE, { connection });
    this.worker = new Worker<CloseJob>(
      QUEUE,
      async (job) => {
        const { marketId, kind } = job.data;
        const result = await this.handle(kind, marketId);
        logger.info({ marketId, kind, ...result }, 'market deadline handled');
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

  private async handle(kind: CloseKind, marketId: string): Promise<Record<string, unknown>> {
    switch (kind) {
      case 'seeding':
        return this.seeds.closeSeedingRound(marketId);
      case 'dispute':
        return this.resolutions.closeDisputeWindow(marketId);
      case 'freeze-sweep':
        return { frozen: await this.resolutions.freezeDueMarkets() };
      case 'nudge-sweep':
        // §2.14d. The rules decide what is worth saying; the service's own
        // throttle decides who actually hears it.
        return this.nudges.sweep();
      case 'opportunity-sweep': {
        // §2.14b's unmet demand, plus a tidy-up of what nobody claimed.
        const gaps = await this.opportunities.detectSearchGaps({
          since: new Date(Date.now() - 7 * 86_400_000),
        });
        const expired = await this.opportunities.expire();
        return { ...gaps, expired };
      }
      case 'leaderboard-sweep':
        // §2.8's boards. Recomputed rather than incremented: a market settling
        // changes several people's standings at once, and a board rebuilt from
        // the ledger cannot drift from it.
        return this.leaderboards.snapshotAll();
      case 'abuse-sweep':
        // §6.5's queue. Detection only — every freeze is a person's decision.
        return this.abuse.sweep();
      case 'research-sweep':
        // The pipeline decides which sources are actually due from their own
        // cadence, so this can run often and mostly do nothing. Detection and
        // collection only — a pass cannot settle, publish or move money.
        return this.research.pass();
      case 'health-sweep':
        // Part 5 of docs/ticket-creation-checklist.md. Detection only as well:
        // a flag is something for an operator to read on the Manage tab and for
        // the post-mortem to remember. Nothing here touches a market's state.
        return this.health.sweep();
      case 'reconciliation': {
        // §2.7's nightly reconciliation: the ledger against the stored wallet
        // totals, with withdrawals frozen on any mismatch. It had no caller at
        // all, which is why the admin dashboard has read "reconciliation
        // never-run" since the day it was built — accurately, and for months.
        const outcome = await this.reconciliation.run('SPC', new Date());
        return { status: outcome.status, diff: outcome.diff.toString() };
      }
      case 'ledger-audit': {
        // §2.7's nightly invariant check. A violation here is arithmetic on our
        // own rows failing, so it is red by definition and opens an incident.
        const audit = await this.ledgerAudit.run();
        return { clean: audit.clean, findings: audit.findings.length };
      }
      case 'sla-sweep':
        // §2.12's "SLA timers with escalation". A breach is a state of the
        // queue, so it is swept rather than timed per ticket.
        return { escalated: await this.support.escalateOverdue() };
      case 'window':
        return this.community.closeWindow(marketId);
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

  /** Schedule the close of a proposed result's 48h dispute window (§2.6). */
  async scheduleDisputeWindow(marketId: string, closesAt: Date): Promise<void> {
    await this.enqueue(marketId, 'dispute', closesAt);
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

    const windowsOnResults = await this.prisma.market.findMany({
      where: { state: 'dispute_window', disputeClosesAt: { not: null } },
      select: { id: true, disputeClosesAt: true },
    });
    for (const market of windowsOnResults) {
      if (market.disputeClosesAt === null) continue;
      await this.scheduleDisputeWindow(market.id, market.disputeClosesAt);
    }

    // The freeze sweep is a standing job rather than a per-market deadline: it
    // is cheap, it is idempotent, and a market that froze late is a display bug
    // rather than a money one (the trade path checks the clock itself).
    await this.queue?.upsertJobScheduler(
      'freeze-sweep',
      { every: 300_000 },
      { name: 'close', data: { marketId: '', kind: 'freeze-sweep' } },
    );
    await this.queue?.upsertJobScheduler(
      'sla-sweep',
      { every: 300_000 },
      { name: 'close', data: { marketId: '', kind: 'sla-sweep' } },
    );
    // Hourly, not every five minutes: a nudge is a message to a person, and the
    // throttle that keeps it rare is only as good as how often it is asked.
    await this.queue?.upsertJobScheduler(
      'nudge-sweep',
      { every: 3_600_000 },
      { name: 'close', data: { marketId: '', kind: 'nudge-sweep' } },
    );
    await this.queue?.upsertJobScheduler(
      'opportunity-sweep',
      { every: 3_600_000 },
      { name: 'close', data: { marketId: '', kind: 'opportunity-sweep' } },
    );
    // Every fifteen minutes. A leaderboard nobody can watch move is a table,
    // not a competition — but recomputing it per trade would put a full scan on
    // the write path, which §11 forbids outright.
    await this.queue?.upsertJobScheduler(
      'leaderboard-sweep',
      { every: 900_000 },
      { name: 'close', data: { marketId: '', kind: 'leaderboard-sweep' } },
    );
    // Hourly: a flag raised four hours after the fact is still actionable, and
    // the scan is over a week of trades.
    await this.queue?.upsertJobScheduler(
      'abuse-sweep',
      { every: 3_600_000 },
      { name: 'close', data: { marketId: '', kind: 'abuse-sweep' } },
    );
    // Every fifteen minutes. The checklist's Part 5 thresholds are measured in
    // hours and days — 48 hours lopsided, 24 hours of whale, hours to the event
    // — so a quarter-hour sweep is well inside every one of them, and the pass
    // is two grouped queries over what is live.
    await this.queue?.upsertJobScheduler(
      'health-sweep',
      { every: 900_000 },
      { name: 'close', data: { marketId: '', kind: 'health-sweep' } },
    );
    // Every five minutes. `pass()` reads each source's own crawl interval and
    // skips the ones that are not due, so the frequency here is the *floor* on
    // responsiveness rather than the crawl rate: a market settling in an hour
    // wants its source read every two minutes, and it cannot be if nothing asks
    // more often than that.
    await this.queue?.upsertJobScheduler(
      'research-sweep',
      { every: 300_000 },
      { name: 'close', data: { marketId: '', kind: 'research-sweep' } },
    );
    // §2.7's reconciliation, nightly at 02:00 UTC — 03:00 in Lagos, which is
    // the quietest hour on a Nigerian shelf. A cron pattern rather than an
    // interval because `every` counts from the last boot, and a control that
    // freezes withdrawals should not drift onto peak trading because somebody
    // redeployed at lunchtime.
    await this.queue?.upsertJobScheduler(
      'reconciliation',
      { pattern: '0 2 * * *' },
      { name: 'close', data: { marketId: '', kind: 'reconciliation' } },
    );
    // §2.7 says nightly. Six-hourly instead: the check is cheap, and the gap
    // between a broken invariant and somebody knowing about it is the window in
    // which the damage compounds.
    await this.queue?.upsertJobScheduler(
      'ledger-audit',
      { every: 21_600_000 },
      { name: 'close', data: { marketId: '', kind: 'ledger-audit' } },
    );

    return windows.length + rounds.length + windowsOnResults.length;
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

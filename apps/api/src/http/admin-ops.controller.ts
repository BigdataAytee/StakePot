import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { AdminAuditService } from '../audit/admin-audit.service';
import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { rotationStatus } from '../config/secrets';
import { FlagsService } from '../flags/flags.service';
import { CONFIG_KEY_NOTES } from '../platform-config/config-notes';
import { PrismaService } from '../prisma/prisma.service';

/**
 * §6.2's lifecycle controls — the half of the markets console that was missing.
 *
 * Voiding after activation is four-eyes gated and always was. What did not
 * exist was any view of the markets *approaching* the decision: which funding
 * windows are about to close, how far short they are, and who has seeded what.
 * An operator could act but could not look, which meant the first they knew
 * about a window closing short was the refund.
 */
@Controller('admin/lifecycle')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'finance', 'resolver')
export class LifecycleController {
  constructor(private readonly prisma: PrismaService) {}

  /** Funding windows, soonest to close first. */
  @Get('funding')
  async funding(@Query('hours') hours?: string) {
    const horizon = Math.min(Math.max(Number(hours) || 72, 1), 720);
    const until = new Date(Date.now() + horizon * 3_600_000);

    const markets = await this.prisma.market.findMany({
      where: { state: { in: ['funding', 'draft', 'seeding'] } },
      include: {
        outcomes: {
          select: { id: true, label: true, stakedTotal: true },
          orderBy: { ordinal: 'asc' },
        },
        _count: { select: { trades: true } },
      },
      orderBy: [{ fundingClosesAt: 'asc' }],
      take: 100,
    });

    return markets
      .filter((market) => market.fundingClosesAt === null || market.fundingClosesAt <= until)
      .map((market) => {
        const staked = market.outcomes.map((outcome) => Number(outcome.stakedTotal));
        return {
          id: market.id,
          question: market.question,
          state: market.state,
          shelf: market.shelf,
          activationPath: market.activationPath,
          closesAt: market.fundingClosesAt?.toISOString() ?? null,
          pot: market.potTotal.toString(),
          trades: market._count.trades,
          outcomes: market.outcomes.map((outcome, index) => ({
            label: outcome.label,
            staked: outcome.stakedTotal.toString(),
            // The number that decides whether this voids: an outcome with
            // nothing on it is what fails a per-outcome floor, and it is
            // invisible in a pot total.
            funded: (staked[index] ?? 0) > 0,
          })),
          fundedOutcomes: staked.filter((value) => value > 0).length,
        };
      });
  }

  /** §6.2's seed/syndicate composition view. */
  @Get('markets/:id/composition')
  async composition(@Param('id') marketId: string) {
    const [market, syndicates, bonds] = await Promise.all([
      this.prisma.market.findUnique({
        where: { id: marketId },
        select: {
          id: true,
          question: true,
          state: true,
          activationPath: true,
          creatorId: true,
          potTotal: true,
          outcomes: { select: { label: true, stakedTotal: true }, orderBy: { ordinal: 'asc' } },
        },
      }),
      this.prisma.syndicate.findMany({
        where: { marketId },
        include: {
          members: {
            select: {
              userId: true,
              contribution: true,
              feeSharePct: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.bond.findMany({ where: { marketId } }),
    ]);

    if (market === null) throw new BadRequestException('no such market');

    return {
      market: {
        id: market.id,
        question: market.question,
        state: market.state,
        activationPath: market.activationPath,
        creatorId: market.creatorId,
        pot: market.potTotal.toString(),
      },
      outcomes: market.outcomes.map((outcome) => ({
        label: outcome.label,
        staked: outcome.stakedTotal.toString(),
      })),
      syndicates: syndicates.map((syndicate) => ({
        id: syndicate.id,
        state: syndicate.state,
        target: syndicate.minTotal.toString(),
        perOutcomeMin: syndicate.perOutcomeMin.toString(),
        raised: syndicate.members
          .reduce((sum, member) => sum + Number(member.contribution), 0)
          .toFixed(2),
        organiserBps: syndicate.organiserBps,
        maxSponsors: syndicate.maxSponsors,
        roundEndsAt: syndicate.roundEndsAt.toISOString(),
        members: syndicate.members.map((member) => ({
          userId: member.userId,
          amount: member.contribution.toString(),
          feeShare: member.feeSharePct.toString(),
          joinedAt: member.createdAt.toISOString(),
        })),
      })),
      bonds: bonds.map((bond) => ({
        id: bond.id,
        creatorId: bond.creatorId,
        amount: bond.amount.toString(),
        state: bond.state,
      })),
    };
  }
}

/**
 * §6.4b's Platform Config Console.
 *
 * The service, the versioning and the 24-hour delay have existed since step 8.
 * What was missing is the console itself — and specifically the two things
 * that make §6.4b a "maximum-security zone" rather than a settings page: a
 * stated blast radius per parameter, and a visible diff of what a pending
 * change will do and when.
 *
 * The blast radius is not decoration. `exit_fee_rate` and `comment_max_length`
 * are both one number in one table, and one of them changes what every member
 * pays. A console that renders them identically invites somebody to treat them
 * identically.
 *
 * Step-up 2FA is not re-implemented here: a config change is an `approvals`
 * proposal, and the approve endpoint already demands a TOTP code. Adding a
 * second challenge on opening a read-only screen would train operators to type
 * codes on demand, which is the habit every credential-phishing attack needs.
 */
@Controller('admin/config')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'finance')
export class ConfigConsoleController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async console() {
    const [live, pending, history] = await Promise.all([
      this.prisma.platformConfig.findMany({ where: { state: 'active' } }),
      this.prisma.platformConfig.findMany({
        where: { state: 'pending' },
        orderBy: { effectiveAt: 'asc' },
      }),
      this.prisma.configVersion.findMany({ orderBy: { proposedAt: 'desc' }, take: 40 }),
    ]);

    const current = new Map(live.map((row) => [row.key, row.valueJson]));

    return {
      keys: live
        .map((row) => ({
          key: row.key,
          value: row.valueJson,
          version: row.version,
          note: CONFIG_KEY_NOTES[row.key] ?? null,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),

      // Each pending change beside the value it replaces, and when it lands.
      // §6.4b's delay is only a safeguard if somebody can see the clock.
      pending: pending.map((row) => ({
        key: row.key,
        from: current.get(row.key) ?? null,
        to: row.valueJson,
        version: row.version,
        effectiveAt: row.effectiveAt.toISOString(),
        note: CONFIG_KEY_NOTES[row.key] ?? null,
      })),

      history: history.map((row) => ({
        key: row.key,
        from: row.oldValue,
        to: row.newValue,
        reason: row.reason,
        proposedBy: row.proposedBy,
        approvedBy: row.approvedBy,
        proposedAt: row.proposedAt.toISOString(),
        activatedAt: row.activatedAt?.toISOString() ?? null,
      })),
    };
  }
}

export class FlagDto {
  @IsString() @MinLength(2) @MaxLength(60) key!: string;
  @IsString() @MaxLength(200) description!: string;
  @IsBoolean() enabled!: boolean;
  @IsInt() @Min(0) @Max(100) rolloutPct!: number;
  @IsOptional() @IsArray() @IsString({ each: true }) allowList?: string[];
}

export class BroadcastDto {
  @IsString() @MinLength(3) @MaxLength(120) title!: string;
  @IsString() @MinLength(3) @MaxLength(1000) body!: string;
  @IsIn(['all', 'tier1', 'creators', 'dormant']) segment!: string;
}

/**
 * §6.8's content and growth console: the three screens that did not exist.
 *
 * Top Calls curation lives in `reputation.controller.ts` with the job that
 * feeds it. This is flags and broadcasts.
 */
@Controller('admin/growth')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'support')
export class GrowthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FlagsService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get('flags')
  async listFlags() {
    return this.flags.list();
  }

  @Post('flags')
  async saveFlag(@Req() request: RequestWithUser, @Body() body: FlagDto) {
    const staffId = request.user?.userId ?? 'unknown';
    const before = await this.prisma.featureFlag.findUnique({ where: { key: body.key } });

    const flag = await this.flags.upsert({
      key: body.key,
      description: body.description,
      enabled: body.enabled,
      rolloutPct: body.rolloutPct,
      allowList: body.allowList ?? [],
      staffId,
    });

    await this.audit.record({
      staffId,
      action: 'flag.set',
      targetRef: `flag:${body.key}`,
      ...(before === null
        ? {}
        : { before: { enabled: before.enabled, rolloutPct: before.rolloutPct } }),
      after: { enabled: flag.enabled, rolloutPct: flag.rolloutPct },
      ip: request.ip ?? 'unknown',
    });

    return flag;
  }

  @Get('broadcasts')
  async listBroadcasts() {
    return this.prisma.broadcast.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  }

  /**
   * Draft a broadcast. Drafting is not sending.
   *
   * A message to every member is the one console action that cannot be taken
   * back, so it is written, then read by somebody else, then sent — the same
   * shape as a four-eyes money action, for the same reason.
   */
  @Post('broadcasts')
  async draftBroadcast(@Req() request: RequestWithUser, @Body() body: BroadcastDto) {
    const staffId = request.user?.userId ?? 'unknown';

    const broadcast = await this.prisma.broadcast.create({
      data: {
        title: body.title,
        body: body.body,
        segment: body.segment,
        createdBy: staffId,
      },
    });

    await this.audit.record({
      staffId,
      action: 'broadcast.draft',
      targetRef: `broadcast:${broadcast.id}`,
      after: { title: body.title, segment: body.segment },
      ip: request.ip ?? 'unknown',
    });

    return broadcast;
  }

  /** How many accounts a segment would reach, before anybody commits to it. */
  @Get('broadcasts/:id/reach')
  async reach(@Param('id') id: string) {
    const broadcast = await this.prisma.broadcast.findUnique({ where: { id } });
    if (broadcast === null) throw new BadRequestException('no such broadcast');
    return { segment: broadcast.segment, recipients: await this.countSegment(broadcast.segment) };
  }

  @Post('broadcasts/:id/send')
  async send(@Req() request: RequestWithUser, @Param('id') id: string) {
    const staffId = request.user?.userId ?? 'unknown';
    const broadcast = await this.prisma.broadcast.findUnique({ where: { id } });
    if (broadcast === null) throw new BadRequestException('no such broadcast');
    if (broadcast.sentAt !== null) throw new BadRequestException('already sent');

    // Four eyes, in the plainest possible form: whoever wrote it cannot be the
    // one who sends it.
    if (broadcast.createdBy === staffId) {
      throw new BadRequestException(
        'a broadcast has to be sent by someone other than whoever drafted it',
      );
    }

    const recipients = await this.recipientsOf(broadcast.segment);

    await this.prisma.notification.createMany({
      data: recipients.map((userId) => ({
        userId,
        type: 'broadcast',
        payloadJson: { title: broadcast.title, body: broadcast.body },
        channel: 'in_app' as const,
      })),
    });

    const sent = await this.prisma.broadcast.update({
      where: { id },
      data: { sentAt: new Date(), approvedBy: staffId, recipients: recipients.length },
    });

    await this.audit.record({
      staffId,
      action: 'broadcast.send',
      targetRef: `broadcast:${id}`,
      after: { recipients: recipients.length, segment: broadcast.segment },
      ip: request.ip ?? 'unknown',
    });

    return sent;
  }

  private segmentWhere(segment: string) {
    const dormantSince = new Date(Date.now() - 30 * 86_400_000);
    switch (segment) {
      case 'tier1':
        return { tier: { gte: 1 }, status: 'active' };
      case 'creators':
        return { markets: { some: {} }, status: 'active' };
      case 'dormant':
        return { status: 'active', trades: { none: { createdAt: { gte: dormantSince } } } };
      default:
        return { status: 'active' };
    }
  }

  private async countSegment(segment: string): Promise<number> {
    return this.prisma.user.count({ where: this.segmentWhere(segment) });
  }

  private async recipientsOf(segment: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: this.segmentWhere(segment),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

/**
 * §6.9's system room.
 *
 * "Queue/worker status, deploy & canary controls, alert history,
 * backup/restore drill logs, status-page incident posting."
 *
 * Deliberately read-mostly. The one thing an engineering console must do under
 * pressure is tell you the truth quickly; every control it grows is another
 * thing to get wrong at 3am, and the two that matter — flags and incidents —
 * already have their own screens.
 */
@Controller('admin/system')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class SystemRoomController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async room() {
    const dayAgo = new Date(Date.now() - 86_400_000);

    const [drills, incidents, recentAudit, queues, flags] = await Promise.all([
      this.prisma.restoreDrill.findMany({ orderBy: { ranAt: 'desc' }, take: 10 }),
      this.prisma.statusIncident.findMany({ orderBy: { startedAt: 'desc' }, take: 10 }),
      this.prisma.adminAudit.findMany({ orderBy: { ts: 'desc' }, take: 20 }),
      this.queueDepths(),
      this.prisma.featureFlag.findMany({ where: { enabled: true } }),
    ]);

    const lastDrill = drills[0] ?? null;
    const drillAgeDays =
      lastDrill === null ? null : Math.floor((Date.now() - lastDrill.ranAt.getTime()) / 86_400_000);

    return {
      backups: {
        lastDrill:
          lastDrill === null
            ? null
            : {
                ranAt: lastDrill.ranAt.toISOString(),
                passed: lastDrill.passed,
                durationSec: lastDrill.durationSec,
                backupRef: lastDrill.backupRef,
                notes: lastDrill.notes,
              },
        ageDays: drillAgeDays,
        // Looser than the monthly cadence on purpose: an alarm that fires the
        // day after a target is missed gets muted, and a muted alarm is worse
        // than no alarm.
        stale: drillAgeDays === null || drillAgeDays > 45,
        history: drills.map((drill) => ({
          ranAt: drill.ranAt.toISOString(),
          passed: drill.passed,
          durationSec: drill.durationSec,
        })),
      },
      queues,
      // Ids and counts, never material. A console that can print a key is a
      // console that leaks one.
      keys: rotationStatus(),
      canary: flags.map((flag) => ({
        key: flag.key,
        rolloutPct: flag.rolloutPct,
        updatedAt: flag.updatedAt.toISOString(),
      })),
      incidents: incidents.map((incident) => ({
        id: incident.id,
        title: incident.title,
        state: incident.state,
        severity: incident.severity,
        startedAt: incident.startedAt.toISOString(),
      })),
      audit: recentAudit.map((row) => ({
        staffId: row.staffId,
        action: row.action,
        targetRef: row.targetRef,
        at: row.ts.toISOString(),
      })),
      since: dayAgo.toISOString(),
    };
  }

  /**
   * What is waiting on a person or a worker.
   *
   * Not a message-broker depth — the work in this system queues in Postgres,
   * and the honest measure of "are we behind" is how many rows are sitting in
   * a state something should have moved them out of.
   */
  private async queueDepths() {
    const now = new Date();

    const [approvals, disputes, drafts, resultsDue, windowsOverdue, unsentNotifications] =
      await Promise.all([
        this.prisma.approval.count({ where: { state: 'pending' } }),
        this.prisma.dispute.count({ where: { state: 'open' } }),
        this.prisma.marketDraft.count({ where: { state: 'suggested' } }),
        this.prisma.market.count({ where: { state: 'frozen' } }),
        // A funding window past its close that is still `funding` means the
        // worker has not run. This is the one number here that indicates a
        // broken process rather than a busy team.
        this.prisma.market.count({
          where: { state: 'funding', fundingClosesAt: { lt: now } },
        }),
        this.prisma.notification.count({ where: { sentAt: null } }),
      ]);

    return {
      pendingApprovals: approvals,
      openDisputes: disputes,
      draftsWaiting: drafts,
      resultsDue,
      overdueFundingWindows: windowsOverdue,
      unsentNotifications,
    };
  }
}

export class LevelOverrideDto {
  @IsInt() @Min(1) @Max(3) level!: number;
  @IsString() @MinLength(10) @MaxLength(300) reason!: string;
}

export class TemplateCurationDto {
  @IsBoolean() active!: boolean;
}

/**
 * §6.6's creators desk.
 *
 * The creator data, the ladder and the bonds have all existed since step 11.
 * What did not exist is the desk: one screen where somebody responsible for
 * creators can see who is running what, which bonds are held against which
 * markets, and act on both.
 *
 * Bond slash and refund are conspicuously *not* endpoints here. Both move
 * money, §2.10 makes bond forfeiture a four-eyes action, and the approvals
 * inbox already implements it properly. What this screen does is surface the
 * bond beside the creator's record so a proposal is raised with the context in
 * front of you — a second, simpler path to forfeiting a bond would be exactly
 * the god button §6 forbids.
 */
@Controller('admin/creators')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'trust_safety')
export class CreatorsDeskController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  async desk(@Query('q') query?: string) {
    const profiles = await this.prisma.creatorProfile.findMany({
      where:
        query === undefined || query.trim().length === 0
          ? {}
          : {
              user: {
                OR: [
                  { handle: { contains: query, mode: 'insensitive' } },
                  { displayName: { contains: query, mode: 'insensitive' } },
                ],
              },
            },
      include: { user: { select: { id: true, handle: true, displayName: true, status: true } } },
      orderBy: { totalVolumeHosted: 'desc' },
      take: 50,
    });

    const ids = profiles.map((profile) => profile.userId);

    const [bonds, live] = await Promise.all([
      this.prisma.bond.findMany({
        where: { creatorId: { in: ids }, state: 'held' },
        select: { id: true, creatorId: true, marketId: true, amount: true, state: true },
      }),
      this.prisma.market.groupBy({
        by: ['creatorId'],
        where: {
          creatorId: { in: ids },
          state: { in: ['draft', 'seeding', 'funding', 'active', 'frozen', 'dispute_window'] },
        },
        _count: { _all: true },
      }),
    ]);

    const liveBy = new Map(live.map((row) => [row.creatorId, row._count._all]));

    return profiles.map((profile) => ({
      userId: profile.userId,
      handle: profile.user.handle,
      displayName: profile.user.displayName,
      status: profile.user.status,
      level: profile.level,
      cleanResolutions: profile.cleanResolutions,
      disputedResolutions: profile.disputedResolutions,
      voidedAfterActivation: profile.voidedAfterActivation,
      volumeHosted: profile.totalVolumeHosted.toString(),
      followers: profile.followerCount,
      levelUpdatedAt: profile.levelUpdatedAt?.toISOString() ?? null,
      liveMarkets: liveBy.get(profile.userId) ?? 0,
      // Held bonds, with their markets, so a forfeit proposal can be raised
      // from here with the reference already in hand.
      bonds: bonds
        .filter((bond) => bond.creatorId === profile.userId)
        .map((bond) => ({
          id: bond.id,
          marketId: bond.marketId,
          amount: bond.amount.toString(),
          state: bond.state,
        })),
    }));
  }

  /**
   * §6.6's level management.
   *
   * An override, not a recomputation: the ladder is a pure rule and it stays
   * the source of truth, so this exists for the cases the rule cannot see —
   * a creator being wound down after a Trust and Safety finding, or one
   * promoted for a reason the counters do not carry. It demands a reason and
   * it is audited, because a level changed without either is indistinguishable
   * from a mistake.
   */
  @Post(':id/level')
  async setLevel(
    @Req() request: RequestWithUser,
    @Param('id') userId: string,
    @Body() body: LevelOverrideDto,
  ) {
    const staffId = request.user?.userId ?? 'unknown';
    const before = await this.prisma.creatorProfile.findUnique({ where: { userId } });
    if (before === null) throw new BadRequestException('no such creator');

    const after = await this.prisma.creatorProfile.update({
      where: { userId },
      data: { level: body.level, levelUpdatedAt: new Date() },
    });

    await this.audit.record({
      staffId,
      action: 'creator.level_override',
      targetRef: `creator:${userId}`,
      before: { level: before.level },
      after: { level: after.level, reason: body.reason },
      ip: request.ip ?? 'unknown',
    });

    return { level: after.level };
  }

  /** §6.6's template library curation. */
  @Get('templates')
  async templates() {
    return this.prisma.ticketTemplate.findMany({ orderBy: { category: 'asc' } });
  }

  @Post('templates/:id')
  async curate(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Body() body: TemplateCurationDto,
  ) {
    const template = await this.prisma.ticketTemplate.update({
      where: { id },
      data: { active: body.active },
    });

    await this.audit.record({
      staffId: request.user?.userId ?? 'unknown',
      action: body.active ? 'template.publish' : 'template.unpublish',
      targetRef: `template:${id}`,
      after: { active: template.active },
      ip: request.ip ?? 'unknown',
    });

    return template;
  }
}

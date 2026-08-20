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
import { type TicketDraft } from '@stakeam/rules';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
import { CrawlHealthService } from '../intel/crawl-health.service';
import { ResearchService } from '../intel/research.service';
import { SourceRegistryError, SourceRegistryService } from '../intel/source-registry.service';
import { ApprovalError, ApprovalsService } from '../approvals/approvals.service';
import { FreezeError, MarketFreezeService } from '../market/freeze.service';
import { MarketHealthService } from '../market/health.service';
import { StudioError, StudioService } from '../market/studio.service';

class OutcomeDto {
  @IsString() @MinLength(1) @MaxLength(80) label!: string;
  @IsString() @MaxLength(600) criteria!: string;
}

/**
 * A market as the wizard has it so far.
 *
 * Everything optional except the shape, and deliberately: the wizard reviews on
 * every step, so it posts half a market for most of the session. A DTO that
 * insisted on a complete one would mean the checklist could only ever run at
 * the end — which is exactly the review-at-the-last-moment the Studio exists to
 * replace.
 */
export class StudioDraftDto {
  @IsString() @MaxLength(300) question!: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => OutcomeDto) outcomes!: OutcomeDto[];

  @IsOptional() @IsString() @MaxLength(80) otherLabel?: string;
  @IsString() @MaxLength(160) sourceName!: string;
  @IsString() @MaxLength(500) sourceUrl!: string;
  @IsString() eventDate!: string;
  @IsString() voidDate!: string;
  @IsObject() edgeCases!: Record<string, string>;
  @IsOptional() @IsArray() balanceEstimates?: number[];
  @IsOptional() @IsString() liquidityParam?: string;
  @IsOptional() @IsString() expectedStake?: string;
  @IsOptional() @IsString() @MaxLength(60) category?: string;
  @IsOptional() @IsArray() tags?: string[];
  @IsOptional() @IsString() @MaxLength(60) icon?: string;
  @IsOptional() @IsBoolean() blockbuster?: boolean;
}

export class ReviewDto {
  @ValidateNested() @Type(() => StudioDraftDto) draft!: StudioDraftDto;
  @IsOptional() @IsObject() confirmations?: Record<string, boolean>;
  @IsOptional() @IsBoolean() attestedNoInfluence?: boolean;
}

export class PublishDto extends ReviewDto {
  @IsOptional() @IsString() seedPerOutcome?: string;
  /** Why, when publishing over a checklist warning. */
  @IsOptional() @IsString() @MaxLength(400) warningReason?: string;
}

/**
 * The Market Studio's back end (§6.2, and the ticket-creation checklist).
 *
 * Three endpoints for three tabs. `review` is the one that matters: the wizard
 * calls it on every step and the review screen calls it before publishing, so
 * what a reviewer is shown is produced by the same call that decides whether
 * the market may open. A review screen computing its own verdict is a review
 * screen that can be wrong in the reassuring direction.
 */
/**
 * Which sources to switch, and why.
 *
 * Declared above the controller, and that is not style. `emitDecoratorMetadata`
 * evaluates a parameter's type where the method is defined, so a DTO declared
 * below the class that uses it is still in its temporal dead zone at that
 * moment — this compiled, typechecked and passed every test, then died on boot
 * with "Cannot access 'SourceSwitchDto' before initialization".
 */
/**
 * How far to roll the dates when repeating a market.
 *
 * Above the controller like every DTO here, and for a reason worth writing
 * down once: `emitDecoratorMetadata` reads a parameter's type where the method
 * is defined, so one declared below the class it is used in sits in its
 * temporal dead zone and the API dies on boot having compiled, typechecked and
 * passed every test.
 */
export class NextInSeriesDto {
  @IsIn(['weekly', 'fortnightly', 'monthly']) cadence!: 'weekly' | 'fortnightly' | 'monthly';
}

export class SourceEntryDto {
  @IsIn(['resolution', 'news', 'signal']) tier!: 'resolution' | 'news' | 'signal';
  @IsIn(['api', 'rss', 'sitemap', 'crawl']) kind!: 'api' | 'rss' | 'sitemap' | 'crawl';
  @IsString() @MaxLength(120) name!: string;
  @IsString() @MaxLength(400) homeUrl!: string;
  @IsOptional() @IsString() @MaxLength(400) feedUrl?: string;
  @IsOptional() @IsArray() categories?: string[];
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional()
  @IsIn(['auto', 'urgent', 'normal', 'background'])
  cadence?: 'auto' | 'urgent' | 'normal' | 'background';
  @IsOptional() @IsString() @MaxLength(60) publishWindow?: string;
}

/** A list of sources to add or update. See docs/research-sources.md. */
export class ImportSourcesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => SourceEntryDto) sources!: SourceEntryDto[];
}

export class SourceSwitchDto {
  @IsIn(['source', 'tier', 'all']) scope!: 'source' | 'tier' | 'all';
  @IsOptional() @IsString() sourceId?: string;
  @IsOptional() @IsIn(['resolution', 'news', 'signal']) tier?: string;
  @IsBoolean() enabled!: boolean;
  /** Required to switch something off; the service refuses a thin one. */
  @IsOptional() @IsString() @MaxLength(400) reason?: string;
}

/**
 * An emergency freeze: stop trading now, on any market, with a reason.
 *
 * Above the controller like every DTO in this file. `emitDecoratorMetadata`
 * reads a parameter's type where the method is defined, so one declared below
 * the class sits in its temporal dead zone and the API dies on boot having
 * compiled, typechecked and passed every test.
 */
export class FreezeNowDto {
  @IsString() @MaxLength(400) reason!: string;
}

/** Move a freeze time that has not arrived yet. */
export class AmendFreezeDto {
  @IsISO8601() freezeAt!: string;
  @IsOptional() @IsISO8601() eventDate?: string;
  @IsString() @MaxLength(400) reason!: string;
}

/** Propose reopening a frozen market. Two people, or it does not happen. */
export class UnfreezeDto {
  @IsISO8601() freezeAt!: string;
  @IsString() @MaxLength(400) reason!: string;
}

@Controller('admin/studio')
export class StudioController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studio: StudioService,
    private readonly health: MarketHealthService,
    private readonly crawl: CrawlHealthService,
    private readonly research: ResearchService,
    private readonly sources: SourceRegistryService,
    private readonly freezes: MarketFreezeService,
    private readonly approvals: ApprovalsService,
  ) {}

  /** Run the whole checklist over whatever the wizard currently has. */
  @Post('review')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async review(@Body() body: ReviewDto) {
    return this.studio.reviewDraft(draftOf(body.draft), {
      ...(body.attestedNoInfluence === undefined
        ? {}
        : { attestedNoInfluence: body.attestedNoInfluence }),
      ...(body.confirmations === undefined ? {} : { confirmations: body.confirmations }),
    });
  }

  /** Open the market. The checklist runs again here, whatever the screen said. */
  @Post('publish')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async publish(@Req() request: RequestWithUser, @Body() body: PublishDto) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    try {
      return await this.studio.publish({
        draft: draftOf(body.draft),
        staffId: user.userId,
        ip: request.ip ?? 'unknown',
        ...(body.draft.liquidityParam === undefined
          ? {}
          : { liquidityParam: body.draft.liquidityParam }),
        ...(body.seedPerOutcome === undefined ? {} : { seedPerOutcome: body.seedPerOutcome }),
        ...(body.attestedNoInfluence === undefined
          ? {}
          : { attestedNoInfluence: body.attestedNoInfluence }),
        ...(body.confirmations === undefined ? {} : { confirmations: body.confirmations }),
        ...(body.warningReason === undefined ? {} : { warningReason: body.warningReason }),
      });
    } catch (error) {
      if (error instanceof StudioError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * The Research tab: is the pipeline actually finding anything?
   *
   * A research pipeline fails silently by construction — a feed that quietly
   * stops carrying a section, or markup that changed so every fetch returns
   * zero items, throws nothing and logs success. The failure is an absence, and
   * absences are invisible until something counts them.
   */
  @Get('crawl')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async crawlHealth() {
    return this.crawl.report();
  }

  /**
   * The template library, retired entries included.
   *
   * Read-only here. Retiring one is a decision that changes what every creator
   * is offered, and it stays on the creators-desk route that already audits it
   * — widening a mutation's roles to save a screen one fetch is how a
   * permission matrix stops meaning anything.
   */
  @Get('templates')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async templates() {
    return this.studio.templates();
  }

  /** Settled markets worth running again, with what happened last time. */
  @Get('series')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async series() {
    return this.studio.repeatable();
  }

  /**
   * The next one in a series, as a draft for the wizard.
   *
   * Publishes nothing. What comes back goes through the same checklist as
   * anything typed by hand, which is the point: a repeat is exactly the market
   * that gets waved through because the last one was fine.
   */
  @Post('markets/:id/next')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async nextInSeries(@Param('id') id: string, @Body() body: NextInSeriesDto) {
    try {
      return await this.studio.nextInSeries({ marketId: id, cadence: body.cadence });
    } catch (error) {
      if (error instanceof StudioError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * Stop trading on a market now.
   *
   * The cases this is for: a result has leaked, a fixture was abandoned, or the
   * outcome is known to somebody before the clock says it should be. All three
   * have the same shape — the market's own countdown is wrong, and every minute
   * it stays open is a minute an informed trader can take money off an
   * uninformed one.
   *
   * One person, deliberately. Freezing is the *safe* direction: the worst a bad
   * freeze does is stop trading early on a market that will settle normally
   * anyway, and requiring a second signature would mean waiting for one while
   * the leak spreads. Reopening is the direction that needs two.
   */
  @Post('markets/:id/freeze')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async freezeNow(
    @Param('id') id: string,
    @Req() request: RequestWithUser,
    @Body() body: FreezeNowDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    try {
      return await this.freezes.freeze({
        marketId: id,
        reason: body.reason,
        actor: { userId: user.userId, ip: request.ip ?? 'unknown' },
      });
    } catch (error) {
      if (error instanceof FreezeError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * Move a freeze time that has not arrived.
   *
   * A fixture rescheduled. Audited and announced to holders, because a trader
   * planning around a countdown is owed the news that it moved — an audit row
   * is not something they read.
   */
  @Post('markets/:id/freeze-at')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async amendFreeze(
    @Param('id') id: string,
    @Req() request: RequestWithUser,
    @Body() body: AmendFreezeDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    try {
      return await this.freezes.amend({
        marketId: id,
        freezeAt: new Date(body.freezeAt),
        ...(body.eventDate === undefined ? {} : { eventDate: new Date(body.eventDate) }),
        reason: body.reason,
        actor: { userId: user.userId, ip: request.ip ?? 'unknown' },
      });
    } catch (error) {
      if (error instanceof FreezeError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * Propose reopening a frozen market. Returns a proposal, not a reopened
   * market.
   *
   * Through the four-eyes workflow rather than as its own endpoint, so it lands
   * in the same inbox as a void and a bond forfeiture and cannot be executed by
   * whoever asked for it. If the event really did start, reopening hands an
   * informed trader a market full of people who have not seen the score — which
   * is the asymmetry the freeze exists to prevent, performed on purpose.
   */
  @Post('markets/:id/unfreeze')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async proposeUnfreeze(
    @Param('id') id: string,
    @Req() request: RequestWithUser,
    @Body() body: UnfreezeDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    try {
      const approval = await this.approvals.propose({
        actionType: 'market.unfreeze',
        payload: { marketId: id, freezeAt: new Date(body.freezeAt).toISOString() },
        reason: body.reason,
        actor: { userId: user.userId, role: user.role as never, ip: request.ip ?? 'unknown' },
      });
      return { approvalId: approval.id, state: approval.state };
    } catch (error) {
      if (error instanceof ApprovalError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * The freeze desk: what is about to stop, what has stopped, and what should
   * have.
   *
   * The third list is the one worth having. A market past its event date and
   * still trading means the sweep is not running — and the symptom of that is
   * an absence, which is invisible unless something counts it. The money path
   * refuses those trades anyway, so this is a defect alarm rather than an open
   * door; but a defect alarm nobody can see is a defect.
   */
  @Get('freezes')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async freezeDesk() {
    const now = new Date();
    const soon = new Date(now.getTime() + 6 * 3_600_000);

    const [freezingSoon, frozen, overdue] = await Promise.all([
      this.prisma.market.findMany({
        where: {
          state: { in: ['seeding', 'funding', 'active'] },
          freezeAt: { gt: now, lte: soon },
        },
        orderBy: { freezeAt: 'asc' },
        take: 50,
      }),
      this.prisma.market.findMany({
        where: { state: 'frozen' },
        orderBy: { frozenAt: 'asc' },
        take: 100,
      }),
      this.prisma.market.findMany({
        where: {
          state: { in: ['seeding', 'funding', 'active'] },
          OR: [{ freezeAt: { lte: now } }, { freezeAt: null, eventDate: { lte: now } }],
        },
        orderBy: { eventDate: 'asc' },
        take: 50,
      }),
    ]);

    const row = (market: (typeof frozen)[number]) => ({
      id: market.id,
      question: market.question,
      shelf: market.shelf,
      state: market.state,
      eventDate: market.eventDate.toISOString(),
      freezeAt: market.freezeAt?.toISOString() ?? null,
      frozenAt: market.frozenAt?.toISOString() ?? null,
      freezeReason: market.freezeReason,
      pot: market.potTotal.toString(),
    });

    return {
      freezingSoon: freezingSoon.map(row),
      frozen: frozen.map(row),
      // Past its time and still open. Either the sweep is not running or it is
      // failing on these rows; both need somebody to look.
      overdue: overdue.map(row),
      builtAt: now.toISOString(),
    };
  }

  /**
   * Bulk-import sources.
   *
   * Upserts on (tier, homeUrl), so re-importing a list is safe and preserves
   * each source's earned trust — a re-import is usually somebody adding three
   * rows to a file of eighty, and resetting eighty trust scores to seed the
   * three would be a strange way to do it.
   *
   * Admin rather than resolver: a Tier 1 source is one a market may name and
   * settle against, so adding one is closer to publishing than to reading.
   */
  @Post('sources/import')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async importSources(@Req() request: RequestWithUser, @Body() body: ImportSourcesDto) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    try {
      return await this.sources.importSources({
        sources: body.sources,
        staffId: user.userId,
        ip: request.ip ?? 'unknown',
      });
    } catch (error) {
      if (error instanceof SourceRegistryError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * Run a research pass now, rather than waiting for the sweep.
   *
   * The sweep runs every five minutes and each source decides for itself
   * whether it is due, which is right for steady state and useless when
   * somebody has just added a source and wants to know whether it works. This
   * makes the pipeline observable on demand: press it, read the counts.
   *
   * Collection only. A pass reads sources, stores items and links them; it
   * cannot publish, settle or move money.
   */
  @Post('crawl/pass')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async runPass() {
    return this.research.pass();
  }

  /**
   * The kill switch: one source, a whole tier, or everything.
   *
   * Admin rather than resolver. Switching off a tier stops every market's
   * context panel updating at once, which is a decision with the same weight as
   * publishing one — and turning something *off* still requires a reason,
   * because a source killed at 3am has to be explicable at 9.
   */
  @Post('sources/enabled')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async setSourceEnabled(@Req() request: RequestWithUser, @Body() body: SourceSwitchDto) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const scope =
      body.scope === 'all'
        ? ('all' as const)
        : body.scope === 'tier'
          ? { tier: body.tier as never }
          : { sourceId: body.sourceId ?? '' };

    try {
      return await this.sources.setEnabled({
        scope,
        enabled: body.enabled,
        reason: body.reason ?? '',
        staffId: user.userId,
        ip: request.ip ?? 'unknown',
      });
    } catch (error) {
      if (error instanceof SourceRegistryError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * The Manage tab: every market that is not finished, with its Part 5 flags.
   *
   * Flags rather than a separate alerts screen. A list of problems detached
   * from the markets they belong to is a list somebody has to reconcile by
   * hand, and the reconciling is where things get missed.
   */
  @Get('markets')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async markets(@Query('state') state?: string) {
    const now = new Date();
    const markets = await this.prisma.market.findMany({
      where: {
        ...(state === undefined || state === 'all' ? {} : { state: state as never }),
        ...(state === undefined
          ? {
              state: {
                in: [
                  'draft',
                  'seeding',
                  'funding',
                  'active',
                  'frozen',
                  'pending_resolution',
                  'dispute_window',
                ],
              },
            }
          : {}),
      },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
      orderBy: [{ eventDate: 'asc' }],
      take: 200,
    });

    if (markets.length === 0) return [];

    // Both the flag computation and the holder counts come from the monitoring
    // service, not from a second copy of the same query here. The sweep that
    // records these flags every fifteen minutes and this screen have to agree
    // about what is firing — a Manage tab that disagreed with the post-mortem
    // written from the same rules would make both unbelievable.
    const flagsBy = await this.health.standingFlagsFor(markets, now);
    const holdersBy = await this.health.holderCountsFor(markets.map((market) => market.id));

    return markets.map((market) => {
      return {
        id: market.id,
        question: market.question,
        shelf: market.shelf,
        state: market.state,
        sourceName: market.sourceName,
        eventDate: market.eventDate.toISOString(),
        voidDate: market.voidDate.toISOString(),
        createdAt: market.createdAt.toISOString(),
        pot: market.potTotal.toString(),
        volume24h: null,
        holders: holdersBy.get(market.id)?.count ?? 0,
        outcomes: market.outcomes.map((outcome) => ({
          id: outcome.id,
          label: outcome.label,
          price: outcome.priceCurrent.toString(),
          staked: outcome.stakedTotal.toString(),
        })),
        flags: flagsBy.get(market.id) ?? [],
      };
    });
  }
}

/** The DTO as the rules package wants it — optional means absent, not null. */
function draftOf(dto: StudioDraftDto): TicketDraft {
  return {
    question: dto.question,
    outcomes: dto.outcomes,
    ...(dto.otherLabel === undefined ? {} : { otherLabel: dto.otherLabel }),
    sourceName: dto.sourceName,
    sourceUrl: dto.sourceUrl,
    eventDate: dto.eventDate,
    voidDate: dto.voidDate,
    edgeCases: dto.edgeCases,
    ...(dto.balanceEstimates === undefined ? {} : { balanceEstimates: dto.balanceEstimates }),
    ...(dto.liquidityParam === undefined ? {} : { liquidityParam: dto.liquidityParam }),
    ...(dto.expectedStake === undefined ? {} : { expectedStake: dto.expectedStake }),
    ...(dto.category === undefined ? {} : { category: dto.category }),
    ...(dto.tags === undefined ? {} : { tags: dto.tags }),
    ...(dto.icon === undefined ? {} : { icon: dto.icon }),
    ...(dto.blockbuster === undefined ? {} : { blockbuster: dto.blockbuster }),
  };
}

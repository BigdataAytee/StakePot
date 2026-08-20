import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import type { UserRole } from '@prisma/client';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { CommunityService, CommunityMarketError } from '../community/community.service';
import { FundingWindowWorker } from '../community/funding-window.worker';
import { blockersOf } from '../community/market-template';
import { voidRisks } from '../community/void-risk';
import { SeedError, SeedService } from '../community/seed.service';
import { ResolutionFlowError, ResolutionFlowService } from '../resolution/resolution-flow.service';
import {
  QuestionEngineService,
  QuestionEngineUnavailableError,
} from '../community/question-engine.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { RateLimit, RateLimitGuard } from '../hardening/rate-limit.guard';

export class OutcomeDto {
  @IsString() @MinLength(1) label!: string;
  @IsString() @MinLength(10) criteria!: string;
}

export class ApproveDraftDto {
  /** Liquidity constant L. §2.3: ~50× the typical stake for ~1-point moves. */
  @IsString() liquidityParam!: string;
}

export class SeedDto {
  /** Money into each pool. Defaults to the Symmetric Seed minimum. */
  @IsOptional() @IsNumberString() perOutcome?: string;
}

export class OpenSeedingRoundDto {
  /**
   * The organiser's cut of the syndicate fee, in basis points. 0 is pure
   * pro-rata. Locked the moment the round opens (Part 3 §3).
   */
  @IsOptional() @IsInt() @Min(0) @Max(10_000) organiserBps?: number;
  @IsOptional() @IsInt() @Min(1) roundHours?: number;
}

export class ContributeDto {
  @IsNumberString() amount!: string;
}

export class CopilotDto {
  /** What the creator typed, in their own words (§2.14a step 1). */
  @IsString() @MinLength(10) text!: string;
}

export class BalanceCheckDto {
  @IsString() @MinLength(15) question!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OutcomeDto) outcomes!: OutcomeDto[];
  @IsOptional() @IsString() otherLabel?: string;
  @IsString() @MinLength(1) sourceName!: string;
  @IsString() sourceUrl!: string;
  @IsISO8601() eventDate!: string;
  @IsISO8601() voidDate!: string;
  /** §2.14e's warnings depend on which path the creator has picked. */
  @IsOptional() @IsIn(['organic', 'seeded']) activationPath?: 'organic' | 'seeded';
  @IsOptional() @IsBoolean() conflictAttested?: boolean;
}

export class ProposeResultDto {
  @IsString() outcomeId!: string;
  @IsString() evidenceUrl!: string;
}

export class DisputeDto {
  @IsString() evidenceUrl!: string;
  @IsString() @MinLength(20) text!: string;
}

export class CreateCommunityMarketDto {
  @IsString() @MinLength(15) question!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OutcomeDto) outcomes!: OutcomeDto[];
  @IsOptional() @IsString() otherLabel?: string;
  @IsString() @MinLength(1) sourceName!: string;
  @IsString() sourceUrl!: string;
  @IsISO8601() eventDate!: string;
  @IsISO8601() voidDate!: string;
  /** §2.4: the creator chooses the activation path at creation. */
  @IsOptional() @IsIn(['organic', 'seeded']) activationPath?: 'organic' | 'seeded';
}

@Controller('community')
export class CommunityController {
  constructor(
    private readonly community: CommunityService,
    private readonly seeds: SeedService,
    private readonly resolutions: ResolutionFlowService,
    private readonly engine: QuestionEngineService,
    private readonly windows: FundingWindowWorker,
    private readonly config: PlatformConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Submit a community market (§2.5, §2.9).
   *
   * Screening comes first and nothing is created until it passes: a rejected
   * submission must not cost the creator their bond. Approved submissions land
   * in `funding` with the bond escrowed and the window scheduled.
   */
  @Post('markets')
  @UseGuards(JwtGuard, RateLimitGuard)
  @RateLimit('market_create')
  async submit(@Req() request: RequestWithUser, @Body() body: CreateCommunityMarketDto) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const template = {
      question: body.question,
      outcomes: body.outcomes,
      ...(body.otherLabel === undefined ? {} : { otherLabel: body.otherLabel }),
      sourceName: body.sourceName,
      sourceUrl: body.sourceUrl,
      eventDate: body.eventDate,
      voidDate: body.voidDate,
      edgeCases: {},
    };

    const priorMarkets = await this.prisma.market.count({ where: { creatorId: user.userId } });

    let screened;
    try {
      screened = await this.engine.screen({
        template,
        creatorId: user.userId,
        isFirstMarket: priorMarkets === 0,
        activationPath: body.activationPath ?? 'organic',
      });
    } catch (error) {
      // Without a key the engine cannot screen, and §2.9 is explicit that
      // nothing goes live unscreened — so this fails closed rather than
      // waving the submission through.
      if (error instanceof QuestionEngineUnavailableError) {
        throw new BadRequestException(
          'Market review is unavailable right now. Nothing was charged — try again shortly.',
        );
      }
      throw error;
    }

    if (screened.state === 'rejected') {
      return {
        state: 'rejected',
        reason: blockersOf(screened.report).join(' ') || screened.assessment?.reason,
        // The whole checklist, not only what bit. A creator told "rule 26"
        // with no sight of the other forty-four cannot tell whether they are
        // one fix away or nowhere near.
        report: screened.report,
      };
    }

    // §2.9: a draft is a suggestion. Staff open the market from the review
    // queue; this endpoint only files it.
    return {
      state: 'suggested',
      draftId: screened.draftId,
      reason: 'A reviewer checks every new market before it opens.',
    };
  }

  /**
   * §2.14a step 2: the co-pilot turns what a creator typed into a full template.
   *
   * Nothing is filed — this is somebody still thinking, and a draft row per
   * keystroke would be noise in the review queue. The balance estimate comes
   * back with it, which is what the wizard's meter shows.
   */
  @Post('copilot')
  @UseGuards(JwtGuard)
  async copilot(@Req() request: RequestWithUser, @Body() body: CopilotDto) {
    if (request.user === undefined) throw new BadRequestException('no authenticated user');

    const result = await this.engineCall(() => this.engine.copilot({ text: body.text }));
    return {
      template: result.template,
      estimates: result.estimates,
      balanced: result.balanced,
      engagement: result.engagement,
      rationale: result.rationale,
      report: result.report,
    };
  }

  /** Re-check a template the creator has edited — the meter has to keep moving. */
  @Post('balance-check')
  @UseGuards(JwtGuard)
  async balanceCheck(@Req() request: RequestWithUser, @Body() body: BalanceCheckDto) {
    if (request.user === undefined) throw new BadRequestException('no authenticated user');

    const template = {
      question: body.question,
      outcomes: body.outcomes,
      ...(body.otherLabel === undefined ? {} : { otherLabel: body.otherLabel }),
      sourceName: body.sourceName,
      sourceUrl: body.sourceUrl,
      eventDate: body.eventDate,
      voidDate: body.voidDate,
      edgeCases: {},
    };

    const result = await this.engineCall(() => this.engine.checkBalance({ template }));
    return {
      estimates: result.estimates,
      balanced: result.balanced,
      engagement: result.engagement,
      rationale: result.rationale,
      report: result.report,
      // §2.14e: what is likely to go wrong, as distinct from what is not
      // allowed. Computed here rather than by the model — a warning about a
      // deadline is arithmetic, and paying for a language model to do
      // arithmetic makes it slower and less reliable at once.
      risks: voidRisks({
        template,
        activationPath: body.activationPath ?? 'organic',
        now: new Date(),
        ...(body.conflictAttested === undefined ? {} : { conflictAttested: body.conflictAttested }),
      }),
    };
  }

  /**
   * Open an approved draft as a funding-window market (§2.4, §2.9).
   *
   * §2.9: "It suggests; humans approve — no market ever goes live without staff
   * sign-off." This is that sign-off. The bond is escrowed and the window is
   * scheduled here, not at submission, because a creator whose market is never
   * approved should never have been charged.
   *
   * Role is checked inline; a proper roles guard arrives with the admin panel
   * (§6), which is where the rest of the staff surface lives.
   */
  @Post('drafts/:id/approve')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async approve(
    @Req() request: RequestWithUser,
    @Param('id') draftId: string,
    @Body() body: ApproveDraftDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const draft = await this.prisma.marketDraft.findUnique({ where: { id: draftId } });
    if (draft === null) throw new NotFoundException('draft not found');
    if (draft.state !== 'suggested') {
      throw new BadRequestException(`draft is already ${draft.state}`);
    }

    const flags = draft.blocklistFlags as {
      creatorId?: string;
      activationPath?: 'organic' | 'seeded';
    } | null;
    const template = draft.templateJson as unknown as Parameters<
      CommunityService['create']
    >[0]['template'] & { creatorId?: string };
    const creatorId = flags?.creatorId ?? template.creatorId;
    if (typeof creatorId !== 'string') {
      throw new BadRequestException('draft has no creator recorded');
    }

    const activationPath = flags?.activationPath ?? 'organic';
    const { marketId, fundingClosesAt } = await this.community.create({
      creatorId,
      template,
      liquidityParam: body.liquidityParam,
      activationPath,
    });

    // Path A's window starts now. Path B has no window until the seed lands —
    // scheduling one here would void a market that is still waiting to open.
    if (fundingClosesAt !== null) {
      await this.windows.schedule(marketId, fundingClosesAt);
    }

    await this.prisma.marketDraft.update({
      where: { id: draftId },
      data: { state: 'approved', reviewedBy: user.userId },
    });

    const windowHours = await this.config.get('funding_window_hours');
    return { marketId, activationPath, fundingWindowHours: windowHours };
  }

  /**
   * Post the Symmetric Seed and open the market (§2.4 Path B).
   *
   * The market goes live the moment this returns. Its window keeps running — a
   * seeded market still has to find [10] backers by the deadline or it voids
   * with the seed refunded in full.
   */
  @Post('markets/:id/seed')
  @UseGuards(JwtGuard)
  async seed(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: SeedDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const applied = await this.run(() =>
      this.seeds.seedSolo({
        marketId,
        userId: user.userId,
        ...(body.perOutcome === undefined ? {} : { perOutcome: body.perOutcome }),
      }),
    );
    await this.windows.schedule(marketId, applied.fundingClosesAt);

    return {
      state: 'active',
      total: applied.total.toString(),
      perOutcome: applied.perOutcome.toString(),
      sharesPerOutcome: applied.sharesPerOutcome.toString(),
      fundingClosesAt: applied.fundingClosesAt.toISOString(),
    };
  }

  /** Open a Seeding Round instead of funding the seed alone (Part 3 §3). */
  @Post('markets/:id/syndicate')
  @UseGuards(JwtGuard)
  async openSeedingRound(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: OpenSeedingRoundDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const round = await this.run(() =>
      this.seeds.openSeedingRound({
        marketId,
        creatorId: user.userId,
        ...(body.organiserBps === undefined ? {} : { organiserBps: body.organiserBps }),
        ...(body.roundHours === undefined ? {} : { roundHours: body.roundHours }),
      }),
    );
    await this.windows.scheduleSeedingRound(marketId, round.roundEndsAt);

    return {
      syndicateId: round.syndicateId,
      roundEndsAt: round.roundEndsAt.toISOString(),
      minTotal: round.minTotal.toString(),
    };
  }

  /** Join a Seeding Round. The market activates the moment the round fills. */
  @Post('markets/:id/syndicate/contributions')
  @UseGuards(JwtGuard)
  async contribute(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: ContributeDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const result = await this.run(() =>
      this.seeds.contribute({ marketId, userId: user.userId, amount: body.amount }),
    );

    if (result.filled) {
      const market = await this.prisma.market.findUnique({
        where: { id: marketId },
        select: { fundingClosesAt: true },
      });
      if (market?.fundingClosesAt != null) {
        await this.windows.schedule(marketId, market.fundingClosesAt);
      }
    }

    return {
      total: result.total.toString(),
      sponsors: result.sponsors,
      filled: result.filled,
    };
  }

  /**
   * The seed's composition — who put in what, and on what terms.
   *
   * §3 requires the split to be "displayed on the market page before any sponsor
   * joins", so this is readable while the round is still open and not only once
   * it has filled.
   */
  @Get('markets/:id/seed')
  async seedComposition(@Param('id') marketId: string) {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      select: {
        id: true,
        state: true,
        activationPath: true,
        creatorId: true,
        potTotal: true,
        fundingClosesAt: true,
        outcomes: { select: { id: true } },
      },
    });
    if (market === null) throw new NotFoundException('market not found');

    const syndicate = await this.prisma.syndicate.findUnique({
      where: { marketId },
      include: { members: { orderBy: { createdAt: 'asc' } } },
    });

    const seedTrades = await this.prisma.trade.groupBy({
      by: ['userId'],
      where: { marketId, side: 'seed' },
      _sum: { cost: true },
    });

    return {
      marketId: market.id,
      state: market.state,
      activationPath: market.activationPath,
      fundingClosesAt: market.fundingClosesAt?.toISOString() ?? null,
      seeded: seedTrades.map((row) => ({
        userId: row.userId,
        amount: row._sum.cost?.toString() ?? '0',
      })),
      syndicate:
        syndicate === null
          ? null
          : {
              id: syndicate.id,
              state: syndicate.state,
              roundEndsAt: syndicate.roundEndsAt.toISOString(),
              minTotal: syndicate.minTotal.toString(),
              perOutcomeMin: syndicate.perOutcomeMin.toString(),
              minContribution: syndicate.minContribution.toString(),
              maxSponsors: syndicate.maxSponsors,
              organiserBps: syndicate.organiserBps,
              raised: syndicate.members
                .reduce((acc, m) => acc + Number(m.contribution), 0)
                .toString(),
              sponsors: syndicate.members.map((m) => ({
                userId: m.userId,
                contribution: m.contribution.toString(),
                feeSharePct: m.feeSharePct.toString(),
              })),
            },
    };
  }

  /**
   * The creator posts the Proposed Resolution (Part 3 §5).
   *
   * Within [48] hours of the event concluding, with a reference to the named
   * source. This opens the dispute window and pays out nothing — the platform
   * confirms every community resolution before any money moves, and that is a
   * different person, in the resolution centre.
   */
  @Post('markets/:id/resolution/propose')
  @UseGuards(JwtGuard)
  async proposeResult(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: ProposeResultDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const { resolution, disputeClosesAt } = await this.run(() =>
      this.resolutions.propose({
        marketId,
        outcomeId: body.outcomeId,
        evidenceUrl: body.evidenceUrl,
        actor: {
          userId: user.userId,
          role: user.role as UserRole,
          ip: request.ip ?? 'unknown',
        },
      }),
    );

    await this.windows.scheduleDisputeWindow(marketId, disputeClosesAt);

    return {
      id: resolution.id,
      state: 'dispute_window',
      disputeClosesAt: disputeClosesAt.toISOString(),
    };
  }

  /**
   * File a dispute (Part 1 §5, Part 3 §6).
   *
   * Open to anyone with money in the market, and only while the [48]-hour window
   * is open. Only evidence from the market's named source is admissible, which
   * staff judge — this endpoint's job is to get the claim on the record in time.
   */
  @Post('markets/:id/disputes')
  @UseGuards(JwtGuard)
  async dispute(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: DisputeDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const dispute = await this.run(() =>
      this.resolutions.fileDispute({
        marketId,
        userId: user.userId,
        evidenceUrl: body.evidenceUrl,
        text: body.text,
      }),
    );
    return { id: dispute.id, state: dispute.state };
  }

  /**
   * Without a key the engine cannot run, and §2.9 is explicit that nothing goes
   * live unscreened — so every co-pilot path fails closed with a sentence a
   * creator can act on rather than a stack trace.
   */
  private async engineCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QuestionEngineUnavailableError) {
        throw new BadRequestException(
          'The market co-pilot is unavailable right now. You can still fill the form yourself.',
        );
      }
      if (error instanceof Error) throw new BadRequestException(error.message);
      throw error;
    }
  }

  /**
   * Rulebook violations are 400s, not 500s.
   *
   * A seed that is short, a round that is full, a bond already forfeited — every
   * one of these is the caller being told no by a rule, and the client needs the
   * sentence, not a stack trace.
   */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof SeedError ||
        error instanceof CommunityMarketError ||
        error instanceof ResolutionFlowError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
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

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { CommunityService, CommunityMarketError } from '../community/community.service';
import { FundingWindowWorker } from '../community/funding-window.worker';
import { SeedError, SeedService } from '../community/seed.service';
import {
  QuestionEngineService,
  QuestionEngineUnavailableError,
} from '../community/question-engine.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

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

export class ForfeitBondDto {
  @IsString() @MinLength(10) reason!: string;
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
  @UseGuards(JwtGuard)
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
        reason: screened.problems.map((p) => p.message).join(' ') || screened.assessment?.reason,
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
  @UseGuards(JwtGuard)
  async approve(
    @Req() request: RequestWithUser,
    @Param('id') draftId: string,
    @Body() body: ApproveDraftDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    if (user.role !== 'admin' && user.role !== 'resolver') {
      throw new ForbiddenException('only staff can open a market from the review queue');
    }

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
   * Forfeit a conduct bond (Part 3 §5). Staff only, reason on the record.
   */
  @Post('markets/:id/bond/forfeit')
  @UseGuards(JwtGuard)
  async forfeitBond(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: ForfeitBondDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    if (user.role !== 'admin' && user.role !== 'resolver') {
      throw new ForbiddenException('only staff can forfeit a conduct bond');
    }

    const { amount } = await this.run(() =>
      this.community.forfeitBond({
        marketId,
        reason: body.reason,
        decidedBy: user.userId,
        ip: request.ip ?? 'unknown',
      }),
    );
    return { state: 'forfeited', amount: amount.toString() };
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
      if (error instanceof SeedError || error instanceof CommunityMarketError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

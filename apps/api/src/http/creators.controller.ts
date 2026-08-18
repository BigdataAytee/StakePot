import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { JwtGuard, OptionalJwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { CreatorAnalyticsService } from '../creator/analytics.service';
import { AutopsyService } from '../creator/autopsy.service';
import { CreatorError, CreatorService } from '../creator/creator.service';
import { NudgeService } from '../creator/nudge.service';
import { OpportunityError, OpportunityService } from '../creator/opportunity.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

export class HandleDto {
  @IsString() @MinLength(3) @MaxLength(20) handle!: string;
  @IsOptional() @IsString() @MaxLength(40) displayName?: string;
}

export class FollowDto {
  @IsOptional() @IsBoolean() notify?: boolean;
}

export class ViewDto {
  @IsOptional()
  @IsIn(['direct', 'share', 'whatsapp', 'x', 'feed', 'profile', 'search'])
  source?: string;
}

export class ClaimDto {
  @IsString() marketId!: string;
}

/**
 * §2.14's creator platform, over HTTP.
 *
 * Two audiences on one controller, deliberately separated by path: `/creators`
 * is public — a profile is a public record and reads without a token — while
 * `/creators/me/*` is the studio and needs one. Nothing here moves money, so
 * nothing here takes a lock.
 */
@Controller('creators')
export class CreatorsController {
  constructor(
    private readonly creators: CreatorService,
    private readonly analytics: CreatorAnalyticsService,
    private readonly nudges: NudgeService,
    private readonly autopsies: AutopsyService,
    private readonly opportunities: OpportunityService,
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
  ) {}

  // ------------------------------------------------------------------- studio

  /** The creator's own standing: level, privileges, and what is left to climb. */
  @Get('me')
  @UseGuards(JwtGuard)
  async me(@Req() request: RequestWithUser) {
    const userId = request.user!.userId;
    await this.creators.ensureProfile(userId);

    const [standing, user, autopsies] = await Promise.all([
      this.creators.standing(userId),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { handle: true, displayName: true },
      }),
      this.autopsies.forCreator(userId, 10),
    ]);

    return {
      handle: user?.handle ?? null,
      displayName: user?.displayName ?? null,
      ...standing,
      record: { ...standing.record },
      autopsies,
    };
  }

  @Post('me/handle')
  @UseGuards(JwtGuard)
  async claimHandle(@Req() request: RequestWithUser, @Body() body: HandleDto) {
    try {
      return await this.creators.claimHandle({
        userId: request.user!.userId,
        handle: body.handle,
        ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
      });
    } catch (caught) {
      if (caught instanceof CreatorError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  /** Every market the creator has open, with its analytics and its nudges. */
  @Get('me/markets')
  @UseGuards(JwtGuard)
  async myMarkets(@Req() request: RequestWithUser) {
    const userId = request.user!.userId;

    const markets = await this.prisma.market.findMany({
      where: { creatorId: userId },
      select: { id: true, question: true, state: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 25,
    });

    const activationFloor = await this.config.get('community_activation_pool_spc');

    return Promise.all(
      markets.map(async (market) => {
        const analytics = await this.analytics.forMarket(market.id);
        return {
          id: market.id,
          question: market.question,
          state: market.state,
          createdAt: market.createdAt,
          analytics:
            analytics === null
              ? null
              : this.analytics.withActivationProgress(analytics, activationFloor),
          nudges: await this.nudges.forMarket(market.id),
        };
      }),
    );
  }

  /** One market's analytics, for the creator who owns it. */
  @Get('me/markets/:id')
  @UseGuards(JwtGuard)
  async myMarket(@Req() request: RequestWithUser, @Param('id') id: string) {
    const market = await this.prisma.market.findUnique({
      where: { id },
      select: { creatorId: true },
    });
    if (market === null || market.creatorId !== request.user!.userId) {
      // Analytics are a creator's own numbers, so a market that is not theirs
      // is indistinguishable from one that does not exist.
      throw new NotFoundException('no such market');
    }

    const analytics = await this.analytics.forMarket(id);
    if (analytics === null) throw new NotFoundException('no such market');

    const floor = await this.config.get('community_activation_pool_spc');
    return {
      ...this.analytics.withActivationProgress(analytics, floor),
      nudges: await this.nudges.forMarket(id),
      autopsy: await this.autopsies.forMarket(id),
    };
  }

  // ------------------------------------------------------------- public reads

  /** §2.14c's public creator profile. */
  @Get('handle/:handle')
  @UseGuards(OptionalJwtGuard)
  async profile(@Req() request: RequestWithUser, @Param('handle') handle: string) {
    const profile = await this.creators.profileByHandle(handle);
    if (profile === null) throw new NotFoundException('no such creator');

    const viewerId = request.user?.userId;
    return {
      ...profile,
      following:
        viewerId === undefined ? false : await this.creators.isFollowing(viewerId, profile.userId),
      isSelf: viewerId === profile.userId,
    };
  }

  @Post(':id/follow')
  @UseGuards(JwtGuard)
  async follow(
    @Req() request: RequestWithUser,
    @Param('id') creatorId: string,
    @Body() body: FollowDto,
  ) {
    try {
      return await this.creators.follow({
        followerId: request.user!.userId,
        creatorId,
        ...(body.notify === undefined ? {} : { notify: body.notify }),
      });
    } catch (caught) {
      if (caught instanceof CreatorError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  @Delete(':id/follow')
  @UseGuards(JwtGuard)
  async unfollow(@Req() request: RequestWithUser, @Param('id') creatorId: string) {
    return this.creators.unfollow({ followerId: request.user!.userId, creatorId });
  }

  // ------------------------------------------------------- opportunities feed

  /** §2.14b's feed, and the templates behind it. */
  @Get('opportunities/feed')
  async feed() {
    return this.opportunities.feed();
  }

  @Get('opportunities/templates')
  async templates(@Query('category') category?: string) {
    return this.opportunities.templates(category);
  }

  @Post('opportunities/:id/claim')
  @UseGuards(JwtGuard)
  async claim(
    @Req() request: RequestWithUser,
    @Param('id') opportunityId: string,
    @Body() body: ClaimDto,
  ) {
    const market = await this.prisma.market.findUnique({
      where: { id: body.marketId },
      select: { creatorId: true },
    });
    if (market === null || market.creatorId !== request.user!.userId) {
      throw new BadRequestException('you can only claim an opportunity for your own market');
    }

    try {
      await this.opportunities.claim({
        opportunityId,
        userId: request.user!.userId,
        marketId: body.marketId,
      });
      return { claimed: true };
    } catch (caught) {
      if (caught instanceof OpportunityError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }
}

/**
 * The two writes that feed §2.14d's analytics and §2.14b's demand signal.
 *
 * Kept off `/creators` because they are about a market, not a creator, and the
 * client that sends them does not know or care whose market it is.
 */
@Controller('markets')
export class MarketSignalsController {
  constructor(
    private readonly analytics: CreatorAnalyticsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Somebody looked at a market.
   *
   * Explicit rather than inferred from a page render: a server-side fetch is not
   * a person, and a conversion rate whose denominator counts crawlers tells a
   * creator to fix a problem they do not have.
   */
  @Post(':id/view')
  @UseGuards(OptionalJwtGuard)
  async view(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: ViewDto,
  ) {
    const exists = await this.prisma.market.findUnique({
      where: { id: marketId },
      select: { id: true },
    });
    if (exists === null) throw new NotFoundException('no such market');

    await this.analytics.recordView({
      marketId,
      ...(request.user === undefined ? {} : { userId: request.user.userId }),
      ...(body.source === undefined ? {} : { source: body.source }),
    });
    return { recorded: true };
  }

  /**
   * Search, and log what was asked for.
   *
   * The log is the raw material for §2.14b's unmet-demand signal — "47 users
   * searched 'BBNaija eviction' this week — no market exists" — so a search that
   * returns nothing is the most valuable row in the table, not a dead end.
   */
  @Get('search/q')
  @UseGuards(OptionalJwtGuard)
  async search(@Req() request: RequestWithUser, @Query('q') query?: string) {
    const term = (query ?? '').trim();
    if (term.length === 0) return { query: '', results: [] };

    const results = await this.prisma.market.findMany({
      where: {
        question: { contains: term, mode: 'insensitive' },
        state: { in: ['seeding', 'funding', 'active', 'frozen', 'dispute_window'] },
      },
      select: { id: true, question: true, shelf: true, state: true, potTotal: true },
      take: 20,
    });

    await this.analytics.recordSearch({
      query: term,
      ...(request.user === undefined ? {} : { userId: request.user.userId }),
      resultCount: results.length,
    });

    return {
      query: term,
      results: results.map((market) => ({
        id: market.id,
        question: market.question,
        shelf: market.shelf,
        state: market.state,
        potTotal: market.potTotal.toString(),
      })),
    };
  }
}

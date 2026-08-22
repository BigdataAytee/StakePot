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
import { IsBoolean, IsString, MaxLength } from 'class-validator';

import { AdminAuditService } from '../audit/admin-audit.service';
import { JwtGuard, OptionalJwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { ReputationService } from '../community-layer/reputation.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { isoWeekOf, weekWindow } from '../leaderboard/scoring';
import { PrismaService } from '../prisma/prisma.service';

/**
 * §2.15b's public forecasting record.
 *
 * Public because that is the entire point: "a verifiable public forecasting
 * record is real social capital (vs unverifiable WhatsApp tipsters)". A
 * reputation only visible to the person who holds it is a private score.
 */
@Controller()
export class ReputationController {
  constructor(
    private readonly reputation: ReputationService,
    private readonly prisma: PrismaService,
  ) {}

  /** Somebody's record, by handle. Computed live from settled positions. */
  @Get('creators/:handle/reputation')
  @UseGuards(OptionalJwtGuard)
  async byHandle(@Param('handle') handle: string) {
    const user = await this.prisma.user.findUnique({
      where: { handle },
      select: { id: true },
    });
    if (user === null) throw new BadRequestException('no such profile');

    const [profile, titles] = await Promise.all([
      this.reputation.profileOf(user.id),
      this.prisma.reputation.findMany({
        where: { userId: user.id, title: { not: null } },
        orderBy: { season: 'desc' },
        take: 12,
      }),
    ]);

    return {
      ...profile,
      // Seasonal titles are a record of what somebody won and when, so they
      // are read from the table rather than recomputed: a title earned last
      // season must not evaporate because this season's form is worse.
      awards: titles.map((row) => ({
        category: row.category,
        title: row.title,
        season: row.season,
        accuracy: Number(row.accuracyPct),
        sample: row.sampleSize,
      })),
    };
  }

  /** §2.15b's weekly showcase — only what a person chose to feature. */
  @Get('top-calls')
  async published(@Query('week') week?: string) {
    const period = week ?? isoWeekOf(new Date(Date.now() - 7 * 86_400_000));

    const rows = await this.prisma.topCall.findMany({
      where: { week: period, featured: true },
      include: {
        user: { select: { handle: true, displayName: true } },
        market: { select: { id: true, question: true } },
      },
    });

    return rows
      .map((row) => ({
        week: row.week,
        handle: row.user.handle,
        displayName: row.user.displayName,
        marketId: row.market.id,
        question: row.market.question,
        entryPrice: row.entryPrice.toString(),
        resolvedOutcome: row.resolvedOutcome,
      }))
      .sort((a, b) => Number(a.entryPrice) - Number(b.entryPrice));
  }
}

export class FeatureCallDto {
  @IsBoolean() featured!: boolean;
}

export class RecomputeDto {
  @IsString() @MaxLength(20) season!: string;
}

/**
 * §6.8's Top Calls curation.
 *
 * The job proposes and a person publishes — nothing reaches the showcase
 * without somebody choosing it. A curated marketing asset that publishes
 * itself is one unfortunate market away from featuring something the platform
 * has to apologise for.
 */
@Controller('admin/top-calls')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'support')
export class TopCallsAdminController {
  constructor(
    private readonly reputation: ReputationService,
    private readonly leaderboards: LeaderboardService,
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  /** Everything proposed for a week, featured or not. */
  @Get()
  async queue(@Query('week') week?: string) {
    const period = week ?? isoWeekOf(new Date(Date.now() - 7 * 86_400_000));

    const rows = await this.prisma.topCall.findMany({
      where: { week: period },
      include: {
        user: { select: { handle: true, displayName: true } },
        market: { select: { id: true, question: true, potTotal: true } },
      },
    });

    return {
      week: period,
      calls: rows
        .map((row) => ({
          id: row.id,
          handle: row.user.handle,
          displayName: row.user.displayName,
          marketId: row.market.id,
          question: row.market.question,
          pot: row.market.potTotal.toString(),
          entryPrice: row.entryPrice.toString(),
          resolvedOutcome: row.resolvedOutcome,
          featured: row.featured,
        }))
        .sort((a, b) => Number(a.entryPrice) - Number(b.entryPrice)),
    };
  }

  /** Re-run the proposer for a week. */
  @Post('propose')
  async propose(@Query('week') week?: string) {
    const period = week ?? isoWeekOf(new Date(Date.now() - 7 * 86_400_000));
    return this.reputation.proposeTopCalls(period, weekWindow(period));
  }

  @Post(':id/feature')
  async feature(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Body() body: FeatureCallDto,
  ) {
    const call = await this.prisma.topCall.update({
      where: { id },
      data: { featured: body.featured },
    });

    await this.audit.record({
      staffId: request.user?.userId ?? 'unknown',
      action: body.featured ? 'topcall.feature' : 'topcall.unfeature',
      targetRef: `topcall:${id}`,
      after: { week: call.week, featured: call.featured },
      ip: request.ip ?? 'unknown',
    });

    return { featured: call.featured };
  }

  /** Recompute the season's reputation rows on demand. */
  @Post('reputation/recompute')
  async recompute(@Body() body: RecomputeDto) {
    return this.reputation.recomputeSeason(body.season);
  }

  /** Award last week's Top Forecaster badge on demand (§2.8). */
  @Post('badges/award')
  async award(@Query('period') period?: string) {
    const week = period ?? isoWeekOf(new Date(Date.now() - 7 * 86_400_000));
    return this.leaderboards.awardTopForecaster(week);
  }
}

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
import type { LeaderboardBoard } from '@prisma/client';
import {
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { AnalyticsService } from '../analytics/analytics.service';
import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { ApprovalsService } from '../approvals/approvals.service';
import { LeaderboardService } from '../leaderboard/leaderboard.service';
import { PrizeError, PrizeService } from '../leaderboard/prize.service';
import { ALL_TIME, isoWeekOf } from '../leaderboard/scoring';

function boardOf(value: string | undefined): LeaderboardBoard {
  return value === 'accuracy' ? 'accuracy' : 'profit';
}

export class DraftRunDto {
  @IsString() period!: string;
  @IsIn(['profit', 'accuracy']) board!: LeaderboardBoard;
  @IsOptional() @IsInt() @Min(1) @Max(100) places?: number;
  @IsOptional() @IsNumberString() poolSpc?: string;
  @IsOptional() @IsString() @MaxLength(280) note?: string;
}

export class SubmitRunDto {
  @IsString() @MaxLength(280) reason!: string;
}

/**
 * §2.8's leaderboards, over HTTP.
 *
 * Entirely a read surface, served from published snapshots — §11: "prices,
 * charts, market lists, and leaderboards are served from Redis and read
 * replicas. Only trades hit the primary." Nothing here recomputes anything.
 */
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboards: LeaderboardService) {}

  @Get()
  async board(
    @Query('period') period?: string,
    @Query('board') board?: string,
    @Query('take') take?: string,
  ) {
    const parsed = Number(take);
    return this.leaderboards.board({
      period: period ?? isoWeekOf(new Date()),
      board: boardOf(board),
      ...(Number.isFinite(parsed) && parsed > 0 ? { take: Math.min(parsed, 200) } : {}),
    });
  }

  /** Which periods have a published board — the screen's period picker. */
  @Get('periods')
  async periods() {
    const periods = await this.leaderboards.periods();
    return { current: isoWeekOf(new Date()), allTime: ALL_TIME, periods };
  }

  /** Where the signed-in person stands, and their streak. */
  @Get('me')
  @UseGuards(JwtGuard)
  async me(@Req() request: RequestWithUser, @Query('period') period?: string) {
    const userId = request.user!.userId;
    const [weekly, allTime, streak] = await Promise.all([
      this.leaderboards.standingOf(userId, period ?? isoWeekOf(new Date())),
      this.leaderboards.standingOf(userId, ALL_TIME),
      this.leaderboards.streakOf(userId),
    ]);
    return { weekly, allTime, streak };
  }
}

/**
 * §6.8's prize desk.
 *
 * Drawing up a run is a Content & Growth action; *paying* it is a money action
 * that goes through §2.10's four-eyes workflow like every other. The split is
 * deliberate — the person who draws up a prize table must not be the only
 * person who can pay it.
 */
@Controller('admin/prizes')
@UseGuards(JwtGuard, RolesGuard)
export class PrizeController {
  constructor(
    private readonly prizes: PrizeService,
    private readonly approvals: ApprovalsService,
    private readonly leaderboards: LeaderboardService,
  ) {}

  @Get()
  @Roles('admin', 'finance', 'support')
  async runs() {
    return this.prizes.runs();
  }

  /** The board a run would be drawn from, before drawing one. */
  @Get('preview')
  @Roles('admin', 'finance', 'support')
  async preview(@Query('period') period?: string, @Query('board') board?: string) {
    return this.leaderboards.board({
      period: period ?? isoWeekOf(new Date()),
      board: boardOf(board),
      take: 25,
    });
  }

  @Post()
  @Roles('admin', 'finance')
  async draft(@Req() request: RequestWithUser, @Body() body: DraftRunDto) {
    try {
      return await this.prizes.draft({
        period: body.period,
        board: body.board,
        staffId: request.user!.userId,
        ...(body.places === undefined ? {} : { places: body.places }),
        ...(body.poolSpc === undefined ? {} : { poolSpc: body.poolSpc }),
        ...(body.note === undefined ? {} : { note: body.note }),
      });
    } catch (caught) {
      if (caught instanceof PrizeError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  /**
   * Send a drawn-up run for its second signature.
   *
   * The proposal is filed against the same approvals inbox every other money
   * action uses, so a prize payout shows up beside a ledger adjustment and a
   * bond forfeiture rather than in a quiet corner of its own.
   */
  @Post(':id/submit')
  @Roles('admin', 'finance')
  async submit(
    @Req() request: RequestWithUser,
    @Param('id') runId: string,
    @Body() body: SubmitRunDto,
  ) {
    try {
      const approval = await this.approvals.propose({
        actionType: 'prize.run',
        payload: { runId },
        reason: body.reason,
        actor: {
          userId: request.user!.userId,
          role: request.user!.role as never,
          ip: request.ip ?? 'unknown',
        },
      });
      await this.prizes.submit(runId, approval.id);
      return { approvalId: approval.id };
    } catch (caught) {
      if (caught instanceof PrizeError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  /** Tell the winners. Separate from payment, and only after it. */
  @Post(':id/announce')
  @Roles('admin', 'finance')
  async announce(@Param('id') runId: string) {
    return { told: await this.prizes.announce(runId) };
  }

  @Post(':id/cancel')
  @Roles('admin', 'finance')
  async cancel(@Req() request: RequestWithUser, @Param('id') runId: string) {
    try {
      await this.prizes.cancel(runId, request.user!.userId);
      return { cancelled: true };
    } catch (caught) {
      if (caught instanceof PrizeError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }
}

/** §6.8's analytics dashboard. */
@Controller('admin/analytics')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin', 'finance', 'support')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  async overview(@Query('days') days?: string) {
    const parsed = Number(days);
    const window = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 90) : 14;
    const since = new Date(Date.now() - window * 86_400_000);

    const [counts, funnel] = await Promise.all([
      this.analytics.counts(since),
      this.analytics.funnel(since),
    ]);

    return { days: window, counts, funnel };
  }

  @Get('daily')
  async daily(@Query('name') name: string, @Query('days') days?: string) {
    const parsed = Number(days);
    const window = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 90) : 14;
    return this.analytics.daily(name as never, window);
  }
}

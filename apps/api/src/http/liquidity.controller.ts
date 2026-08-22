import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { LiquidityMode } from '@prisma/client';

import { JwtGuard } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import type { RequestWithUser } from '../auth/jwt.guard';
import { MarketMakerError, MarketMakerService } from '../liquidity/market-maker.service';
import { LiquidityModeError, LiquidityModeService } from '../liquidity/mode.service';
import { SeedToolError, SeedToolService } from '../liquidity/seed-tool.service';

/**
 * A decimal amount as a string.
 *
 * Never a `number`. JSON numbers are doubles, and a budget that arrives as a
 * double has already lost precision before any validation runs — the money
 * columns are Decimal(38,18) and the wire format has to be able to say so.
 */
const AMOUNT = /^\d+(\.\d+)?$/;

/*
 * DTOs above the controller, deliberately.
 *
 * `emitDecoratorMetadata` resolves a parameter's type at class-definition
 * time, so a DTO declared *below* the controller that references it is in its
 * temporal dead zone and the app dies on boot with "Cannot access X before
 * initialization" — a failure that passes typecheck, passes lint, and only
 * appears when something tries to start.
 */
class SeedPreviewDto {
  @Matches(AMOUNT, { message: 'perOutcome must be a positive decimal string' })
  perOutcome!: string;
  @IsOptional() @IsIn(['test', 'live']) mode?: LiquidityMode;
}

class SeedExecuteDto {
  @Matches(AMOUNT, { message: 'perOutcome must be a positive decimal string' })
  perOutcome!: string;
  @IsString() @IsNotEmpty() @MaxLength(300) reason!: string;
  /** Idempotency: a retried click must not seed twice. */
  @IsString() @IsNotEmpty() requestId!: string;
  @IsOptional() @IsIn(['test', 'live']) mode?: LiquidityMode;
}

class MakerConfigDto {
  @Matches(AMOUNT, { message: 'budget must be a positive decimal string' })
  budget!: string;
  @Matches(AMOUNT, { message: 'quoteSize must be a positive decimal string' })
  quoteSize!: string;
  @IsInt() @Min(1) @Max(49) spreadKobo!: number;
  @IsOptional() @IsInt() @Min(1) @Max(99) minPriceKobo?: number;
  @IsOptional() @IsInt() @Min(1) @Max(99) maxPriceKobo?: number;
  /** Ten seconds is the floor: below that the cycle is the load, not the work. */
  @IsOptional() @IsInt() @Min(10_000) @Max(3_600_000) refreshMs?: number;
  @IsOptional() @Matches(AMOUNT) depthStop?: string;
  @IsOptional() @Matches(AMOUNT) inventoryCap?: string;
  @IsOptional() @IsIn(['test', 'live']) mode?: LiquidityMode;
}

class MakerStartDto {
  /** §E: says out loud that stacking a maker on a fresh seed is intended. */
  @IsOptional() @IsBoolean() confirmStacking?: boolean;
}

class KillDto {
  @IsString() @IsNotEmpty() @MaxLength(300) reason!: string;
}

/**
 * `/admin/liquidity` — the two tools and the switch above them.
 *
 * `admin` only, and not `resolver`: both tools commit platform money, which is
 * a different decision from judging a market. The mode read is the one
 * exception a resolver could safely have, and it is not worth a second rule.
 */
@Controller('admin/liquidity')
@UseGuards(JwtGuard, RolesGuard)
@Roles('admin')
export class LiquidityController {
  constructor(
    private readonly modes: LiquidityModeService,
    private readonly seeds: SeedToolService,
    private readonly makers: MarketMakerService,
  ) {}

  /**
   * The mode, and why LIVE is not available.
   *
   * A read, never a write. There is no endpoint that sets the mode, because a
   * mode you can set is a mode that can be left set: LIVE is available exactly
   * when the feature flag and the config key are both on, and both of those
   * are changed through their own consoles, with their own approvals.
   */
  @Get('mode')
  async mode() {
    return this.modes.state();
  }

  @Get('markets')
  async markets() {
    return this.run(() => this.seeds.table());
  }

  @Post('seed/:id/preview')
  async previewSeed(@Param('id') marketId: string, @Body() body: SeedPreviewDto) {
    return this.run(() =>
      this.seeds.preview({
        marketId,
        perOutcome: body.perOutcome,
        ...(body.mode === undefined ? {} : { mode: body.mode }),
      }),
    );
  }

  @Post('seed/:id')
  async seed(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: SeedExecuteDto,
  ) {
    const actor = this.actor(request);
    return this.run(() =>
      this.seeds.execute({
        marketId,
        perOutcome: body.perOutcome,
        reason: body.reason,
        requestId: body.requestId,
        staffId: actor.userId,
        ip: actor.ip,
        ...(body.mode === undefined ? {} : { mode: body.mode }),
      }),
    );
  }

  @Get('makers')
  async makerDashboard() {
    return this.run(() => this.makers.dashboard());
  }

  @Post('makers/:id/config')
  async configureMaker(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: MakerConfigDto,
  ) {
    const actor = this.actor(request);
    return this.run(() =>
      this.makers.configure({
        marketId,
        budget: body.budget,
        quoteSize: body.quoteSize,
        spreadKobo: body.spreadKobo,
        staffId: actor.userId,
        ip: actor.ip,
        ...(body.minPriceKobo === undefined ? {} : { minPriceKobo: body.minPriceKobo }),
        ...(body.maxPriceKobo === undefined ? {} : { maxPriceKobo: body.maxPriceKobo }),
        ...(body.refreshMs === undefined ? {} : { refreshMs: body.refreshMs }),
        ...(body.depthStop === undefined ? {} : { depthStop: body.depthStop }),
        ...(body.inventoryCap === undefined ? {} : { inventoryCap: body.inventoryCap }),
        ...(body.mode === undefined ? {} : { mode: body.mode }),
      }),
    );
  }

  @Post('makers/:id/start')
  async startMaker(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: MakerStartDto,
  ) {
    const actor = this.actor(request);
    return this.run(() =>
      this.makers.start({
        marketId,
        staffId: actor.userId,
        ip: actor.ip,
        ...(body.confirmStacking === undefined ? {} : { confirmStacking: body.confirmStacking }),
      }),
    );
  }

  @Post('makers/:id/stop')
  async stopMaker(@Req() request: RequestWithUser, @Param('id') marketId: string) {
    const actor = this.actor(request);
    return this.run(() => this.makers.stop({ marketId, staffId: actor.userId, ip: actor.ip }));
  }

  /** One market's kill switch. Quotes come off the book before the row is marked. */
  @Post('makers/:id/kill')
  async killMaker(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: KillDto,
  ) {
    const actor = this.actor(request);
    return this.run(() =>
      this.makers.kill({ marketId, staffId: actor.userId, ip: actor.ip, reason: body.reason }),
    );
  }

  /** Everything, at once. */
  @Post('kill-all')
  async killAll(@Req() request: RequestWithUser, @Body() body: KillDto) {
    const actor = this.actor(request);
    return this.run(() =>
      this.makers.killAll({ staffId: actor.userId, ip: actor.ip, reason: body.reason }),
    );
  }

  /**
   * Run one cycle now.
   *
   * The standing job does this on the market's own interval; this is for an
   * operator who has just changed something and wants to see it take effect
   * rather than wait a minute wondering whether it did.
   */
  @Post('makers/:id/cycle')
  async cycleMaker(@Param('id') marketId: string) {
    return this.run(() => this.makers.cycle(marketId));
  }

  private actor(request: RequestWithUser): { userId: string; ip: string } {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    return { userId: user.userId, ip: request.ip ?? 'unknown' };
  }

  /** Turn the services' own errors into 400s with their own words. */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof LiquidityModeError ||
        error instanceof SeedToolError ||
        error instanceof MarketMakerError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

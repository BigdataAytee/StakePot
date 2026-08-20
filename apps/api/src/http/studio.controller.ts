import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
@Controller('admin/studio')
export class StudioController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly studio: StudioService,
    private readonly health: MarketHealthService,
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

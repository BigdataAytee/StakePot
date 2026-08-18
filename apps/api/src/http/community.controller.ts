import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsISO8601,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { CommunityService } from '../community/community.service';
import { FundingWindowWorker } from '../community/funding-window.worker';
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

export class CreateCommunityMarketDto {
  @IsString() @MinLength(15) question!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OutcomeDto) outcomes!: OutcomeDto[];
  @IsOptional() @IsString() otherLabel?: string;
  @IsString() @MinLength(1) sourceName!: string;
  @IsString() sourceUrl!: string;
  @IsISO8601() eventDate!: string;
  @IsISO8601() voidDate!: string;
}

@Controller('community')
export class CommunityController {
  constructor(
    private readonly community: CommunityService,
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

    const flags = draft.blocklistFlags as { creatorId?: string } | null;
    const template = draft.templateJson as unknown as Parameters<
      CommunityService['create']
    >[0]['template'] & { creatorId?: string };
    const creatorId = flags?.creatorId ?? template.creatorId;
    if (typeof creatorId !== 'string') {
      throw new BadRequestException('draft has no creator recorded');
    }

    const { marketId } = await this.community.create({
      creatorId,
      template,
      liquidityParam: body.liquidityParam,
    });

    const windowHours = await this.config.get('funding_window_hours');
    await this.windows.schedule(marketId, new Date(Date.now() + windowHours * 3_600_000));

    await this.prisma.marketDraft.update({
      where: { id: draftId },
      data: { state: 'approved', reviewedBy: user.userId },
    });

    return { marketId, fundingWindowHours: windowHours };
  }
}

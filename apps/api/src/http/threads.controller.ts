import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { JwtGuard, OptionalJwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { AdminAuditService } from '../audit/admin-audit.service';
import { ChallengeError, ChallengeService } from '../community-layer/challenge.service';
import { ThreadError, ThreadService } from '../community-layer/thread.service';

export class PostCommentDto {
  @IsString() @MinLength(1) @MaxLength(500) text!: string;
  @IsOptional() @IsString() parentId?: string;
}

export class ReportDto {
  @IsString() @MinLength(3) @MaxLength(280) reason!: string;
}

export class ModerateDto {
  @IsIn(['publish', 'remove']) decision!: 'publish' | 'remove';
}

/**
 * §2.15a's take threads and §2.15d's challenge links, over HTTP.
 *
 * Reading a thread needs no token — the argument is the marketing, and a
 * signed-out visitor landing on a challenge link is precisely the person
 * §2.15d is written for. Writing needs one, and the service enforces the rest.
 */
@Controller()
export class ThreadsController {
  constructor(
    private readonly threads: ThreadService,
    private readonly challenges: ChallengeService,
  ) {}

  @Get('markets/:id/thread')
  @UseGuards(OptionalJwtGuard)
  async thread(@Req() request: RequestWithUser, @Param('id') marketId: string) {
    const comments = await this.threads.thread({
      marketId,
      ...(request.user === undefined ? {} : { viewerId: request.user.userId }),
    });
    return comments.map((comment) => ({
      ...comment,
      createdAt: comment.createdAt.toISOString(),
    }));
  }

  @Post('markets/:id/thread')
  @UseGuards(JwtGuard)
  async post(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: PostCommentDto,
  ) {
    try {
      return await this.threads.post({
        marketId,
        userId: request.user!.userId,
        text: body.text,
        ...(body.parentId === undefined ? {} : { parentId: body.parentId }),
      });
    } catch (caught) {
      if (caught instanceof ThreadError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  @Post('comments/:id/report')
  @UseGuards(JwtGuard)
  async report(
    @Req() request: RequestWithUser,
    @Param('id') commentId: string,
    @Body() body: ReportDto,
  ) {
    try {
      return await this.threads.report({
        commentId,
        reporterId: request.user!.userId,
        reason: body.reason,
      });
    } catch (caught) {
      if (caught instanceof ThreadError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  // ------------------------------------------------------------- challenges

  @Post('markets/:id/challenge')
  @UseGuards(JwtGuard)
  async challenge(@Req() request: RequestWithUser, @Param('id') marketId: string) {
    try {
      return await this.challenges.create({ marketId, userId: request.user!.userId });
    } catch (caught) {
      if (caught instanceof ChallengeError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  /** Public: the recipient does not have an account yet, which is the point. */
  @Get('challenges/:token')
  @UseGuards(OptionalJwtGuard)
  async openChallenge(@Req() request: RequestWithUser, @Param('token') token: string) {
    const challenge = await this.challenges.open(
      token,
      request.user === undefined ? undefined : request.user.userId,
    );
    if (challenge === null) throw new NotFoundException('no such challenge');
    return challenge;
  }

  @Post('challenges/:token/accept')
  @UseGuards(JwtGuard)
  async acceptChallenge(@Req() request: RequestWithUser, @Param('token') token: string) {
    try {
      return await this.challenges.accept({ token, userId: request.user!.userId });
    } catch (caught) {
      if (caught instanceof ChallengeError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }

  @Get('me/challenges')
  @UseGuards(JwtGuard)
  async myChallenges(@Req() request: RequestWithUser) {
    return this.challenges.mine(request.user!.userId);
  }
}

/**
 * §2.15e's moderation queue, feeding the Trust & Safety desk (§6.5).
 *
 * Under `/admin` and behind the role matrix, because deciding what stays in a
 * public thread is a staff action with a person's name on it — every decision
 * is audited the same way a money one is.
 */
@Controller('admin/moderation')
@UseGuards(JwtGuard, RolesGuard)
@Roles('trust_safety', 'admin')
export class ModerationController {
  constructor(
    private readonly threads: ThreadService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  async queue(@Query('take') take?: string) {
    const parsed = Number(take);
    return this.threads.queue(Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50);
  }

  @Post(':id')
  async moderate(
    @Req() request: RequestWithUser,
    @Param('id') commentId: string,
    @Body() body: ModerateDto,
  ) {
    try {
      const result = await this.threads.moderate({
        commentId,
        staffId: request.user!.userId,
        decision: body.decision,
      });

      await this.audit.record({
        staffId: request.user!.userId,
        action: `comment.${body.decision}`,
        targetRef: `comment:${commentId}`,
        after: { state: result.state },
        ip: request.ip ?? 'unknown',
      });

      return result;
    } catch (caught) {
      if (caught instanceof ThreadError) throw new BadRequestException(caught.message);
      throw caught;
    }
  }
}

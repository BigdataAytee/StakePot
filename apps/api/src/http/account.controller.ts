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
import type { NotificationChannel, TicketCategory, UserRole } from '@prisma/client';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { TotpError, TotpService } from '../auth/totp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RgBlockedError, RgService } from '../rg/rg.service';
import { SupportError, SupportService } from '../support/support.service';

export class LimitsDto {
  @IsOptional() @IsNumberString() depositLimit?: string;
  @IsOptional() @IsNumberString() stakeLimit?: string;
  @IsOptional() @IsNumberString() lossLimit?: string;
  /** Explicitly clear a limit rather than leaving it unchanged. */
  @IsOptional() @IsBoolean() clearDeposit?: boolean;
  @IsOptional() @IsBoolean() clearStake?: boolean;
  @IsOptional() @IsBoolean() clearLoss?: boolean;
}

export class CoolOffDto {
  @IsInt() @Min(1) @Max(365) days!: number;
}

export class SelfExcludeDto {
  /** Typed confirmation, GitHub-style: this one has no undo. */
  @IsString() confirm!: string;
}

export class OpenTicketDto {
  @IsIn(['payout_query', 'dispute', 'account', 'rg_request', 'other']) category!: TicketCategory;
  @IsString() @MinLength(5) subject!: string;
  @IsString() @MinLength(10) body!: string;
  @IsOptional() @IsString() marketId?: string;
}

export class TicketReplyDto {
  @IsString() @MinLength(2) body!: string;
}

export class PreferenceDto {
  @IsIn(['in_app', 'push', 'email', 'sms']) channel!: NotificationChannel;
  @IsBoolean() enabled!: boolean;
}

export class PushSubscriptionDto {
  @IsString() endpoint!: string;
  @IsString() p256dh!: string;
  @IsString() auth!: string;
}

export class TotpConfirmDto {
  @IsString() @MinLength(6) code!: string;
}

/**
 * Everything a signed-in person does about themselves (§2.12).
 *
 * Limits, cool-offs, self-exclusion, their support tickets, their notification
 * settings — and, for staff, 2FA enrolment. Grouped on one controller because
 * they share one rule: a person may only ever act on their own account here.
 */
@Controller('account')
export class AccountController {
  constructor(
    private readonly rg: RgService,
    private readonly support: SupportService,
    private readonly notifications: NotificationsService,
    private readonly totp: TotpService,
  ) {}

  private me(request: RequestWithUser): { userId: string; role: UserRole } {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    return { userId: user.userId, role: user.role as UserRole };
  }

  // ------------------------------------------------------- responsible gambling

  @Get('limits')
  @UseGuards(JwtGuard)
  async limits(@Req() request: RequestWithUser) {
    return this.rg.view(this.me(request).userId);
  }

  @Post('limits')
  @UseGuards(JwtGuard)
  async setLimits(@Req() request: RequestWithUser, @Body() body: LimitsDto) {
    const { userId } = this.me(request);
    return this.run(() =>
      this.rg.setLimits({
        userId,
        ...(body.clearDeposit === true
          ? { depositLimit: null }
          : body.depositLimit === undefined
            ? {}
            : { depositLimit: body.depositLimit }),
        ...(body.clearStake === true
          ? { stakeLimit: null }
          : body.stakeLimit === undefined
            ? {}
            : { stakeLimit: body.stakeLimit }),
        ...(body.clearLoss === true
          ? { lossLimit: null }
          : body.lossLimit === undefined
            ? {}
            : { lossLimit: body.lossLimit }),
      }),
    ).then(() => this.rg.view(userId));
  }

  @Post('cool-off')
  @UseGuards(JwtGuard)
  async coolOff(@Req() request: RequestWithUser, @Body() body: CoolOffDto) {
    const { userId } = this.me(request);
    const settings = await this.run(() => this.rg.coolOff({ userId, days: body.days }));
    await this.notifications.notify({
      userId,
      type: 'rg_confirmation',
      body: `Your cool-off runs until ${settings.cooloffUntil?.toISOString() ?? 'unknown'}. Staking is off until then; your balance is untouched.`,
    });
    return this.rg.view(userId);
  }

  /**
   * Permanent self-exclusion (§2.12).
   *
   * Typed confirmation because there is no undo — reinstatement is a support
   * request a human handles. Staking stops; withdrawal does not.
   */
  @Post('self-exclude')
  @UseGuards(JwtGuard)
  async selfExclude(@Req() request: RequestWithUser, @Body() body: SelfExcludeDto) {
    const { userId } = this.me(request);
    if (body.confirm.trim().toUpperCase() !== 'SELF-EXCLUDE') {
      throw new BadRequestException('type SELF-EXCLUDE to confirm — this cannot be undone');
    }

    await this.run(() => this.rg.selfExclude({ userId }));
    await this.notifications.notify({
      userId,
      type: 'rg_confirmation',
      body: 'You are self-excluded from staking on StakeAm. Your balance is still yours to withdraw, and support can help with anything else.',
    });
    return this.rg.view(userId);
  }

  /** Polled by the app; returns `due` once per [60] minutes of continuous use. */
  @Get('reality-check')
  @UseGuards(JwtGuard)
  async realityCheck(@Req() request: RequestWithUser) {
    return this.rg.realityCheck(this.me(request).userId);
  }

  // ------------------------------------------------------------------- support

  @Get('tickets')
  @UseGuards(JwtGuard)
  async tickets(@Req() request: RequestWithUser) {
    return this.support.forUser(this.me(request).userId);
  }

  @Post('tickets')
  @UseGuards(JwtGuard)
  async openTicket(@Req() request: RequestWithUser, @Body() body: OpenTicketDto) {
    const { userId } = this.me(request);
    const ticket = await this.run(() =>
      this.support.open({
        userId,
        category: body.category,
        subject: body.subject,
        body: body.body,
        ...(body.marketId === undefined ? {} : { marketId: body.marketId }),
      }),
    );
    return { id: ticket.id, state: ticket.state, slaDue: ticket.slaDue.toISOString() };
  }

  @Post('tickets/:id/reply')
  @UseGuards(JwtGuard)
  async replyToTicket(
    @Req() request: RequestWithUser,
    @Param('id') ticketId: string,
    @Body() body: TicketReplyDto,
  ) {
    const me = this.me(request);
    const ticket = await this.run(() =>
      this.support.reply({
        ticketId,
        authorId: me.userId,
        authorRole: me.role,
        body: body.body,
      }),
    );
    return { id: ticket.id, state: ticket.state };
  }

  // ------------------------------------------------------------- notifications

  @Get('notifications')
  @UseGuards(JwtGuard)
  async inbox(@Req() request: RequestWithUser) {
    const rows = await this.notifications.inbox(this.me(request).userId);
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      payload: row.payloadJson,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  @Post('notifications/read')
  @UseGuards(JwtGuard)
  async markRead(@Req() request: RequestWithUser, @Body() body: { ids?: string[] }) {
    const count = await this.notifications.markRead(this.me(request).userId, body.ids ?? []);
    return { read: count };
  }

  @Post('notifications/preferences')
  @UseGuards(JwtGuard)
  async setPreference(@Req() request: RequestWithUser, @Body() body: PreferenceDto) {
    await this.notifications.setPreference({
      userId: this.me(request).userId,
      channel: body.channel,
      enabled: body.enabled,
    });
    return { channel: body.channel, enabled: body.enabled };
  }

  @Post('notifications/push')
  @UseGuards(JwtGuard)
  async subscribePush(@Req() request: RequestWithUser, @Body() body: PushSubscriptionDto) {
    await this.notifications.subscribePush({
      userId: this.me(request).userId,
      endpoint: body.endpoint,
      p256dh: body.p256dh,
      auth: body.auth,
    });
    return { subscribed: true };
  }

  // ------------------------------------------------------------------- staff 2FA

  @Get('2fa')
  @UseGuards(JwtGuard)
  async totpStatus(@Req() request: RequestWithUser) {
    return this.totp.status(this.me(request).userId);
  }

  @Post('2fa/enrol')
  @UseGuards(JwtGuard)
  async enrol(@Req() request: RequestWithUser) {
    const { userId } = this.me(request);
    const started = await this.run(() => this.totp.beginEnrolment(userId));
    // The secret is returned once, for the "can't scan it?" case. It is not
    // readable again — a second enrolment starts from a new one.
    return { otpauth: started.otpauth, qr: started.qr, secret: started.secret };
  }

  @Post('2fa/confirm')
  @UseGuards(JwtGuard)
  async confirm(@Req() request: RequestWithUser, @Body() body: TotpConfirmDto) {
    const { userId } = this.me(request);
    await this.run(() => this.totp.confirmEnrolment(userId, body.code));
    return this.totp.status(userId);
  }

  /** Rules refuse with a sentence; only the unexpected becomes a 500. */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof RgBlockedError ||
        error instanceof SupportError ||
        error instanceof TotpError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

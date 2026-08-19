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

import { Decimal } from '@stakeam/engine';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { TotpError, TotpService } from '../auth/totp.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RgBlockedError, RgService } from '../rg/rg.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { ConsentService, type ConsentDocument } from '../account/consent.service';
import { FreezeService } from '../account/freeze.service';
import { ReferralService } from '../account/referral.service';
import { SessionsService } from '../account/sessions.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupportError, SupportService } from '../support/support.service';
import { checkTierCap } from '../trade/tier-cap';

/** §2.18: accepting a document, or withdrawing marketing consent. */
export class ConsentDto {
  @IsIn(['terms', 'privacy', 'rules', 'marketing']) document!: ConsentDocument;
  @IsOptional() @IsBoolean() accepted?: boolean;
}

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
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly sessions: SessionsService,
    private readonly freezes: FreezeService,
    private readonly consents: ConsentService,
    private readonly referrals: ReferralService,
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

  /**
   * What this account may stake right now, and what is holding it back.
   *
   * §7.2d requires the Tier 0 cap and §2.12's limits to be visible *in the
   * trade sheet*, not discovered by being refused after committing. That means
   * one read the sheet can make before the person types an amount, answering
   * the same question the trade path will answer — from the same rule
   * (`checkTierCap`) and the same RG figures, so the screen and the engine
   * cannot disagree.
   */
  @Get('trade-allowance')
  @UseGuards(JwtGuard)
  async tradeAllowance(@Req() request: RequestWithUser) {
    const { userId } = this.me(request);

    const [user, rg, capValue, wallets] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { tier: true } }),
      this.rg.view(userId),
      this.config.get('tier0_stake_cap_spc'),
      this.prisma.wallet.findMany({ where: { userId }, select: { escrowed: true } }),
    ]);

    const escrowed = wallets.reduce(
      (total, row) => total.plus(new Decimal(row.escrowed.toString())),
      new Decimal(0),
    );
    const tierCap = checkTierCap({
      tier: user?.tier ?? 0,
      escrowed,
      amount: new Decimal(0),
      cap: new Decimal(capValue.toString()),
    });

    return {
      tier: user?.tier ?? 0,
      escrowed: escrowed.toString(),
      /** Null when uncapped — a verified account, or no cap configured. */
      tierCapRemaining: tierCap.remaining === null ? null : tierCap.remaining.toString(),
      selfExcluded: rg.selfExcluded,
      cooloffUntil: rg.cooloffUntil,
      stakeLimit: rg.effectiveStakeLimit,
      stakedToday: rg.stakedToday,
      lossLimit: rg.effectiveLossLimit,
      lostToday: rg.lostToday,
      helpline: rg.helpline,
    };
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

  // ------------------------------------------------- sessions & devices (§2.18)

  /**
   * Where this account is signed in.
   *
   * The current session is marked so somebody cannot accidentally end it and
   * conclude the button is broken.
   */
  @Get('sessions')
  @UseGuards(JwtGuard)
  async sessionList(@Req() request: RequestWithUser) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');

    const [sessions, freeze] = await Promise.all([
      this.sessions.list(user.userId, user.jti),
      this.freezes.withdrawalsFrozen(user.userId),
    ]);

    return {
      sessions,
      // Shown here rather than only on the wallet: somebody checking their
      // sessions is usually checking because something felt wrong, and the
      // freeze is the other half of that story.
      freeze: {
        active: freeze.frozen,
        until: freeze.until?.toISOString() ?? null,
        reason: freeze.reason,
      },
    };
  }

  @Post('sessions/:id/revoke')
  @UseGuards(JwtGuard)
  async revokeSession(@Req() request: RequestWithUser, @Param('id') id: string) {
    const { userId } = this.me(request);
    return { revoked: await this.sessions.revoke(userId, id) };
  }

  /** End every session but this one. */
  @Post('sessions/revoke-others')
  @UseGuards(JwtGuard)
  async revokeOtherSessions(@Req() request: RequestWithUser) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    // A token with no id predates session recording; there is nothing to spare
    // and ending everything would log this person out too. Refuse rather than
    // do something surprising.
    if (user.jti === undefined) {
      throw new BadRequestException('sign in again before ending your other sessions');
    }
    return { revoked: await this.sessions.revokeOthers(user.userId, user.jti) };
  }

  /**
   * §2.18's one-tap "this wasn't me".
   *
   * Extends the freeze and ends every session rather than lifting anything:
   * somebody pressing this is telling us an attacker is mid-way through, and
   * the right answer is more friction, not less.
   */
  @Post('lock')
  @UseGuards(JwtGuard)
  async lock(@Req() request: RequestWithUser) {
    const { userId } = this.me(request);
    const { endsAt } = await this.freezes.lockDown(userId);
    return { lockedUntil: endsAt.toISOString() };
  }

  // ------------------------------------------------------------ consents (§2.18)

  @Get('consents')
  @UseGuards(JwtGuard)
  async consentHistory(@Req() request: RequestWithUser) {
    const { userId } = this.me(request);
    const [history, outstanding] = await Promise.all([
      this.consents.historyFor(userId),
      this.consents.outstanding(userId),
    ]);
    return { history, outstanding, marketing: await this.consents.marketingAllowed(userId) };
  }

  @Post('consents')
  @UseGuards(JwtGuard)
  async accept(@Req() request: RequestWithUser, @Body() body: ConsentDto) {
    const { userId } = this.me(request);
    const ip = request.ip ?? 'unknown';

    if (body.document === 'marketing' && body.accepted === false) {
      await this.consents.withdrawMarketing(userId, ip);
      return { accepted: false };
    }

    await this.consents.record({ userId, document: body.document, ip });
    return { accepted: true };
  }

  // ----------------------------------------------------------- referrals (§2.17)

  @Get('referrals')
  @UseGuards(JwtGuard)
  async referralSummary(@Req() request: RequestWithUser) {
    return this.referrals.summaryFor(this.me(request).userId);
  }

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

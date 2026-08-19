import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsEmail, IsOptional, IsString, Length, MinLength } from 'class-validator';

import { AnalyticsService } from '../analytics/analytics.service';
import { AuthService } from '../auth/auth.service';
import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { OtpError, OtpService } from '../auth/otp.service';
import { TokenRevocationService } from '../auth/token-revocation.service';
import { RateLimit, RateLimitGuard } from '../hardening/rate-limit.guard';
import { logger } from '../logger';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';

export class SignupDto {
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() phone?: string;
  @MinLength(10) password!: string;
  @IsBoolean() ageAttested!: boolean;
}

export class LoginDto {
  @IsString() contact!: string;
  @IsString() password!: string;
}

export class VerifyDto {
  /** Six digits. Length-checked here so a malformed code never reaches Redis. */
  @IsString() @Length(6, 6) code!: string;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly analytics: AnalyticsService,
    private readonly otp: OtpService,
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly revocations: TokenRevocationService,
  ) {}

  @Post('signup')
  @UseGuards(RateLimitGuard)
  @RateLimit('auth')
  async signup(@Body() body: SignupDto) {
    try {
      const result = await this.auth.signup({
        ...(body.email === undefined ? {} : { email: body.email }),
        ...(body.phone === undefined ? {} : { phone: body.phone }),
        password: body.password,
        ageAttested: body.ageAttested,
      });
      // The top of §6.8's funnel. Best-effort, like every analytics write.
      await this.analytics.record('signup', { tier: result.tier }, result.userId);
      return result;
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit('auth')
  async login(@Body() body: LoginDto) {
    try {
      return await this.auth.login(body);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /**
   * End this session now, rather than when the token happens to expire.
   *
   * Without this, "log out" only cleared the browser's copy — the token itself
   * stayed valid for its full life, so a session ended on a shared or stolen
   * device was not actually ended.
   */
  @Post('logout')
  @UseGuards(JwtGuard)
  async logout(@Req() request: RequestWithUser) {
    const header = request.headers['authorization'];
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      const claims = decodeClaims(header.slice('Bearer '.length));
      if (claims?.jti !== undefined) await this.revocations.revokeToken(claims.jti, claims.exp);
    }
    return { ended: true };
  }

  /**
   * Who am I — identity, tier and balance in one call (§7.5's header).
   *
   * The web app needs all three on nearly every screen, and three round trips
   * to render a header is three chances to show a stale tier next to a fresh
   * balance.
   */
  @Get('me')
  @UseGuards(JwtGuard)
  async me(@Req() request: RequestWithUser) {
    const userId = request.user!.userId;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        handle: true,
        displayName: true,
        tier: true,
        contactVerified: true,
        role: true,
        status: true,
      },
    });
    if (user === null) throw new BadRequestException('user not found');

    const balance = await this.wallet.balanceOf(userId);
    return {
      ...user,
      available: balance.available.toString(),
      escrowed: balance.escrowed.toString(),
    };
  }

  /**
   * Send a verification code to the contact this account signed up with (§2.1).
   *
   * The code goes out through the notifications service rather than being
   * returned here — an endpoint that hands back the secret it just sent is not
   * a verification of anything. Where no SMS or email provider is configured
   * the senders log and record the failure, and the in-app copy still lands, so
   * a development environment stays usable without a backdoor in the API.
   */
  @Post('verify/request')
  @UseGuards(JwtGuard, RateLimitGuard)
  @RateLimit('auth')
  async requestVerification(@Req() request: RequestWithUser) {
    const userId = request.user!.userId;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, phone: true, contactVerified: true },
    });
    if (user === null) throw new BadRequestException('user not found');
    if (user.contactVerified) return { alreadyVerified: true };

    const contact = user.email ?? user.phone;
    if (contact === null || contact === undefined) {
      throw new BadRequestException('this account has no contact to verify');
    }

    let outcome;
    try {
      const code = await this.otp.issue(contact);
      outcome = await this.notifications.notify({
        userId,
        type: 'contact_verification',
        body: `Your StakeAm code is ${code}. It expires shortly — nobody from StakeAm will ever ask you for it.`,
      });
    } catch (error) {
      if (error instanceof OtpError) throw new BadRequestException(error.message);
      throw error;
    }

    // Nothing left the building. Delivery is best-effort everywhere else in the
    // product — a market must settle whether or not an SMS gateway is up — but
    // a verification code that reached nobody is not a courtesy that failed, it
    // is a signup that cannot finish. Saying "sent" here leaves somebody
    // refreshing an inbox that will never fill, which is precisely what an
    // environment with no mail transport configured does to its first user.
    if (outcome.delivered.length === 0) {
      // The code is unusable, so it must not hold the resend cooldown against a
      // retry: the operator's fix is to configure a channel, and the next
      // attempt should go out the moment they have.
      await this.otp.revoke(contact);
      logger.error(
        { userId, failures: outcome.failed.map((row) => `${row.channel}: ${row.failure}`) },
        'verification code could not be delivered on any channel',
      );
      throw new ServiceUnavailableException(
        'we could not send your code — no delivery channel is available. Please contact support.',
      );
    }

    return { sent: true, contact: maskContact(contact) };
  }

  /**
   * Prove the contact and take Tier 1 (§2.1) — and with it the signup bonus,
   * market creation, leaderboards and prize eligibility.
   */
  @Post('verify/confirm')
  @UseGuards(JwtGuard, RateLimitGuard)
  @RateLimit('auth')
  async confirmVerification(@Req() request: RequestWithUser, @Body() body: VerifyDto) {
    const userId = request.user!.userId;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, phone: true, contactVerified: true },
    });
    if (user === null) throw new BadRequestException('user not found');
    if (user.contactVerified) return { tier: 1, alreadyVerified: true };

    const contact = user.email ?? user.phone;
    if (contact === null || contact === undefined) {
      throw new BadRequestException('this account has no contact to verify');
    }

    let matched: boolean;
    try {
      matched = await this.otp.verify(contact, body.code);
    } catch (error) {
      if (error instanceof OtpError) throw new BadRequestException(error.message);
      throw error;
    }
    if (!matched) throw new BadRequestException('that code is not right');

    await this.auth.markContactVerified(userId);
    const balance = await this.wallet.balanceOf(userId);
    return { tier: 1, available: balance.available.toString() };
  }
}

/**
 * `ada@example.com` → `ad…@example.com`; `08031234567` → `080…4567`.
 *
 * Enough for the person to recognise which contact the code went to, not
 * enough to hand a stranger the address itself.
 */
function maskContact(contact: string): string {
  const at = contact.indexOf('@');
  if (at > 0) {
    const name = contact.slice(0, at);
    const head = name.slice(0, Math.min(2, name.length));
    return `${head}…${contact.slice(at)}`;
  }
  if (contact.length <= 7) return contact;
  return `${contact.slice(0, 3)}…${contact.slice(-4)}`;
}

/**
 * Read `jti` and `exp` from an already-verified token.
 *
 * The guard has verified the signature by the time this runs, so this is
 * decoding rather than trusting: it only reads what to revoke and for how long.
 */
function decodeClaims(token: string): { jti?: string; exp?: number } | null {
  const body = token.split('.')[1];
  if (body === undefined) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      jti?: string;
      exp?: number;
    };
  } catch {
    return null;
  }
}

import { Decimal } from '@stakeam/engine';
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import type { User } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { AnalyticsService } from '../analytics/analytics.service';

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface SignupInput {
  /** One of the two is required — §2.1 allows email **or** phone. */
  readonly email?: string;
  readonly phone?: string;
  readonly password: string;
  /** §2.1 requires an explicit 18+ attestation at signup. */
  readonly ageAttested: boolean;
}

export interface AuthTokens {
  readonly accessToken: string;
  readonly userId: string;
  readonly tier: number;
}

/**
 * Tiered verification (§2.1). Friction-free entry; identity checks deferred to
 * the moment money leaves.
 *
 *   Tier 0  email or phone + password. Starter balance, capped trading.
 *   Tier 1  contact proven by OTP. Full signup bonus, creation, leaderboards.
 *   Tier 2  NIN/BVN KYC — licensed phase, stubbed (§9).
 */
@Injectable()
export class AuthService {
  /**
   * argon2id at parameters sized for a login path: memory-hard enough to make
   * offline cracking expensive, fast enough that a burst of logins does not
   * become the outage.
   */
  private static readonly ARGON2_OPTIONS = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly jwt: JwtService,
    private readonly config: PlatformConfigService,
    private readonly analytics: AnalyticsService,
  ) {}

  async signup(input: SignupInput): Promise<AuthTokens> {
    if (input.email === undefined && input.phone === undefined) {
      throw new AuthError('signup needs an email or a phone number');
    }
    if (!input.ageAttested) {
      throw new AuthError('you must confirm you are 18 or older');
    }
    if (input.password.length < 10) {
      throw new AuthError('password must be at least 10 characters');
    }

    const pwHash = await argon2.hash(input.password, AuthService.ARGON2_OPTIONS);
    const starterBalance = await this.config.get('starter_balance_spc');

    const user = await this.createAccount(input, pwHash, starterBalance);

    return this.tokensFor(user);
  }

  /**
   * The account row and the money that comes with it, or a refusal a person can
   * act on.
   *
   * §2.7's one-account-per-contact rule is a unique index, so the duplicate is
   * caught by the database rather than by a lookup — a check-then-insert races
   * two simultaneous signups and lets both through. What the database raises is
   * `P2002`, and that has to be turned into a sentence before it goes anywhere
   * near a person: "Unique constraint failed on the fields: (`email`)" is a
   * query plan, not an answer, and it tells a stranger the schema besides.
   */
  private async createAccount(
    input: SignupInput,
    pwHash: string,
    starterBalance: number,
  ): Promise<User> {
    try {
      return await this.insertAccount(input, pwHash, starterBalance);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const fields = (error.meta?.['target'] ?? []) as string[] | string;
        const clashed = Array.isArray(fields) ? fields.join(', ') : String(fields);
        throw new AuthError(
          clashed.includes('phone')
            ? 'an account already uses that phone number — log in instead, or use another number'
            : 'an account already uses that email — log in instead, or use another address',
        );
      }
      throw error;
    }
  }

  private async insertAccount(
    input: SignupInput,
    pwHash: string,
    starterBalance: number,
  ): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          ...(input.email === undefined ? {} : { email: input.email.toLowerCase() }),
          ...(input.phone === undefined ? {} : { phone: input.phone }),
          pwHash,
          tier: 0,
          contactVerified: false,
          role: 'user',
          status: 'active',
        },
      });

      // Tier 0 gets the starter balance immediately — the full signup bonus
      // waits for a verified contact, which is the anti-farming gate (§2.1).
      if (starterBalance > 0) {
        await this.wallet.issue({
          userId: created.id,
          amount: new Decimal(starterBalance),
          type: 'signup_bonus',
          ref: `signup:${created.id}`,
          tx,
        });
      }

      return created;
    });
  }

  /**
   * Promote Tier 0 → Tier 1 once the signup contact is proven.
   *
   * The OTP itself is checked by `OtpService`; this is the state change and the
   * bonus that follows it. Idempotent: verifying twice does not pay twice.
   */
  async markContactVerified(userId: string): Promise<void> {
    const bonus = await this.config.get('signup_bonus_spc');

    const promoted = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (user === null) throw new AuthError('user not found');
      // Idempotent: verifying twice must not pay twice, and must not record a
      // second funnel step for the same person.
      if (user.contactVerified) return false;

      await tx.user.update({
        where: { id: userId },
        data: { contactVerified: true, tier: Math.max(user.tier, 1) },
      });

      if (bonus > 0) {
        await this.wallet.issue({
          userId,
          amount: new Decimal(bonus),
          type: 'signup_bonus',
          ref: `tier1-bonus:${userId}`,
          tx,
        });
      }
      return true;
    });

    // §6.8's funnel step. Outside the transaction and best-effort: the
    // promotion has already happened, and a dashboard write must never be able
    // to roll one back.
    if (promoted) {
      await this.analytics.record('contact_verified', { tier: 1 }, userId);
    }
  }

  async login(params: { contact: string; password: string }): Promise<AuthTokens> {
    const contact = params.contact.trim();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email: contact.toLowerCase() }, { phone: contact }] },
    });

    // Verify against a dummy hash when the user is absent so a missing account
    // and a wrong password take the same time to answer.
    const hash =
      user?.pwHash ??
      '$argon2id$v=19$m=19456,t=2,p=1$c3Rha2VhbXNhbHQ$0000000000000000000000000000000000000000000';
    let ok = false;
    try {
      ok = await argon2.verify(hash, params.password);
    } catch {
      ok = false;
    }

    if (!ok || user === null) {
      throw new AuthError('invalid credentials');
    }
    if (user.status !== 'active') {
      throw new AuthError(`account is ${user.status}`);
    }

    return this.tokensFor(user);
  }

  private async tokensFor(user: User): Promise<AuthTokens> {
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      tier: user.tier,
      jti: randomUUID(),
    });
    return { accessToken, userId: user.id, tier: user.tier };
  }
}

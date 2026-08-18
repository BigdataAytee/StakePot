import { Injectable } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { generateSecret, generateURI, verifySync } from 'otplib';
import { toDataURL } from 'qrcode';

import { STAFF_ROLES } from './roles.guard';
import { PrismaService } from '../prisma/prisma.service';

export class TotpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TotpError';
  }
}

const ISSUER = 'StakeAm';

/**
 * Staff TOTP (§2.11, §6.4b).
 *
 * "Staff 2FA mandatory for all admin/resolver/support roles... session timeout
 * + re-auth for sensitive actions." Two separate things live here: enrolment,
 * and the step-up challenge that a money action demands regardless of how fresh
 * the session is.
 *
 * A secret is written when enrolment starts but only counts once a code proves
 * the authenticator holds it — `totpConfirmedAt` is the switch. Otherwise a
 * mistyped setup would lock somebody out of a console they are responsible for.
 */
@Injectable()
export class TotpService {
  constructor(private readonly prisma: PrismaService) {}

  /** Begin enrolment: a fresh secret, the otpauth URI, and a QR to scan. */
  async beginEnrolment(userId: string): Promise<{ secret: string; otpauth: string; qr: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user === null) throw new TotpError('no such user');
    if (!STAFF_ROLES.includes(user.role)) {
      throw new TotpError('2FA enrolment is for staff accounts');
    }
    if (user.totpConfirmedAt !== null) {
      throw new TotpError('this account already has 2FA — reset it through support');
    }

    const secret = generateSecret();
    const label = user.email ?? user.phone ?? user.id;
    const otpauth = generateURI({ issuer: ISSUER, label, secret });

    await this.prisma.user.update({ where: { id: userId }, data: { totpSecret: secret } });
    return { secret, otpauth, qr: await toDataURL(otpauth) };
  }

  /** Finish enrolment by proving the authenticator has the secret. */
  async confirmEnrolment(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user?.totpSecret == null) throw new TotpError('start enrolment first');
    if (user.totpConfirmedAt !== null) throw new TotpError('2FA is already active');
    if (!verifySync({ secret: user.totpSecret, token: code }).valid) {
      throw new TotpError('that code did not match');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpConfirmedAt: new Date() },
    });
  }

  /**
   * The step-up challenge in front of a sensitive action (§6.4b).
   *
   * Fails closed in both directions: an unenrolled staff account cannot pass it,
   * and neither can a wrong code. §2.11 makes 2FA mandatory for staff, so "not
   * enrolled yet" is a reason to stop, not a reason to wave through.
   */
  async assertStepUp(params: { userId: string; role: UserRole; code?: string }): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: params.userId } });
    if (user === null) throw new TotpError('no such user');
    if (user.totpConfirmedAt === null || user.totpSecret === null) {
      throw new TotpError('set up 2FA before approving anything — §2.11 requires it for staff');
    }
    if (params.code === undefined || params.code.trim().length === 0) {
      throw new TotpError('enter the code from your authenticator');
    }
    if (!verifySync({ secret: user.totpSecret, token: params.code.trim() }).valid) {
      throw new TotpError('that code did not match');
    }
  }

  /** Whether an account has 2FA live, for the console to show its own state. */
  async status(userId: string): Promise<{ enrolled: boolean; confirmedAt: string | null }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return {
      enrolled: user?.totpConfirmedAt != null,
      confirmedAt: user?.totpConfirmedAt?.toISOString() ?? null,
    };
  }
}

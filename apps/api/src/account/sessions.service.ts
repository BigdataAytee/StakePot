import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

/**
 * §2.18's sessions and devices.
 *
 * "Users see active sessions/devices and can log out others; new-device login
 * notifies existing devices."
 *
 * What is stored is a hash of the token's id, never the token. A session list
 * that can hand back a working credential is a session list worth stealing —
 * and the whole feature exists to help somebody who thinks they have already
 * been compromised.
 */
@Injectable()
export class SessionsService {
  constructor(private readonly prisma: PrismaService) {}

  private static hash(jti: string): string {
    return createHash('sha256').update(jti).digest('hex');
  }

  /** Record a sign-in. Returns whether this looks like a new device. */
  async open(params: {
    userId: string;
    jti: string;
    userAgent: string;
    ip: string;
  }): Promise<{ sessionId: string; newDevice: boolean }> {
    // "New device" is judged on the user agent rather than the IP: Nigerian
    // mobile networks re-issue addresses constantly, so an IP change means
    // almost nothing and would make the notification fire on every commute.
    const seenBefore = await this.prisma.userSession.count({
      where: { userId: params.userId, userAgent: params.userAgent },
    });

    const session = await this.prisma.userSession.create({
      data: {
        userId: params.userId,
        tokenHash: SessionsService.hash(params.jti),
        userAgent: params.userAgent,
        ip: params.ip,
      },
    });

    return { sessionId: session.id, newDevice: seenBefore === 0 };
  }

  /** What the account screen shows. Live sessions only, newest first. */
  async list(userId: string, currentJti?: string) {
    const rows = await this.prisma.userSession.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });

    const current = currentJti === undefined ? null : SessionsService.hash(currentJti);

    return rows.map((row) => ({
      id: row.id,
      userAgent: row.userAgent,
      ip: row.ip,
      lastSeenAt: row.lastSeenAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      // Marked so somebody cannot accidentally log themselves out and wonder
      // why the button did nothing.
      current: current !== null && row.tokenHash === current,
    }));
  }

  async touch(jti: string): Promise<void> {
    await this.prisma.userSession.updateMany({
      where: { tokenHash: SessionsService.hash(jti), revokedAt: null },
      data: { lastSeenAt: new Date() },
    });
  }

  async revoke(userId: string, sessionId: string, reason = 'user'): Promise<boolean> {
    const result = await this.prisma.userSession.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedFor: reason },
    });
    return result.count > 0;
  }

  /**
   * End every session but the one asking.
   *
   * The button somebody presses when they think they have been compromised, so
   * it must not also log them out — being thrown back to a login screen at
   * that moment is how people give up and lose the account.
   */
  async revokeOthers(userId: string, currentJti: string, reason = 'user'): Promise<number> {
    const result = await this.prisma.userSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        tokenHash: { not: SessionsService.hash(currentJti) },
      },
      data: { revokedAt: new Date(), revokedFor: reason },
    });
    return result.count;
  }

  /** Whether a token's session is still live — the check a guard makes. */
  async isLive(jti: string): Promise<boolean> {
    const session = await this.prisma.userSession.findUnique({
      where: { tokenHash: SessionsService.hash(jti) },
      select: { revokedAt: true },
    });
    // Unknown means "issued before sessions were recorded", which must not
    // lock out everybody already signed in at deploy time.
    return session === null || session.revokedAt === null;
  }
}

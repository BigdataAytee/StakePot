import { Injectable } from '@nestjs/common';

import { logger } from '../logger';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * §2.18's SIM-swap and contact-change protection.
 *
 * "Changing the registered phone or email triggers a [48h] withdrawal freeze
 * on the account and a notification to the *old* contact with a one-tap 'this
 * wasn't me' lock. This single rule blocks Nigeria's most common wallet-theft
 * pattern."
 *
 * The attack, plainly: take over somebody's phone number at the network,
 * receive their OTP, change the contact details, withdraw. Every step of that
 * works today at most Nigerian fintechs. The freeze does not stop any of it —
 * it stops the last step for long enough that the real owner, who is sitting
 * there with a dead SIM wondering what happened, has a chance to act.
 *
 * Two details carry the whole design:
 *  - The notification goes to the **old** contact. Sending it to the new one
 *    tells the attacker, and nobody else.
 *  - The freeze blocks **withdrawals only**. Locking the account entirely
 *    would punish the far more common case, which is somebody who simply got
 *    a new phone.
 */
@Injectable()
export class FreezeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Freeze withdrawals after a contact change.
   *
   * `oldContact` is passed in rather than read back, because by the time this
   * runs the row has already been updated and the old value is gone — which is
   * exactly the mistake that would send the warning to the attacker.
   */
  async onContactChange(params: {
    userId: string;
    field: 'phone' | 'email';
    oldContact: string | null;
    hours?: number;
    now?: Date;
  }): Promise<{ freezeId: string; endsAt: Date }> {
    const now = params.now ?? new Date();
    const hours = params.hours ?? 48;
    const endsAt = new Date(now.getTime() + hours * 3_600_000);

    const freeze = await this.prisma.accountFreeze.create({
      data: {
        userId: params.userId,
        reason: `${params.field}_changed`,
        startedAt: now,
        endsAt,
      },
    });

    await this.notifications
      .notify({
        userId: params.userId,
        type: 'contact_changed',
        body:
          `The ${params.field} on your account was changed. Withdrawals are paused for ` +
          `${hours} hours. If this was not you, lock the account now.`,
        data: {
          field: params.field,
          endsAt: endsAt.toISOString(),
          // Carried explicitly: by the time this runs the row already holds
          // the new value, and routing on it would send the warning to
          // whoever just changed it.
          previousContact: params.oldContact ?? '',
        },
      })
      .catch((error: unknown) => {
        // A failed notification must not roll back the freeze. The freeze is
        // the protection; the message is the courtesy.
        logger.error({ userId: params.userId, error }, 'could not warn about a contact change');
      });

    return { freezeId: freeze.id, endsAt };
  }

  /** Whether withdrawals are currently frozen, and until when. */
  async withdrawalsFrozen(
    userId: string,
    now = new Date(),
  ): Promise<{ frozen: boolean; until: Date | null; reason: string | null }> {
    const freeze = await this.prisma.accountFreeze.findFirst({
      where: { userId, liftedAt: null, endsAt: { gt: now } },
      orderBy: { endsAt: 'desc' },
    });

    return freeze === null
      ? { frozen: false, until: null, reason: null }
      : { frozen: true, until: freeze.endsAt, reason: freeze.reason };
  }

  /**
   * The "this wasn't me" lock.
   *
   * Deliberately does *not* lift the freeze — it extends it and ends every
   * session. Somebody pressing this is telling us an attacker is mid-way
   * through, and the right answer is more friction, not less.
   */
  async lockDown(userId: string, days = 7, now = new Date()): Promise<{ endsAt: Date }> {
    const endsAt = new Date(now.getTime() + days * 86_400_000);

    await this.prisma.$transaction([
      this.prisma.accountFreeze.create({
        data: { userId, reason: 'reported_not_me', startedAt: now, endsAt },
      }),
      this.prisma.userSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedFor: 'sim_swap_freeze' },
      }),
    ]);

    logger.warn({ userId }, 'account locked down after a "this was not me" report');
    return { endsAt };
  }

  /** Staff lifting a freeze after talking to the real owner. */
  async lift(userId: string, staffId: string, now = new Date()): Promise<number> {
    const result = await this.prisma.accountFreeze.updateMany({
      where: { userId, liftedAt: null, endsAt: { gt: now } },
      data: { liftedAt: now, liftedBy: staffId },
    });
    return result.count;
  }
}

import { Injectable } from '@nestjs/common';
import webpush from 'web-push';

import { env } from '../config/env';
import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Web push (§2.12, PWA).
 *
 * A subscription the browser has retired comes back as 404 or 410; those rows
 * are deleted rather than retried, because a dead endpoint that stays in the
 * table turns every future send into a guaranteed failure.
 */
@Injectable()
export class PushSender {
  private configured = false;

  constructor(private readonly prisma: PrismaService) {}

  private ready(): boolean {
    if (this.configured) return true;
    if (env.VAPID_PUBLIC_KEY === undefined || env.VAPID_PRIVATE_KEY === undefined) return false;
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    this.configured = true;
    return true;
  }

  async send(userId: string, title: string, body: string): Promise<string | null> {
    if (!this.ready()) {
      logger.info({ userId, title }, 'push not configured — notification logged instead of sent');
      return 'VAPID keys are not configured';
    }

    const subscriptions = await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subscriptions.length === 0) return 'no push subscription on this account';

    const payload = JSON.stringify({ title, body });
    const failures: string[] = [];

    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
        );
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await this.prisma.pushSubscription.delete({ where: { id: subscription.id } });
          continue;
        }
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    return failures.length === 0 ? null : failures.join('; ');
  }
}

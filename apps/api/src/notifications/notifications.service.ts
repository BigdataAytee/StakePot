import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { NotificationChannel } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { logger } from '../logger';
import { EmailSender } from './email.sender';
import { PushSender } from './push.sender';
import { SmsSender } from './sms.sender';

/**
 * What the platform tells people about (§2.12).
 *
 * "Transactional messages (trade confirmed, market resolved, payout made,
 * dispute update) via in-app + SMS/email through the queue; per-user
 * notification preferences."
 */
export const NOTIFICATION_TYPES = {
  trade_confirmed: { title: 'Trade confirmed', channels: ['in_app'] },
  market_resolved: { title: 'Market settled', channels: ['in_app', 'push', 'email'] },
  payout: { title: 'Your position settled', channels: ['in_app', 'push', 'email'] },
  refund: { title: 'Refunded in full', channels: ['in_app', 'push', 'email'] },
  dispute_update: { title: 'Dispute update', channels: ['in_app', 'push'] },
  market_activated: { title: 'Market is open', channels: ['in_app', 'push'] },
  support_reply: { title: 'Support replied', channels: ['in_app', 'push', 'email'] },
  // §2.14's creator platform. Deliberately in-app and push only: a creator's
  // standing changing is worth an alert, not an email, and a nudge that arrives
  // by SMS at 3am is how a creator turns notifications off entirely.
  creator_nudge: { title: 'Your market needs something', channels: ['in_app', 'push'] },
  creator_new_market: { title: 'A creator you follow posted', channels: ['in_app', 'push'] },
  creator_level: { title: 'Your creator level changed', channels: ['in_app', 'push'] },
  market_autopsy: { title: 'Your market settled', channels: ['in_app', 'push'] },
  // §2.8's weekly prize. Email as well: money arriving is worth a record
  // somewhere the recipient can find again.
  prize: { title: 'You won a prize', channels: ['in_app', 'push', 'email'] },
  /*
   * §2.1's Tier 1 gate. Email and SMS only — deliberately **not** in-app.
   *
   * The point of the code is to prove control of the contact. Serving it to the
   * signed-in session defeats that entirely: the inbox endpoint is authenticated
   * by the very session trying to prove itself, so anyone who signed up with
   * somebody else's address could read their own code out of the app and take
   * Tier 1 — and with it the bonus, market creation, leaderboards and prize
   * eligibility. A code that travels back down the channel it is verifying is
   * not a second factor, it is a formality.
   *
   * It goes to whichever of email or phone the person signed up with. A support
   * agent reading a live code back to a caller would be the same hole with a
   * human in it, so that is not a use this supports either.
   */
  contact_verification: {
    title: 'Your verification code',
    channels: ['email', 'sms'],
  },
  /*
   * §2.18's SIM-swap defence.
   *
   * Every channel, and the one type where that is not overkill. This is the
   * message that reaches somebody whose phone number has just been taken over
   * — the SMS will not arrive, which is precisely why the email and the push
   * have to. A person who cannot be reached on any channel is the case the
   * 48-hour freeze covers instead.
   */
  contact_changed: {
    title: 'Your contact details changed',
    channels: ['in_app', 'push', 'email', 'sms'],
  },
  rg_confirmation: {
    title: 'Your limits changed',
    // Deliberately every channel, including SMS: a person who has just excluded
    // themselves should get the confirmation somewhere they will actually see it.
    channels: ['in_app', 'push', 'email', 'sms'],
  },
} as const satisfies Record<string, { title: string; channels: readonly NotificationChannel[] }>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

/** What a `notify` call actually managed to send, and what it did not. */
export interface NotifyOutcome {
  readonly delivered: readonly NotificationChannel[];
  readonly failed: readonly { channel: NotificationChannel; failure: string }[];
}

export interface NotifyInput {
  readonly userId: string;
  readonly type: NotificationType;
  /** Rendered into the message body; also stored, so history reads as sent. */
  readonly body: string;
  readonly data?: Record<string, string>;
}

/**
 * The notifications service.
 *
 * Every send writes a row **whether or not the channel took it**, with the
 * failure on the row when it did not. A notification that silently failed is
 * indistinguishable from one that was never attempted, and "we told them" is a
 * claim the support desk has to be able to check.
 *
 * Delivery is best-effort by design: a market must resolve whether or not an
 * SMS gateway is up, so a failing channel is logged and recorded, never thrown.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushSender,
    private readonly email: EmailSender,
    private readonly sms: SmsSender,
  ) {}

  /**
   * Send, and say what happened.
   *
   * The return value exists for the callers where delivery is the point rather
   * than a courtesy — a verification code with nowhere to go is not a
   * notification that failed quietly, it is a signup that cannot complete, and
   * the person waiting deserves to be told that instead of "sent".
   */
  async notify(input: NotifyInput): Promise<NotifyOutcome> {
    const definition = NOTIFICATION_TYPES[input.type];
    const delivered: NotificationChannel[] = [];
    const failed: { channel: NotificationChannel; failure: string }[] = [];

    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { email: true, phone: true },
    });
    if (user === null) return { delivered, failed };

    const preferences = await this.prisma.notificationPreference.findMany({
      where: { userId: input.userId },
    });

    for (const channel of definition.channels) {
      // A missing row means the channel's default applies. Adding a channel must
      // not start messaging people who never agreed to hear from it that way.
      const preference = preferences.find((row) => row.channel === channel);
      if (preference !== undefined && !preference.enabled) continue;

      const failure = await this.deliver(channel, {
        userId: input.userId,
        title: definition.title,
        body: input.body,
        email: user.email,
        phone: user.phone,
      });

      if (failure === null) delivered.push(channel);
      else failed.push({ channel, failure });

      await this.prisma.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          channel,
          payloadJson: {
            title: definition.title,
            body: input.body,
            ...(input.data ?? {}),
          } as Prisma.InputJsonValue,
          ...(failure === null ? { sentAt: new Date() } : { sentAt: null, failure }),
        },
      });
    }

    return { delivered, failed };
  }

  /** The in-app inbox. */
  async inbox(userId: string, limit = 50) {
    return this.prisma.notification.findMany({
      where: { userId, channel: 'in_app' },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async markRead(userId: string, ids: readonly string[]): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { userId, id: { in: [...ids] }, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  async setPreference(params: {
    userId: string;
    channel: NotificationChannel;
    enabled: boolean;
  }): Promise<void> {
    await this.prisma.notificationPreference.upsert({
      where: { userId_channel: { userId: params.userId, channel: params.channel } },
      create: params,
      update: { enabled: params.enabled },
    });
  }

  /** Register a browser for web push. Keyed by endpoint — browsers rotate them. */
  async subscribePush(params: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
  }): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: params.endpoint },
      create: params,
      update: { userId: params.userId, p256dh: params.p256dh, auth: params.auth },
    });
  }

  /** Returns null on success, or the reason it did not go. */
  private async deliver(
    channel: NotificationChannel,
    message: {
      userId: string;
      title: string;
      body: string;
      email: string | null;
      phone: string | null;
    },
  ): Promise<string | null> {
    try {
      switch (channel) {
        case 'in_app':
          return null;
        case 'push':
          return await this.push.send(message.userId, message.title, message.body);
        case 'email':
          if (message.email === null) return 'no email address on the account';
          return await this.email.send(message.email, message.title, message.body);
        case 'sms':
          if (message.phone === null) return 'no phone number on the account';
          return await this.sms.send(message.phone, `${message.title}: ${message.body}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn({ channel, userId: message.userId, reason }, 'notification channel failed');
      return reason;
    }
  }
}

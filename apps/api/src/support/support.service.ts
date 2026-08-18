import { Injectable } from '@nestjs/common';
import type { SupportTicket, TicketCategory, UserRole } from '@prisma/client';

import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';

export class SupportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupportError';
  }
}

const STAFF: readonly UserRole[] = ['support', 'resolver', 'trust_safety', 'finance', 'admin'];

/**
 * The support desk (§2.12, §6.7).
 *
 * "In-app ticketing tied to user + market context; categories; SLA timers with
 * escalation; canned-response library; support role sees tickets + read-only
 * market state, nothing else."
 *
 * The SLA is a promise with a clock on it, so two details matter: it is set
 * from the category (an RG request is not a payout question), and it *pauses*
 * when the ball is in the user's court. A desk that counts its own waiting time
 * as lateness eventually stops believing its own amber.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  async open(params: {
    userId: string;
    category: TicketCategory;
    subject: string;
    body: string;
    marketId?: string;
    now?: Date;
  }): Promise<SupportTicket> {
    const now = params.now ?? new Date();
    if (params.subject.trim().length < 5) throw new SupportError('give the ticket a subject');
    if (params.body.trim().length < 10) throw new SupportError('say what happened');

    const slaDue = new Date(now.getTime() + (await this.slaHoursFor(params.category)) * 3_600_000);

    return this.prisma.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.create({
        data: {
          userId: params.userId,
          category: params.category,
          subject: params.subject.trim(),
          slaDue,
          ...(params.marketId === undefined ? {} : { marketId: params.marketId }),
        },
      });
      await tx.supportMessage.create({
        data: { ticketId: ticket.id, authorId: params.userId, body: params.body.trim() },
      });
      return ticket;
    });
  }

  /**
   * Add a turn to the conversation.
   *
   * A staff reply moves the ticket to `waiting_on_user` and stops the clock; a
   * user reply starts it again from the category's SLA. That is the whole
   * escalation model, and it is the honest one — lateness should mean the team
   * has not answered, not that the conversation is still going.
   */
  async reply(params: {
    ticketId: string;
    authorId: string;
    authorRole: UserRole;
    body: string;
    staffOnly?: boolean;
    now?: Date;
  }): Promise<SupportTicket> {
    const now = params.now ?? new Date();
    if (params.body.trim().length < 2) throw new SupportError('write something');

    const ticket = await this.prisma.supportTicket.findUnique({ where: { id: params.ticketId } });
    if (ticket === null) throw new SupportError('no such ticket');

    const isStaff = STAFF.includes(params.authorRole);
    if (!isStaff && ticket.userId !== params.authorId) {
      throw new SupportError('this is not your ticket');
    }
    if (ticket.state === 'closed') throw new SupportError('this ticket is closed');
    if (params.staffOnly === true && !isStaff) {
      throw new SupportError('only staff write internal notes');
    }

    await this.prisma.supportMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: params.authorId,
        body: params.body.trim(),
        staffOnly: params.staffOnly ?? false,
      },
    });

    // An internal note is not an answer, so it does not stop the clock.
    if (params.staffOnly === true) return ticket;

    const updated = isStaff
      ? await this.prisma.supportTicket.update({
          where: { id: ticket.id },
          data: { state: 'waiting_on_user', assignedTo: params.authorId },
        })
      : await this.prisma.supportTicket.update({
          where: { id: ticket.id },
          data: {
            state: 'open',
            slaDue: new Date(now.getTime() + (await this.slaHoursFor(ticket.category)) * 3_600_000),
          },
        });

    if (isStaff) {
      await this.notifications.notify({
        userId: ticket.userId,
        type: 'support_reply',
        body: `Support replied to “${ticket.subject}”.`,
        data: { ticketId: ticket.id },
      });
    }

    return updated;
  }

  async resolve(params: {
    ticketId: string;
    staffId: string;
    role: UserRole;
    now?: Date;
  }): Promise<SupportTicket> {
    if (!STAFF.includes(params.role)) throw new SupportError('only staff resolve tickets');
    return this.prisma.supportTicket.update({
      where: { id: params.ticketId },
      data: { state: 'resolved', resolvedAt: params.now ?? new Date(), assignedTo: params.staffId },
    });
  }

  /**
   * Escalate everything the desk is late on.
   *
   * Runs on a sweep rather than a per-ticket timer: an SLA breach is a state of
   * the queue, and rebuilding it from the table costs one query.
   */
  async escalateOverdue(now = new Date()): Promise<number> {
    const overdue = await this.prisma.supportTicket.findMany({
      where: { state: 'open', slaDue: { lte: now } },
      select: { id: true },
    });
    if (overdue.length === 0) return 0;

    await this.prisma.supportTicket.updateMany({
      where: { id: { in: overdue.map((ticket) => ticket.id) } },
      data: { state: 'escalated', escalatedAt: now },
    });
    return overdue.length;
  }

  /** The user's own tickets, with the conversation minus internal notes. */
  async forUser(userId: string) {
    return this.prisma.supportTicket.findMany({
      where: { userId },
      include: {
        messages: { where: { staffOnly: false }, orderBy: { createdAt: 'asc' } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * The desk's queue (§6.7).
   *
   * "Ticket view shows the user's read-only context (their market, their
   * trade — never ledger internals)." The select list here is that rule: there
   * is no balance on it, so a support screen cannot render one.
   */
  async queue(params: { state?: 'open' | 'escalated' | 'waiting_on_user'; now?: Date } = {}) {
    const now = params.now ?? new Date();
    const tickets = await this.prisma.supportTicket.findMany({
      where:
        params.state === undefined ? { state: { notIn: ['closed'] } } : { state: params.state },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        user: { select: { id: true, email: true, phone: true, tier: true, status: true } },
        market: { select: { id: true, question: true, state: true } },
      },
      orderBy: [{ state: 'asc' }, { slaDue: 'asc' }],
      take: 100,
    });

    return tickets.map((ticket) => ({
      ...ticket,
      /** amber before it is late, red after — §6.10's three severities. */
      slaState:
        ticket.state === 'waiting_on_user'
          ? ('paused' as const)
          : ticket.slaDue.getTime() <= now.getTime()
            ? ('breached' as const)
            : ticket.slaDue.getTime() - now.getTime() < 3_600_000
              ? ('due_soon' as const)
              : ('ok' as const),
    }));
  }

  private async slaHoursFor(category: TicketCategory): Promise<number> {
    const table = await this.config.get('support_sla_hours');
    return table[category] ?? table['other'] ?? 48;
  }
}

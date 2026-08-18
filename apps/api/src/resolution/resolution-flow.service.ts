import { Injectable } from '@nestjs/common';
import type { Dispute, Resolution, UserRole } from '@prisma/client';

import { AdminAuditService } from '../audit/admin-audit.service';
import { STAFF_ROLES } from '../auth/roles.guard';
import { type Tx } from '../ledger/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResolutionService, type ResolveOutcome } from '../trade/resolution.service';

export class ResolutionFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionFlowError';
  }
}

export interface FlowActor {
  readonly userId: string;
  readonly role: UserRole;
  readonly ip: string;
}

const isStaff = (role: UserRole): boolean => STAFF_ROLES.includes(role);
const canResolve = (role: UserRole): boolean => role === 'resolver' || role === 'admin';

/**
 * The resolution flow (§2.6, Rulebook Part 1 §5, Part 3 §5).
 *
 *   1. Event concludes → creator (community) or staff (official) posts a
 *      **Proposed Resolution** with a reference to the named source.
 *   2. `dispute_window` state, 48h timer. Participants may file disputes with
 *      evidence; only named-source evidence is admissible.
 *   3. Resolver reviews → **Final Resolution** → payout batch runs, bonds
 *      refunded or forfeited.
 *
 * The payout itself is `ResolutionService`, unchanged — this service is the
 * procedure around it, and the procedure is the point. A market that pays out
 * the moment one person says who won is a market whose creator can steal from
 * it. Two rules do the work: only staff post the Final Resolution, and the
 * finaliser can never be the person who proposed it.
 */
@Injectable()
export class ResolutionFlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
    private readonly payouts: ResolutionService,
    private readonly audit: AdminAuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Post a Proposed Resolution and open the dispute window.
   *
   * Nothing is paid here. The proposal is a claim with a source attached, and
   * the window exists so the people whose money it is can argue with it.
   */
  async propose(params: {
    marketId: string;
    outcomeId: string;
    evidenceUrl: string;
    actor: FlowActor;
  }): Promise<{ resolution: Resolution; disputeClosesAt: Date }> {
    if (!/^https?:\/\//.test(params.evidenceUrl)) {
      throw new ResolutionFlowError('a proposal needs a link to the named source');
    }
    const windowHours = await this.config.get('dispute_window_hours');

    return this.prisma.$transaction(async (tx) => {
      const market = await this.lock(tx, params.marketId);

      if (!['active', 'frozen', 'pending_resolution'].includes(market.state)) {
        throw new ResolutionFlowError(`market is ${market.state} — it cannot be resolved`);
      }

      const proposer = params.actor;
      const isCreator = market.creatorId !== null && market.creatorId === proposer.userId;
      if (market.shelf === 'community') {
        // Part 3 §5: the creator posts it. Staff may post it too — a creator who
        // abandons resolution is exactly the case the conduct bond covers, and
        // the market still has to settle for everyone else.
        if (!isCreator && !isStaff(proposer.role)) {
          throw new ResolutionFlowError('only the market’s creator or staff can propose a result');
        }
      } else if (!isStaff(proposer.role)) {
        throw new ResolutionFlowError('official markets are resolved by staff');
      }

      const outcome = await tx.outcome.findUnique({ where: { id: params.outcomeId } });
      if (outcome === null || outcome.marketId !== market.id) {
        throw new ResolutionFlowError('that outcome does not belong to this market');
      }

      const open = await tx.resolution.findFirst({
        where: { marketId: market.id, finalizedAt: null },
      });
      if (open !== null) {
        throw new ResolutionFlowError('a proposal is already open on this market');
      }

      const disputeClosesAt = new Date(Date.now() + windowHours * 3_600_000);
      const resolution = await tx.resolution.create({
        data: {
          marketId: market.id,
          proposedBy: proposer.userId,
          proposedOutcomeId: params.outcomeId,
          evidenceUrl: params.evidenceUrl,
        },
      });

      await tx.market.update({
        where: { id: market.id },
        data: { state: 'dispute_window', disputeClosesAt },
      });
      await tx.marketAnnotation.create({
        data: {
          marketId: market.id,
          type: 'resolution',
          label: `Proposed: ${outcome.label} — ${windowHours}h to dispute`,
        },
      });

      await this.audit.record(
        {
          staffId: proposer.userId,
          action: 'resolution.propose',
          targetRef: `market:${market.id}`,
          after: { outcome: outcome.label, evidenceUrl: params.evidenceUrl },
          ip: proposer.ip,
        },
        tx,
      );

      return { resolution, disputeClosesAt };
    });
  }

  /**
   * File a dispute (Part 1 §5, Part 3 §6).
   *
   * "Any participant in the market may file a dispute with evidence from the
   * Resolution Source." Participation is read from the trade record, so
   * sponsors and seeders count — their money is in the pot like anyone's.
   */
  async fileDispute(params: {
    marketId: string;
    userId: string;
    evidenceUrl: string;
    text: string;
  }): Promise<Dispute> {
    if (!/^https?:\/\//.test(params.evidenceUrl)) {
      throw new ResolutionFlowError('only evidence from the market’s named source is admissible');
    }
    if (params.text.trim().length < 20) {
      throw new ResolutionFlowError('say what the source shows, and how it contradicts the result');
    }

    return this.prisma.$transaction(async (tx) => {
      const market = await this.lock(tx, params.marketId);
      if (market.state !== 'dispute_window') {
        throw new ResolutionFlowError(`market is ${market.state} — there is nothing to dispute`);
      }
      if (market.disputeClosesAt !== null && market.disputeClosesAt.getTime() <= Date.now()) {
        throw new ResolutionFlowError('the dispute window has closed');
      }

      const traded = await tx.trade.count({
        where: { marketId: market.id, userId: params.userId },
      });
      if (traded === 0) {
        throw new ResolutionFlowError('only participants in this market can dispute its result');
      }

      const existing = await tx.dispute.findFirst({
        where: { marketId: market.id, userId: params.userId, state: 'open' },
      });
      if (existing !== null) {
        throw new ResolutionFlowError('you already have an open dispute on this market');
      }

      const dispute = await tx.dispute.create({
        data: {
          marketId: market.id,
          userId: params.userId,
          evidenceUrl: params.evidenceUrl,
          text: params.text.trim(),
        },
      });

      await tx.marketAnnotation.create({
        data: { marketId: market.id, type: 'news', label: 'A participant disputed the result' },
      });

      return dispute;
    });
  }

  /** Uphold or reject a dispute. Resolver's call, with the reasoning recorded. */
  async decideDispute(params: {
    disputeId: string;
    upheld: boolean;
    decision: string;
    actor: FlowActor;
  }): Promise<Dispute> {
    if (!canResolve(params.actor.role)) {
      throw new ResolutionFlowError('only a resolver or admin decides disputes');
    }
    if (params.decision.trim().length < 10) {
      throw new ResolutionFlowError(
        'a decision needs its reasoning — this is the licensing exhibit',
      );
    }

    const dispute = await this.prisma.dispute.findUnique({ where: { id: params.disputeId } });
    if (dispute === null) throw new ResolutionFlowError('no such dispute');
    if (dispute.state !== 'open') {
      throw new ResolutionFlowError(`this dispute is already ${dispute.state}`);
    }

    const decided = await this.prisma.dispute.update({
      where: { id: dispute.id },
      data: {
        state: params.upheld ? 'upheld' : 'rejected',
        decidedBy: params.actor.userId,
        decision: params.decision.trim(),
        decidedAt: new Date(),
      },
    });

    await this.audit.record({
      staffId: params.actor.userId,
      action: params.upheld ? 'dispute.uphold' : 'dispute.reject',
      targetRef: `dispute:${dispute.id}`,
      before: { state: 'open' },
      after: { state: decided.state, decision: decided.decision ?? '' },
      ip: params.actor.ip,
    });

    return decided;
  }

  /**
   * Post the Final Resolution and pay everybody (§2.6 step 3).
   *
   * Two guards, both about who: staff only, and never the person who proposed
   * it. On a community market the proposer is usually the creator, so the second
   * guard is what "the platform confirms every community resolution before
   * payout" (Part 3 §5) actually means in code.
   *
   * The winning outcome is an argument rather than a lookup because an upheld
   * dispute can change it — that is the whole point of the window.
   */
  async finalize(params: {
    marketId: string;
    outcomeId: string;
    actor: FlowActor;
    reasoning: string;
  }): Promise<ResolveOutcome> {
    if (!canResolve(params.actor.role)) {
      throw new ResolutionFlowError('only a resolver or admin posts the Final Resolution');
    }
    if (params.reasoning.trim().length < 10) {
      throw new ResolutionFlowError('record why this is the result');
    }

    const market = await this.prisma.market.findUnique({ where: { id: params.marketId } });
    if (market === null) throw new ResolutionFlowError('no such market');
    if (market.state !== 'dispute_window') {
      throw new ResolutionFlowError(
        `market is ${market.state} — a result has to be proposed before it can be final`,
      );
    }

    const proposal = await this.prisma.resolution.findFirst({
      where: { marketId: market.id, finalizedAt: null },
      orderBy: { proposedAt: 'desc' },
    });
    if (proposal === null)
      throw new ResolutionFlowError('there is no open proposal on this market');
    if (proposal.proposedBy === params.actor.userId) {
      throw new ResolutionFlowError(
        'you proposed this result — someone else confirms it, or nobody is checking',
      );
    }

    const disputes = await this.prisma.dispute.findMany({ where: { marketId: market.id } });
    if (disputes.some((d) => d.state === 'open')) {
      throw new ResolutionFlowError('decide the open disputes before finalising');
    }

    // Part 1 §5: "After the window closes (or after a dispute is decided), the
    // platform posts the Final Resolution." A market that was disputed and
    // settled does not have to wait out the clock as well.
    const windowClosed =
      market.disputeClosesAt !== null && market.disputeClosesAt.getTime() <= Date.now();
    if (!windowClosed && disputes.length === 0) {
      throw new ResolutionFlowError(
        `the dispute window is open until ${market.disputeClosesAt?.toISOString() ?? 'unknown'}`,
      );
    }

    const outcome = await this.prisma.outcome.findUnique({ where: { id: params.outcomeId } });
    if (outcome === null || outcome.marketId !== market.id) {
      throw new ResolutionFlowError('that outcome does not belong to this market');
    }

    // The payout path is untouched: one balanced transaction, escrow released,
    // fees split, bond returned.
    const result = await this.payouts.resolve({
      marketId: market.id,
      winningOutcomeId: params.outcomeId,
      resolvedBy: params.actor.userId,
      evidenceUrl: proposal.evidenceUrl,
    });

    // The payout path finalises the proposal row itself, in the same
    // transaction as the money — a record that says "resolved" while the
    // transaction that paid it rolled back would be worse than no record.
    await this.prisma.market.update({
      where: { id: market.id },
      data: { disputeClosesAt: null },
    });

    // Everyone who was paid, and everyone who argued, hears about it — after the
    // money has moved, because that is when it is true (§2.12).
    for (const payout of result.payouts) {
      if (payout.payout.lte(0)) continue;
      await this.notifications.notify({
        userId: payout.userId,
        type: 'payout',
        body: `${outcome.label} won. ${payout.payout.toFixed(2)} is in your balance.`,
        data: { marketId: market.id },
      });
    }
    for (const dispute of disputes) {
      await this.notifications.notify({
        userId: dispute.userId,
        type: 'dispute_update',
        body: `Your dispute was ${dispute.state}. The market settled on ${outcome.label}.`,
        data: { marketId: market.id },
      });
    }

    await this.audit.record({
      staffId: params.actor.userId,
      action: 'resolution.finalize',
      targetRef: `market:${market.id}`,
      before: { proposedOutcomeId: proposal.proposedOutcomeId, proposedBy: proposal.proposedBy },
      after: {
        finalOutcomeId: params.outcomeId,
        reasoning: params.reasoning.trim(),
        fee: result.fee.toString(),
      },
      ip: params.actor.ip,
    });

    return result;
  }

  /**
   * The dispute window's deadline.
   *
   * Deliberately does not pay anything out: Part 1 §5 has the platform post the
   * Final Resolution, and §6's design signature is that no market settles
   * without a human on the record. All this does is move the market into the
   * resolution centre's queue, once.
   */
  async closeDisputeWindow(marketId: string): Promise<{ outcome: 'due' | 'disputed' | 'skipped' }> {
    const market = await this.prisma.market.findUnique({ where: { id: marketId } });
    if (market === null || market.state !== 'dispute_window' || market.disputeClosesAt === null) {
      return { outcome: 'skipped' };
    }
    if (market.disputeClosesAt.getTime() > Date.now()) return { outcome: 'skipped' };

    const openDisputes = await this.prisma.dispute.count({
      where: { marketId, state: 'open' },
    });
    const label =
      openDisputes > 0
        ? `Dispute window closed — ${openDisputes} to decide`
        : 'Dispute window closed — awaiting the final result';

    const already = await this.prisma.marketAnnotation.findFirst({
      where: { marketId, label },
    });
    if (already === null) {
      await this.prisma.marketAnnotation.create({
        data: { marketId, type: 'resolution', label },
      });
    }

    return { outcome: openDisputes > 0 ? 'disputed' : 'due' };
  }

  /**
   * Freeze markets whose event has started (§7.2's countdown, §2.4's lifecycle).
   *
   * The trade path refuses a trade at or after the event date on its own, so
   * this is not the control — it is the state catching up with the control, so
   * the shelf and the ticket say `frozen` rather than `live` while the match is
   * being played.
   */
  async freezeDueMarkets(now = new Date()): Promise<number> {
    const due = await this.prisma.market.findMany({
      where: { state: 'active', eventDate: { lte: now } },
      select: { id: true },
    });

    for (const market of due) {
      await this.prisma.market.update({
        where: { id: market.id },
        data: { state: 'pending_resolution' },
      });
      await this.prisma.marketAnnotation.create({
        data: { marketId: market.id, type: 'freeze', label: 'Trading frozen — the event started' },
      });
    }
    return due.length;
  }

  private async lock(tx: Tx, marketId: string) {
    await tx.$queryRaw`SELECT id FROM markets WHERE id = ${marketId} FOR UPDATE`;
    return tx.market.findUniqueOrThrow({ where: { id: marketId } });
  }
}

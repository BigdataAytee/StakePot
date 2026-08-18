import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Approval, UserRole } from '@prisma/client';
import { Decimal } from '@stakeam/engine';

import { AdminAuditService } from '../audit/admin-audit.service';
import { MONEY_ROLES } from '../auth/roles.guard';
import { TotpService } from '../auth/totp.service';
import { MarketVoidService } from '../community/void.service';
import { PrizeService } from '../leaderboard/prize.service';
import { NotImplementedError } from '../integrations/errors';
import { LedgerService, type Tx } from '../ledger/ledger.service';
import { SYSTEM_PLATFORM_ACCOUNT } from '../ledger/posting';
import { CONFIG_SCHEMAS, type ConfigKey } from '../platform-config/config-keys';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { APPROVAL_ACTIONS, isApprovalAction, type ApprovalActionType } from './approval-actions';

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export interface Actor {
  readonly userId: string;
  readonly role: UserRole;
  readonly ip: string;
}

const MIN_REASON = 10;

/**
 * The four-eyes workflow (§2.10, §6.4).
 *
 * §6's design signature is "no god button": no screen exists where one person
 * can silently edit a balance, resolve a market without a trail, or spend
 * escrow. This is where that is enforced rather than promised — every action
 * listed in `APPROVAL_ACTIONS` is a proposal first, and the person who proposed
 * it can never be the person who approves it.
 *
 * Approval and execution happen in **one** database transaction. An approved
 * row whose action never ran would be the worst of both worlds: an audit trail
 * saying money moved, and money that did not. If the executor throws, the
 * approval stays pending and the proposer is told why.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly voids: MarketVoidService,
    private readonly config: PlatformConfigService,
    private readonly audit: AdminAuditService,
    private readonly totp: TotpService,
    private readonly prizes: PrizeService,
  ) {}

  /**
   * File a proposal.
   *
   * The payload is validated here, not at approval time: an approver should be
   * signing off on something that is already known to be well-formed, and a
   * proposal that could never execute should never reach their inbox.
   */
  async propose(params: {
    actionType: string;
    payload: unknown;
    reason: string;
    actor: Actor;
  }): Promise<Approval> {
    const { actionType, actor } = params;
    if (!isApprovalAction(actionType)) {
      throw new ApprovalError(`"${actionType}" is not a four-eyes action`);
    }
    if (params.reason.trim().length < MIN_REASON) {
      throw new ApprovalError(
        'a proposal needs a written reason — the approver is agreeing with a case, not a diff',
      );
    }

    const action = APPROVAL_ACTIONS[actionType];
    const parsed = action.schema.safeParse(params.payload);
    if (!parsed.success) {
      throw new ApprovalError(`payload does not match ${actionType}: ${parsed.error.message}`);
    }

    // A config change is checked against the key's own schema too, so a
    // malformed value is refused by the proposer's own screen rather than
    // discovered when it activates.
    if (actionType === 'config.change') {
      this.assertConfigChangeIsValid(parsed.data as { key: string; value: unknown });
    }

    const approval = await this.prisma.approval.create({
      data: {
        actionType,
        payloadJson: parsed.data as Prisma.InputJsonValue,
        requestedBy: actor.userId,
        reason: params.reason.trim(),
        state: 'pending',
      },
    });

    await this.audit.record({
      staffId: actor.userId,
      action: 'approval.propose',
      targetRef: `approval:${approval.id}`,
      after: { actionType, payload: parsed.data as Prisma.InputJsonValue, reason: approval.reason },
      ip: actor.ip,
    });

    return approval;
  }

  /**
   * Approve and execute, as one transaction.
   *
   * §6.4b: "a second, different admin must re-authenticate with their own 2FA
   * and approve. The proposer can never self-approve." The 2FA step-up belongs
   * to the admin session (§2.11) and is enforced at the edge; what belongs here
   * is the part no session can talk its way past — a different person, with a
   * role that is allowed to move money.
   */
  async approve(params: {
    approvalId: string;
    actor: Actor;
    /** The fresh TOTP code §6.4b requires inline on the approve button. */
    totpCode?: string;
  }): Promise<Approval> {
    const { actor } = params;

    const approved = await this.prisma.$transaction(async (tx) => {
      const approval = await tx.approval.findUnique({ where: { id: params.approvalId } });
      if (approval === null) throw new ApprovalError('no such approval');
      if (approval.state !== 'pending') {
        throw new ApprovalError(`this proposal is already ${approval.state}`);
      }
      if (approval.requestedBy === actor.userId) {
        throw new ApprovalError(
          'you proposed this — four eyes means a second person, not a second click',
        );
      }
      if (!isApprovalAction(approval.actionType)) {
        throw new ApprovalError(
          `"${approval.actionType}" has no executor — it cannot be approved into effect`,
        );
      }

      const action = APPROVAL_ACTIONS[approval.actionType];
      if (action.money && !MONEY_ROLES.includes(actor.role)) {
        throw new ApprovalError(
          `moving money needs a ${MONEY_ROLES.join(' or ')} approver — you are ${actor.role}`,
        );
      }

      // §6.4b's step-up, after the questions about *who* this is: there is no
      // point asking somebody to reach for their phone to authorise an action
      // they were never allowed to take. Nothing has been written at this point,
      // so a failed challenge rolls back an empty transaction.
      await this.totp.assertStepUp({
        userId: actor.userId,
        role: actor.role,
        ...(params.totpCode === undefined ? {} : { code: params.totpCode }),
      });

      await this.execute(tx, approval.actionType, approval.payloadJson, {
        approvalId: approval.id,
        proposedBy: approval.requestedBy,
        reason: approval.reason,
        actor,
      });

      const now = new Date();
      const updated = await tx.approval.update({
        where: { id: approval.id },
        data: { state: 'approved', approver1: actor.userId, decidedAt: now, executedAt: now },
      });

      await this.audit.record(
        {
          staffId: actor.userId,
          action: `approval.approve:${approval.actionType}`,
          targetRef: `approval:${approval.id}`,
          before: { state: 'pending', proposedBy: approval.requestedBy },
          after: { state: 'approved', payload: approval.payloadJson as Prisma.InputJsonValue },
          ip: actor.ip,
        },
        tx,
      );

      return updated;
    });

    return approved;
  }

  /**
   * Refuse a proposal, or withdraw your own.
   *
   * Self-rejection is deliberately allowed: you can always take back your own
   * request. What you cannot do is wave it through.
   */
  async reject(params: { approvalId: string; reason: string; actor: Actor }): Promise<Approval> {
    if (params.reason.trim().length < MIN_REASON) {
      throw new ApprovalError('say why — the proposer sees this');
    }

    const approval = await this.prisma.approval.findUnique({ where: { id: params.approvalId } });
    if (approval === null) throw new ApprovalError('no such approval');
    if (approval.state !== 'pending') {
      throw new ApprovalError(`this proposal is already ${approval.state}`);
    }

    const updated = await this.prisma.approval.update({
      where: { id: approval.id },
      data: {
        state: 'rejected',
        approver1: params.actor.userId,
        rejection: params.reason.trim(),
        decidedAt: new Date(),
      },
    });

    await this.audit.record({
      staffId: params.actor.userId,
      action: `approval.reject:${approval.actionType}`,
      targetRef: `approval:${approval.id}`,
      before: { state: 'pending' },
      after: { state: 'rejected', rejection: params.reason.trim() },
      ip: params.actor.ip,
    });

    return updated;
  }

  async pending(): Promise<Approval[]> {
    return this.prisma.approval.findMany({
      where: { state: 'pending' },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Run the approved action.
   *
   * A switch rather than a plugin registry, on purpose: every way a human can
   * move money by hand is visible on one screen of code, and adding another one
   * is a diff a reviewer cannot miss.
   */
  private async execute(
    tx: Tx,
    actionType: ApprovalActionType,
    payload: Prisma.JsonValue,
    context: { approvalId: string; proposedBy: string; reason: string; actor: Actor },
  ): Promise<void> {
    const parsed = APPROVAL_ACTIONS[actionType].schema.parse(payload);

    switch (actionType) {
      case 'market.void_after_activation': {
        const { marketId } = parsed as { marketId: string };
        await tx.$queryRaw`SELECT id FROM markets WHERE id = ${marketId} FOR UPDATE`;
        const market = await tx.market.findUnique({ where: { id: marketId } });
        if (market === null) throw new ApprovalError('no such market');
        if (market.state === 'resolved' || market.state === 'voided') {
          throw new ApprovalError(`market is already ${market.state}`);
        }
        await this.voids.voidAndRefund(tx, marketId, context.reason);
        return;
      }

      case 'bond.forfeit': {
        const { marketId } = parsed as { marketId: string };
        const bond = await tx.bond.findUnique({ where: { marketId } });
        if (bond === null) throw new ApprovalError('this market has no conduct bond');
        if (bond.state !== 'held') throw new ApprovalError(`this bond is already ${bond.state}`);

        const amount = new Decimal(bond.amount.toString());
        // Escrow → platform fees. Rulebook Part 3 §5: "Forfeited bonds fund the
        // platform's dispute-handling", and `platform_fees` is the only class
        // company costs can be paid from (§2.10).
        await this.ledger.post(
          tx,
          [
            {
              userId: bond.creatorId,
              marketId,
              type: 'bond_forfeit',
              fundClass: 'user_escrow',
              amount: amount.negated(),
              currency: 'SPC',
            },
            {
              userId: SYSTEM_PLATFORM_ACCOUNT,
              marketId,
              type: 'bond_forfeit',
              fundClass: 'platform_fees',
              amount,
              currency: 'SPC',
            },
          ],
          `bond-forfeit:${marketId}`,
        );
        await tx.bond.update({
          where: { id: bond.id },
          data: { state: 'forfeited', reason: context.reason, resolvedAt: new Date() },
        });
        return;
      }

      case 'ledger.adjust': {
        const { userId, amount, marketId } = parsed as {
          userId: string;
          amount: string;
          marketId?: string;
        };
        const delta = new Decimal(amount);
        if (delta.isZero()) throw new ApprovalError('an adjustment of zero is not a correction');

        const user = await tx.user.findUnique({ where: { id: userId } });
        if (user === null) throw new ApprovalError('no such user');

        // A correction is a movement between the user and the platform, never a
        // number typed into a balance: the ledger has no update, so the only way
        // to change a total is a new pair of rows that still sums to zero.
        await this.ledger.post(
          tx,
          [
            {
              userId,
              ...(marketId === undefined ? {} : { marketId }),
              type: 'adjustment',
              fundClass: 'user_available',
              amount: delta,
              currency: 'SPC',
            },
            {
              userId: SYSTEM_PLATFORM_ACCOUNT,
              ...(marketId === undefined ? {} : { marketId }),
              type: 'adjustment',
              fundClass: 'platform_fees',
              amount: delta.negated(),
              currency: 'SPC',
            },
          ],
          `adjust:${context.approvalId}`,
        );
        return;
      }

      case 'config.change': {
        const { key, value } = parsed as { key: string; value: unknown };
        this.assertConfigChangeIsValid({ key, value });

        const delayHours = await this.config.get('config_change_delay_hours');
        const effectiveAt = new Date(Date.now() + delayHours * 3_600_000);

        const current = await tx.platformConfig.findFirst({
          where: { key, state: 'active' },
          orderBy: { version: 'desc' },
        });
        const latest = await tx.platformConfig.findFirst({
          where: { key },
          orderBy: { version: 'desc' },
        });

        // §6.4b: the change lands as a *pending* version with a visible delay and
        // never retroactively. The active row keeps serving until the clock says
        // otherwise, which is what "markets already open resolve under the values
        // in force when they opened" requires.
        await tx.platformConfig.create({
          data: {
            key,
            valueJson: value as Prisma.InputJsonValue,
            effectiveAt,
            version: (latest?.version ?? 0) + 1,
            state: 'pending',
          },
        });

        await tx.configVersion.create({
          data: {
            key,
            ...(current === null ? {} : { oldValue: current.valueJson as Prisma.InputJsonValue }),
            newValue: value as Prisma.InputJsonValue,
            reason: context.reason,
            proposedBy: context.proposedBy,
            approvedBy: context.actor.userId,
            // The effective date is decided here, so it is recorded here.
            // `config_versions` is append-only like the ledger, and a history
            // that has to be revisited later to be completed is not one.
            activatedAt: effectiveAt,
          },
        });
        return;
      }

      case 'prize.run': {
        // §6.8's "approve airtime payouts". The run and its awards were drawn
        // up and reviewable long before this; all that happens here is the
        // money, in the same transaction as the signature.
        const { runId } = parsed as { runId: string };
        await this.prizes.pay(tx, runId);
        return;
      }

      case 'withdrawal.release': {
        // Deposits and withdrawals arrive with the licence (§9). The control is
        // built; the rail it guards is not, and pretending otherwise would be
        // worse than saying so.
        throw new NotImplementedError(
          'withdrawals are a licensed-phase rail — no payout processor is wired up yet',
        );
      }
    }
  }

  /** A config value must satisfy its own key's schema before anybody signs it. */
  private assertConfigChangeIsValid(change: { key: string; value: unknown }): void {
    const schema = (
      CONFIG_SCHEMAS as Record<
        string,
        { safeParse: (v: unknown) => { success: boolean; error?: { message: string } } }
      >
    )[change.key];
    if (schema === undefined) {
      throw new ApprovalError(
        `"${change.key}" is not a known config key — a typo must not become a setting`,
      );
    }
    const parsed = schema.safeParse(change.value);
    if (!parsed.success) {
      throw new ApprovalError(
        `value for "${change.key}" is not valid: ${parsed.error?.message ?? 'schema mismatch'}`,
      );
    }
  }
}

export type { ConfigKey };

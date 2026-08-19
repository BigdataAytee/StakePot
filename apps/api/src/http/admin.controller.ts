import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { subHours } from 'date-fns';

import { signReserves } from '../admin/reserves-export';
import { mask } from '../auth/pii';
import { PiiAccessService } from '../audit/pii-access.service';
import { SolvencyService } from '../admin/solvency.service';
import { ApprovalError, ApprovalsService, type Actor } from '../approvals/approvals.service';
import { APPROVAL_ACTIONS, APPROVAL_ACTION_TYPES } from '../approvals/approval-actions';
import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { FundingWindowWorker } from '../community/funding-window.worker';
import { Roles, RolesGuard, STAFF_ROLES } from '../auth/roles.guard';
import { LedgerService } from '../ledger/ledger.service';
import { AdminAuditService } from '../audit/admin-audit.service';
import {
  QuestionEngineService,
  QuestionEngineUnavailableError,
} from '../community/question-engine.service';
import { OfficialMarketError, OfficialMarketService } from '../market/official-market.service';
import { SupportError, SupportService } from '../support/support.service';
import { TotpError } from '../auth/totp.service';
import { PrismaService } from '../prisma/prisma.service';
import { ResolutionFlowError, ResolutionFlowService } from '../resolution/resolution-flow.service';

export class ProposeApprovalDto {
  @IsString() actionType!: string;
  @IsString() @MinLength(10) reason!: string;
  payload!: unknown;
}

export class DecideApprovalDto {
  @IsOptional() @IsString() @MinLength(10) reason?: string;
}

export class ApproveDto {
  /** §6.4b: the approve button triggers the step-up 2FA inline. */
  @IsOptional() @IsString() totpCode?: string;
}

export class OpenDraftDto {
  /** Liquidity constant L (§2.3). ~50× the typical stake for ~1-point moves. */
  @IsOptional() @IsString() liquidityParam?: string;
  @IsOptional() @IsString() seedPerOutcome?: string;
}

export class RejectDraftDto {
  @IsString() @MinLength(5) reason!: string;
}

export class StaffReplyDto {
  @IsString() @MinLength(2) body!: string;
  @IsOptional() @IsBoolean() staffOnly?: boolean;
}

export class ProposeResolutionDto {
  @IsString() outcomeId!: string;
  @IsString() evidenceUrl!: string;
}

export class FinalizeResolutionDto {
  @IsString() outcomeId!: string;
  @IsString() @MinLength(10) reasoning!: string;
}

export class DecideDisputeDto {
  @IsBoolean() upheld!: boolean;
  @IsString() @MinLength(10) decision!: string;
}

export class FileDisputeDto {
  @IsString() evidenceUrl!: string;
  @IsString() @MinLength(20) text!: string;
}

export class LedgerQueryDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() marketId?: string;
  @IsOptional() @IsIn(['SPC', 'NGN']) currency?: 'SPC' | 'NGN';
}

/**
 * The admin cockpit's API (§6).
 *
 * Every endpoint is role-scoped by §6.11's matrix and every state-changing one
 * writes to `admin_audit`. Nothing here can move money on its own: the money
 * verbs are all proposals into the four-eyes workflow, and the resolution verbs
 * are split so that the person who proposes a result is never the person who
 * confirms it.
 */
/**
 * Revealing PII is an action with a reason, not a query parameter.
 *
 * `fields` is explicit so that "I needed to check their email" cannot quietly
 * also hand over a phone number — the log then records what was actually
 * exposed rather than what the endpoint happened to return.
 */
export class RevealDto {
  @IsArray()
  @IsIn(['email', 'phone'], { each: true })
  fields!: ('email' | 'phone')[];

  @IsString() @MinLength(10) @MaxLength(300) reason!: string;
}

@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly solvency: SolvencyService,
    private readonly approvals: ApprovalsService,
    private readonly resolutions: ResolutionFlowService,
    private readonly ledger: LedgerService,
    private readonly windows: FundingWindowWorker,
    private readonly support: SupportService,
    private readonly engine: QuestionEngineService,
    private readonly official: OfficialMarketService,
    private readonly audit: AdminAuditService,
    private readonly pii: PiiAccessService,
  ) {}

  private actor(request: RequestWithUser): Actor {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    return { userId: user.userId, role: user.role as UserRole, ip: request.ip ?? 'unknown' };
  }

  /**
   * §6.1's morning screen: is the money right, and what is waiting for a human.
   */
  @Get('dashboard')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(...(STAFF_ROLES as UserRole[]))
  async dashboard() {
    const since = subHours(new Date(), 24);

    const [
      solvency,
      lastRun,
      liveMarkets,
      volume,
      fees,
      openDisputes,
      pendingApprovals,
      dueResults,
    ] = await Promise.all([
      this.solvency.view(),
      this.prisma.reconciliationRun.findFirst({ orderBy: { runDate: 'desc' } }),
      this.prisma.market.count({ where: { state: 'active' } }),
      this.prisma.trade.aggregate({
        where: { side: { not: 'seed' }, createdAt: { gte: since } },
        _sum: { cost: true },
        _count: true,
      }),
      this.prisma.ledgerEntry.aggregate({
        where: {
          fundClass: 'platform_fees',
          createdAt: { gte: since },
        },
        _sum: { amount: true },
      }),
      this.prisma.dispute.count({ where: { state: 'open' } }),
      this.prisma.approval.count({ where: { state: 'pending' } }),
      this.prisma.market.count({
        where: { state: 'dispute_window', disputeClosesAt: { lte: new Date() } },
      }),
    ]);

    return {
      // Red on this line is the one alarm §6.10 says pages on-call.
      reconciliation: {
        status: lastRun?.status ?? 'never-run',
        runDate: lastRun?.runDate.toISOString() ?? null,
        diff: lastRun?.diff.toString() ?? null,
        clearedBy: lastRun?.clearedBy ?? null,
      },
      solvency: {
        userLiabilities: solvency.userLiabilities.toString(),
        held: solvency.held.toString(),
        surplus: solvency.surplus.toString(),
        byFundClass: {
          user_available: solvency.byFundClass.user_available.toString(),
          user_escrow: solvency.byFundClass.user_escrow.toString(),
          platform_fees: solvency.byFundClass.platform_fees.toString(),
          prize_pool: solvency.byFundClass.prize_pool.toString(),
        },
        escrowByMarketState: solvency.escrowByMarketState.map((row) => ({
          state: row.state,
          escrowed: row.escrowed.toString(),
          markets: row.markets,
        })),
      },
      activity: {
        liveMarkets,
        volume24h: (volume._sum.cost ?? 0).toString(),
        trades24h: volume._count,
        fees24h: (fees._sum.amount ?? 0).toString(),
      },
      queues: { openDisputes, pendingApprovals, resultsDue: dueResults },
    };
  }

  /** §2.10's solvency position, as the money room's header reads it. */
  @Get('reserves')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('finance', 'admin')
  async reserves() {
    const solvency = await this.solvency.view();
    return {
      generatedAt: new Date().toISOString(),
      currency: 'SPC',
      userLiabilities: solvency.userLiabilities.toString(),
      totalIssued: solvency.totalIssued.toString(),
      platformFees: solvency.byFundClass.platform_fees.toString(),
      surplus: solvency.surplus.toString(),
      solvent: solvency.surplus.gte(0),
    };
  }

  /**
   * §2.10's proof-of-reserves export: "one-click signed export ... feeds
   * external attestations and regulator reports".
   *
   * Distinct from `/reserves` above, which renders a panel. This produces a
   * document that leaves the building: every fund class, the account count the
   * liabilities are spread over, the reconciliation run that makes them
   * credible, and a signature over the lot. A solvency figure that only exists
   * inside our own console is not evidence of anything.
   *
   * The export is itself an audited read — somebody asking for the platform's
   * full financial position is exactly the event an audit log is for.
   */
  @Get('reserves/export')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('finance', 'admin')
  async reservesExport(@Req() request: RequestWithUser) {
    const [solvency, lastRun, accounts] = await Promise.all([
      this.solvency.view(),
      this.prisma.reconciliationRun.findFirst({ orderBy: { runDate: 'desc' } }),
      this.prisma.wallet.count({ where: { currency: 'SPC' } }),
    ]);

    const document = signReserves(
      {
        currency: 'SPC',
        userLiabilities: solvency.userLiabilities.toString(),
        totalIssued: solvency.totalIssued.toString(),
        platformFees: solvency.byFundClass.platform_fees.toString(),
        surplus: solvency.surplus.toString(),
        byFundClass: Object.fromEntries(
          Object.entries(solvency.byFundClass).map(([name, total]) => [name, total.toString()]),
        ),
        accounts,
        reconciliation: {
          runDate: lastRun?.runDate.toISOString().slice(0, 10) ?? null,
          status: lastRun?.status ?? 'never_run',
          diff: lastRun?.diff.toString() ?? null,
        },
      },
      new Date().toISOString(),
    );

    const actor = this.actor(request);
    await this.audit.record({
      staffId: actor.userId,
      action: 'reserves.export',
      targetRef: 'platform:reserves',
      after: { generatedAt: document.generatedAt, signed: document.signature !== null },
      ip: actor.ip,
    });

    return document;
  }

  /** §6.4's ledger explorer: drill from any balance to the entries behind it. */
  @Get('ledger')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('finance', 'admin')
  async ledgerEntries(@Query() query: LedgerQueryDto) {
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        ...(query.userId === undefined ? {} : { userId: query.userId }),
        ...(query.marketId === undefined ? {} : { marketId: query.marketId }),
        ...(query.currency === undefined ? {} : { currency: query.currency }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return entries.map((entry) => ({
      id: entry.id,
      userId: entry.userId,
      marketId: entry.marketId,
      type: entry.type,
      fundClass: entry.fundClass,
      amount: entry.amount.toString(),
      currency: entry.currency,
      ref: entry.ref,
      createdAt: entry.createdAt.toISOString(),
    }));
  }

  @Get('reconciliation')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('finance', 'admin')
  async reconciliationHistory() {
    const runs = await this.prisma.reconciliationRun.findMany({
      orderBy: { runDate: 'desc' },
      take: 30,
    });
    return runs.map((run) => ({
      id: run.id,
      runDate: run.runDate.toISOString(),
      status: run.status,
      diff: run.diff.toString(),
      ledgerTotal: run.ledgerTotal.toString(),
      walletTotal: run.walletTotal.toString(),
      clearedBy: run.clearedBy,
    }));
  }

  // ------------------------------------------------------------- approvals

  /** The catalogue, so the console can build its own forms from one source. */
  @Get('approvals/actions')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(...(STAFF_ROLES as UserRole[]))
  actions() {
    return APPROVAL_ACTION_TYPES.map((type) => ({
      type,
      summary: APPROVAL_ACTIONS[type].summary,
      money: APPROVAL_ACTIONS[type].money,
    }));
  }

  @Get('approvals')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(...(STAFF_ROLES as UserRole[]))
  async pendingApprovals() {
    const pending = await this.approvals.pending();

    return Promise.all(
      pending.map(async (approval) => ({
        id: approval.id,
        actionType: approval.actionType,
        summary:
          approval.actionType in APPROVAL_ACTIONS
            ? APPROVAL_ACTIONS[approval.actionType as keyof typeof APPROVAL_ACTIONS].summary
            : approval.actionType,
        payload: approval.payloadJson,
        // §6.4b wants the card to show *what changes, old → new*. For a config
        // change the "old" is a live value the proposal does not carry, so it is
        // resolved here rather than left for the approver to go and look up.
        current: await this.currentValueFor(approval.actionType, approval.payloadJson),
        reason: approval.reason,
        requestedBy: approval.requestedBy,
        createdAt: approval.createdAt.toISOString(),
      })),
    );
  }

  /** The value a proposal would replace, where there is one. */
  private async currentValueFor(actionType: string, payload: unknown): Promise<unknown> {
    if (actionType !== 'config.change') return null;
    const key = (payload as { key?: unknown }).key;
    if (typeof key !== 'string') return null;

    const active = await this.prisma.platformConfig.findFirst({
      where: { key, state: 'active' },
      orderBy: { version: 'desc' },
    });
    return active?.valueJson ?? null;
  }

  @Post('approvals')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(...(STAFF_ROLES as UserRole[]))
  async propose(@Req() request: RequestWithUser, @Body() body: ProposeApprovalDto) {
    const approval = await this.run(() =>
      this.approvals.propose({
        actionType: body.actionType,
        payload: body.payload,
        reason: body.reason,
        actor: this.actor(request),
      }),
    );
    return { id: approval.id, state: approval.state };
  }

  @Post('approvals/:id/approve')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(...(STAFF_ROLES as UserRole[]))
  async approve(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Body() body: ApproveDto,
  ) {
    const approval = await this.run(() =>
      this.approvals.approve({
        approvalId: id,
        actor: this.actor(request),
        ...(body.totpCode === undefined ? {} : { totpCode: body.totpCode }),
      }),
    );
    return { id: approval.id, state: approval.state, executedAt: approval.executedAt };
  }

  @Post('approvals/:id/reject')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(...(STAFF_ROLES as UserRole[]))
  async reject(
    @Req() request: RequestWithUser,
    @Param('id') id: string,
    @Body() body: DecideApprovalDto,
  ) {
    const approval = await this.run(() =>
      this.approvals.reject({
        approvalId: id,
        reason: body.reason ?? '',
        actor: this.actor(request),
      }),
    );
    return { id: approval.id, state: approval.state };
  }

  // ---------------------------------------------------- resolution centre

  /**
   * §6.3's work queue: everything waiting on a human, with the context needed to
   * decide it on one screen — the proposal, the market's own rules, the named
   * source, and any disputes filed against it.
   */
  @Get('resolution-queue')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async resolutionQueue() {
    const markets = await this.prisma.market.findMany({
      where: { state: { in: ['pending_resolution', 'dispute_window'] } },
      include: {
        outcomes: { orderBy: { ordinal: 'asc' } },
        resolutions: { orderBy: { proposedAt: 'desc' }, take: 1 },
        disputes: { orderBy: { createdAt: 'asc' } },
      },
      orderBy: { eventDate: 'asc' },
      take: 50,
    });

    return markets.map((market) => {
      const proposal = market.resolutions[0];
      return {
        id: market.id,
        question: market.question,
        shelf: market.shelf,
        state: market.state,
        creatorId: market.creatorId,
        sourceName: market.sourceName,
        sourceUrl: market.sourceUrl,
        criteria: market.criteriaJson,
        eventDate: market.eventDate.toISOString(),
        voidDate: market.voidDate.toISOString(),
        pot: market.potTotal.toString(),
        disputeClosesAt: market.disputeClosesAt?.toISOString() ?? null,
        windowClosed:
          market.disputeClosesAt !== null && market.disputeClosesAt.getTime() <= Date.now(),
        outcomes: market.outcomes.map((o) => ({
          id: o.id,
          label: o.label,
          price: o.priceCurrent.toString(),
          staked: o.stakedTotal.toString(),
        })),
        proposal:
          proposal === undefined
            ? null
            : {
                id: proposal.id,
                proposedBy: proposal.proposedBy,
                proposedOutcomeId: proposal.proposedOutcomeId,
                evidenceUrl: proposal.evidenceUrl,
                proposedAt: proposal.proposedAt.toISOString(),
                finalizedAt: proposal.finalizedAt?.toISOString() ?? null,
              },
        disputes: market.disputes.map((dispute) => ({
          id: dispute.id,
          userId: dispute.userId,
          state: dispute.state,
          evidenceUrl: dispute.evidenceUrl,
          text: dispute.text,
          decision: dispute.decision,
          createdAt: dispute.createdAt.toISOString(),
        })),
      };
    });
  }

  @Post('markets/:id/resolution/propose')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async proposeResolution(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: ProposeResolutionDto,
  ) {
    const { resolution, disputeClosesAt } = await this.run(() =>
      this.resolutions.propose({
        marketId,
        outcomeId: body.outcomeId,
        evidenceUrl: body.evidenceUrl,
        actor: this.actor(request),
      }),
    );
    await this.windows.scheduleDisputeWindow(marketId, disputeClosesAt);
    return { id: resolution.id, disputeClosesAt: disputeClosesAt.toISOString() };
  }

  @Post('markets/:id/resolution/finalize')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async finalizeResolution(
    @Req() request: RequestWithUser,
    @Param('id') marketId: string,
    @Body() body: FinalizeResolutionDto,
  ) {
    const result = await this.run(() =>
      this.resolutions.finalize({
        marketId,
        outcomeId: body.outcomeId,
        reasoning: body.reasoning,
        actor: this.actor(request),
      }),
    );
    return {
      state: 'resolved',
      fee: result.fee.toString(),
      losingPool: result.losingPool.toString(),
      bondRefunded: result.bondRefunded.toString(),
      paid: result.payouts.length,
    };
  }

  @Post('disputes/:id/decide')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async decideDispute(
    @Req() request: RequestWithUser,
    @Param('id') disputeId: string,
    @Body() body: DecideDisputeDto,
  ) {
    const dispute = await this.run(() =>
      this.resolutions.decideDispute({
        disputeId,
        upheld: body.upheld,
        decision: body.decision,
        actor: this.actor(request),
      }),
    );
    return { id: dispute.id, state: dispute.state };
  }

  // ------------------------------------------------------- drafts queue (§6.2)

  /**
   * §6.2's ranked drafts: what the engine suggests, and what it refused.
   *
   * Refusals are included on request rather than hidden — a queue that shows
   * only what the engine liked tells an operator nothing about how it is
   * behaving, and §2.9's feedback loop is meant to be watched.
   */
  @Get('drafts')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async drafts(@Query('includeRejected') includeRejected?: string) {
    return this.engine.queue({ includeRejected: includeRejected === 'true' });
  }

  /**
   * Ask the engine for a fresh cycle of suggestions (§2.9 rule 8: replacements,
   * not additions — it only drafts for slots the shelf has free).
   */
  @Post('drafts/generate')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async generateDrafts(@Req() request: RequestWithUser) {
    const actor = this.actor(request);
    const drafted = await this.run(() => this.engine.generate());
    await this.audit.record({
      staffId: actor.userId,
      action: 'draft.generate',
      targetRef: 'shelf:official',
      after: {
        drafted: drafted.length,
        accepted: drafted.filter((d) => d.state === 'suggested').length,
      },
      ip: actor.ip,
    });
    return drafted;
  }

  /** The one-click open: the rules run again, then the platform seeds it. */
  @Post('drafts/:id/open')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async openDraft(
    @Req() request: RequestWithUser,
    @Param('id') draftId: string,
    @Body() body: OpenDraftDto,
  ) {
    const actor = this.actor(request);
    return this.run(() =>
      this.official.openFromDraft({
        draftId,
        staffId: actor.userId,
        ip: actor.ip,
        ...(body.liquidityParam === undefined ? {} : { liquidityParam: body.liquidityParam }),
        ...(body.seedPerOutcome === undefined ? {} : { seedPerOutcome: body.seedPerOutcome }),
      }),
    );
  }

  @Post('drafts/:id/reject')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('resolver', 'admin')
  async rejectDraft(
    @Req() request: RequestWithUser,
    @Param('id') draftId: string,
    @Body() body: RejectDraftDto,
  ) {
    const actor = this.actor(request);
    await this.run(() =>
      this.official.rejectDraft({
        draftId,
        staffId: actor.userId,
        reason: body.reason,
        ip: actor.ip,
      }),
    );
    return { state: 'rejected' };
  }

  // -------------------------------------------------------- support desk (§6.7)

  /**
   * The queue, with the user's read-only context and nothing else — no balances,
   * because §6.7 says the support role never sees ledger internals.
   */
  @Get('support')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('support', 'trust_safety', 'admin')
  async supportQueue(@Query('state') state?: 'open' | 'escalated' | 'waiting_on_user') {
    return this.support.queue(state === undefined ? {} : { state });
  }

  @Post('support/:id/reply')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('support', 'trust_safety', 'admin')
  async supportReply(
    @Req() request: RequestWithUser,
    @Param('id') ticketId: string,
    @Body() body: StaffReplyDto,
  ) {
    const actor = this.actor(request);
    const ticket = await this.run(() =>
      this.support.reply({
        ticketId,
        authorId: actor.userId,
        authorRole: actor.role,
        body: body.body,
        ...(body.staffOnly === undefined ? {} : { staffOnly: body.staffOnly }),
      }),
    );
    return { id: ticket.id, state: ticket.state };
  }

  @Post('support/:id/resolve')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('support', 'trust_safety', 'admin')
  async supportResolve(@Req() request: RequestWithUser, @Param('id') ticketId: string) {
    const actor = this.actor(request);
    const ticket = await this.run(() =>
      this.support.resolve({ ticketId, staffId: actor.userId, role: actor.role }),
    );
    return { id: ticket.id, state: ticket.state };
  }

  /**
   * A member's account, with their contact details masked (§2.11).
   *
   * This screen used to print everybody's email and phone number to everybody
   * who opened it. Most PII exposure is not a stolen database — it is a
   * support console that hands out contact details as a side effect of
   * answering "is this the right account", which a masked value answers just
   * as well. Revealing is a second, logged call.
   */
  @Get('users/:id')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('trust_safety', 'finance', 'admin')
  async user(@Param('id') userId: string) {
    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, phone: true, tier: true, role: true, status: true },
    });
    if (found === null) throw new NotFoundException('no such user');

    const user = {
      ...found,
      email: mask('email', found.email),
      phone: mask('phone', found.phone),
      masked: true,
    };

    const derived = await this.ledger.deriveBalance(userId, 'SPC');
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency: 'SPC' } },
    });

    return {
      user,
      // Both figures, side by side, on purpose: the wallet row is a cache and
      // the ledger is the truth, and an operator should be able to see them
      // disagree rather than be told a number.
      derived: { available: derived.available.toString(), escrowed: derived.escrowed.toString() },
      wallet: {
        available: wallet?.available.toString() ?? '0',
        escrowed: wallet?.escrowed.toString() ?? '0',
      },
    };
  }

  /**
   * Reveal a member's contact details, on the record (§2.11).
   *
   * The reason is mandatory and stored. Not because a determined insider
   * cannot type a plausible one, but because it makes every access a
   * deliberate act with a name attached — and because a review of one agent's
   * reasons over a month is where the pattern shows up.
   *
   * The log is written before the value is returned. If the trail cannot be
   * written, the access does not happen: a best-effort log is optional exactly
   * when the database is unhealthy, which is when it matters most.
   */
  @Post('users/:id/reveal')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('trust_safety', 'admin')
  async reveal(
    @Req() request: RequestWithUser,
    @Param('id') userId: string,
    @Body() body: RevealDto,
  ) {
    const actor = this.actor(request);
    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, phone: true },
    });
    if (found === null) throw new NotFoundException('no such user');

    await this.pii.record({
      staffId: actor.userId,
      subjectId: userId,
      fields: body.fields,
      reason: body.reason,
      ip: actor.ip,
    });

    return {
      email: body.fields.includes('email') ? found.email : undefined,
      phone: body.fields.includes('phone') ? found.phone : undefined,
    };
  }

  /** Who has looked at this account, and why. Shown beside the account. */
  @Get('users/:id/access-log')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('trust_safety', 'admin')
  async accessLog(@Param('id') userId: string) {
    const rows = await this.pii.forSubject(userId);
    return rows.map((row) => ({
      staffId: row.staffId,
      fields: row.fields,
      reason: row.reason,
      at: row.createdAt.toISOString(),
    }));
  }

  /** Rulebook and workflow refusals are 400s with the sentence, not stack traces. */
  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof ApprovalError ||
        error instanceof ResolutionFlowError ||
        error instanceof SupportError ||
        error instanceof TotpError ||
        error instanceof OfficialMarketError ||
        error instanceof QuestionEngineUnavailableError
      ) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}

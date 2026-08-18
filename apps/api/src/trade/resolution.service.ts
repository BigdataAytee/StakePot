import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Decimal, resolve as engineResolve, splitResolutionFee } from '@stakeam/engine';

import { LedgerService, type Tx } from '../ledger/ledger.service';
import { indexOf, toEngineState } from '../market/market-state';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { SYSTEM_PLATFORM_ACCOUNT, type Posting } from '../ledger/posting';

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionError';
  }
}

export interface ResolveInput {
  readonly marketId: string;
  readonly winningOutcomeId: string;
  readonly resolvedBy: string;
  readonly evidenceUrl: string;
}

export interface ResolveOutcome {
  readonly fee: Decimal;
  readonly losingPool: Decimal;
  readonly creatorFee: Decimal;
  readonly platformFee: Decimal;
  readonly payouts: readonly { userId: string; shares: Decimal; payout: Decimal }[];
}

const dec = (v: Decimal | { toString(): string }): Prisma.Decimal =>
  new Prisma.Decimal(v.toString());

/**
 * Resolution and per-share payout (§2.3, §2.6).
 *
 * The engine decides the arithmetic; this decides the bookkeeping. Its one job
 * is to make sure what the engine says was distributed is exactly what the
 * ledger records leaving escrow — which is why the whole thing is a single
 * balanced transaction rather than a payout loop.
 */
@Injectable()
export class ResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly config: PlatformConfigService,
  ) {}

  async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM markets WHERE id = ${input.marketId} FOR UPDATE`;

      const market = await tx.market.findUniqueOrThrow({
        where: { id: input.marketId },
        include: { outcomes: { orderBy: { ordinal: 'asc' } } },
      });

      if (market.state === 'resolved' || market.state === 'voided') {
        throw new ResolutionError(`market is already ${market.state}`);
      }

      const exitFeeRate = await this.config.get('exit_fee_rate');
      const loaded = toEngineState(market, market.outcomes, exitFeeRate);
      const winnerIndex = indexOf(loaded, input.winningOutcomeId);

      // Every outstanding winning share must be attributed for the payout to
      // conserve — the engine refuses otherwise, and it is right to.
      const positions = await tx.position.findMany({
        where: { marketId: input.marketId, outcomeId: input.winningOutcomeId },
      });
      const holdings = positions
        .filter((p) => new Decimal(p.shares.toString()).gt(0))
        .map((p) => ({ holderId: p.userId, shares: p.shares.toString() }));

      const feeRate = new Decimal(market.feeBps).div(10_000);
      const result = engineResolve(loaded.state, winnerIndex, feeRate.toString(), holdings);

      const fee = new Decimal(result.fee.toString());
      const losingPool = new Decimal(result.losingPool.toString());

      // §2.3: community 7% splits 4 creator / 3 platform; official is all
      // platform. The split is config, and the remainder trick keeps the two
      // legs summing to the fee exactly.
      const creatorBps =
        market.shelf === 'community' && market.creatorId !== null
          ? await this.config.get('community_creator_bps')
          : 0;
      const platformBps =
        market.shelf === 'community' && market.creatorId !== null
          ? await this.config.get('community_platform_bps')
          : market.feeBps;
      const split = splitResolutionFee(fee.toString(), { creatorBps, platformBps });
      const creatorFee = new Decimal(split.creator.toString());
      const platformFee = new Decimal(split.platform.toString());

      const postings: Posting[] = [];

      // Everyone's stake leaves escrow; winners' payouts arrive in available.
      const allPositions = await tx.position.findMany({ where: { marketId: input.marketId } });
      for (const position of allPositions) {
        const staked = await this.escrowedFor(tx, position.userId, input.marketId);
        if (staked.isZero()) continue;
        postings.push({
          userId: position.userId,
          marketId: input.marketId,
          type: 'payout',
          fundClass: 'user_escrow',
          amount: staked.negated(),
          currency: 'SPC',
        });
      }

      const payouts = result.payouts.map((p) => ({
        userId: p.holderId,
        shares: new Decimal(p.shares.toString()),
        payout: new Decimal(p.payout.toString()),
      }));

      for (const payout of payouts) {
        if (payout.payout.isZero()) continue;
        postings.push({
          userId: payout.userId,
          marketId: input.marketId,
          type: 'payout',
          fundClass: 'user_available',
          amount: payout.payout,
          currency: 'SPC',
        });
      }

      if (platformFee.gt(0)) {
        postings.push({
          userId: SYSTEM_PLATFORM_ACCOUNT,
          marketId: input.marketId,
          type: 'fee_platform',
          fundClass: 'platform_fees',
          amount: platformFee,
          currency: 'SPC',
        });
      }
      if (creatorFee.gt(0) && market.creatorId !== null) {
        postings.push({
          userId: market.creatorId,
          marketId: input.marketId,
          type: 'fee_creator',
          fundClass: 'user_available',
          amount: creatorFee,
          currency: 'SPC',
        });
      }

      // If this does not sum to zero the engine and the ledger disagree about
      // what the market held, and neither is safe to trust.
      await this.ledger.post(tx, postings, `resolve:${input.marketId}`);

      await tx.resolution.create({
        data: {
          marketId: input.marketId,
          proposedBy: input.resolvedBy,
          proposedOutcomeId: input.winningOutcomeId,
          evidenceUrl: input.evidenceUrl,
          finalizedBy: input.resolvedBy,
          finalizedAt: new Date(),
          finalOutcomeId: input.winningOutcomeId,
        },
      });

      await tx.market.update({
        where: { id: input.marketId },
        data: {
          state: 'resolved',
          resolvedOutcomeId: input.winningOutcomeId,
          resolutionEvidence: input.evidenceUrl,
          potTotal: dec(new Decimal(0)),
        },
      });

      await tx.marketAnnotation.create({
        data: { marketId: input.marketId, type: 'resolution', label: 'Market resolved' },
      });

      return { fee, losingPool, creatorFee, platformFee, payouts };
    });
  }

  /** What this user still has escrowed in this market, straight from the ledger. */
  private async escrowedFor(tx: Tx, userId: string, marketId: string): Promise<Decimal> {
    const result = await tx.ledgerEntry.aggregate({
      where: { userId, marketId, fundClass: 'user_escrow' },
      _sum: { amount: true },
    });
    return new Decimal(result._sum.amount?.toString() ?? '0');
  }
}

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
  /** Who the creator fee actually went to — the creator, or the syndicate (§3). */
  readonly creatorLegs: readonly { userId: string; amount: Decimal }[];
  /** The conduct bond returned to the creator on a clean resolution (Part 3 §5). */
  readonly bondRefunded: Decimal;
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
      // §2.14c's level 3 fee bump rides on `market.creatorBps`, stamped when the
      // market opened. Falling back to config covers markets opened before the
      // ladder existed — they settle under exactly the split they opened under.
      const configuredCreatorBps =
        market.shelf === 'community' && market.creatorId !== null
          ? (market.creatorBps ?? (await this.config.get('community_creator_bps')))
          : 0;
      // Clamped to the fee the market actually charges. A creator share above
      // it would make the platform's leg negative, and a misconfigured level
      // must not be able to stop every community market settling.
      const creatorBps = Math.min(configuredCreatorBps, market.feeBps);
      const platformBps =
        market.shelf === 'community' && market.creatorId !== null
          ? market.feeBps - creatorBps
          : market.feeBps;
      const split = splitResolutionFee(fee.toString(), { creatorBps, platformBps });
      const creatorFee = new Decimal(split.creator.toString());
      const platformFee = new Decimal(split.platform.toString());

      const postings: Posting[] = [];

      // A conduct bond sits in the creator's escrow alongside their stakes, and
      // it is not part of the pot — so it has to leave escrow as its own leg and
      // land back in the creator's balance. Rulebook Part 3 §5: "The Conduct Bond
      // is refunded after clean resolution." Without this the transaction cannot
      // balance at all: escrow would give up more than the pot ever held.
      const bond = await tx.bond.findUnique({ where: { marketId: input.marketId } });
      const bondHeld =
        bond !== null && bond.state === 'held'
          ? new Decimal(bond.amount.toString())
          : new Decimal(0);

      // Everyone's escrow in this market is released; winners' payouts arrive in
      // available. Read straight off the ledger rather than from positions, so a
      // creator holding nothing but a bond is still accounted for, and so anyone
      // holding two outcomes is released exactly once — every binary market
      // hides that second bug, because there one trader is one position.
      const escrowRows = await tx.ledgerEntry.groupBy({
        by: ['userId'],
        where: { marketId: input.marketId, fundClass: 'user_escrow' },
        _sum: { amount: true },
      });
      for (const row of escrowRows) {
        const escrowed = new Decimal(row._sum.amount?.toString() ?? '0');
        if (escrowed.lte(0)) continue;
        const isCreatorBond = bondHeld.gt(0) && row.userId === bond?.creatorId;
        const staked = isCreatorBond ? escrowed.minus(bondHeld) : escrowed;

        if (staked.gt(0)) {
          postings.push({
            userId: row.userId,
            marketId: input.marketId,
            type: 'payout',
            fundClass: 'user_escrow',
            amount: staked.negated(),
            currency: 'SPC',
          });
        }
        if (isCreatorBond) {
          postings.push(
            {
              userId: row.userId,
              marketId: input.marketId,
              type: 'bond_refund',
              fundClass: 'user_escrow',
              amount: bondHeld.negated(),
              currency: 'SPC',
            },
            {
              userId: row.userId,
              marketId: input.marketId,
              type: 'bond_refund',
              fundClass: 'user_available',
              amount: bondHeld,
              currency: 'SPC',
            },
          );
        }
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
      // §3: "The [4]% creator fee becomes the syndicate fee." Where a syndicate
      // seeded the market, the creator's leg is divided among the sponsors on
      // the split locked when the round opened; otherwise it is the creator's.
      const creatorLegs = await this.creatorFeeLegs(
        tx,
        input.marketId,
        market.creatorId,
        creatorFee,
      );
      for (const leg of creatorLegs) {
        if (leg.amount.lte(0)) continue;
        postings.push({
          userId: leg.userId,
          marketId: input.marketId,
          type: 'fee_creator',
          fundClass: 'user_available',
          amount: leg.amount,
          currency: 'SPC',
        });
      }

      // If this does not sum to zero the engine and the ledger disagree about
      // what the market held, and neither is safe to trust.
      await this.ledger.post(tx, postings, `resolve:${input.marketId}`);

      // One market, one resolution record. Where a result was proposed and sat
      // through a dispute window (§2.6), that row is the record and this
      // finalises it — writing a second one would claim the resolver had also
      // proposed it, and the resolution log is the licensing exhibit. Only a
      // market resolved without a proposal (an official market settled directly)
      // creates its row here.
      const open = await tx.resolution.findFirst({
        where: { marketId: input.marketId, finalizedAt: null },
        orderBy: { proposedAt: 'desc' },
      });

      if (open === null) {
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
      } else {
        await tx.resolution.update({
          where: { id: open.id },
          data: {
            finalizedBy: input.resolvedBy,
            finalizedAt: new Date(),
            finalOutcomeId: input.winningOutcomeId,
          },
        });
      }

      await tx.market.update({
        where: { id: input.marketId },
        data: {
          state: 'resolved',
          resolvedOutcomeId: input.winningOutcomeId,
          resolutionEvidence: input.evidenceUrl,
          potTotal: dec(new Decimal(0)),
        },
      });

      if (bondHeld.gt(0) && bond !== null) {
        await tx.bond.update({
          where: { id: bond.id },
          data: { state: 'refunded', resolvedAt: new Date() },
        });
      }

      await tx.marketAnnotation.create({
        data: { marketId: input.marketId, type: 'resolution', label: 'Market resolved' },
      });

      return {
        fee,
        losingPool,
        creatorFee,
        platformFee,
        payouts,
        creatorLegs,
        bondRefunded: bondHeld,
      };
    });
  }

  /**
   * Who the creator fee belongs to (Rulebook Part 3 §3).
   *
   * Solo creator: all of it. Syndicate: the organiser's locked cut first, then
   * the rest pro-rata on the shares written when the round filled. The last leg
   * is the remainder, so the legs sum to the fee exactly — dividing twice and
   * hoping the parts add up is how money goes missing a kobo at a time.
   */
  private async creatorFeeLegs(
    tx: Tx,
    marketId: string,
    creatorId: string | null,
    creatorFee: Decimal,
  ): Promise<readonly { userId: string; amount: Decimal }[]> {
    if (creatorFee.lte(0) || creatorId === null) return [];

    const syndicate = await tx.syndicate.findUnique({
      where: { marketId },
      include: { members: { orderBy: { createdAt: 'asc' } } },
    });
    if (syndicate === null || syndicate.state !== 'filled' || syndicate.members.length === 0) {
      return [{ userId: creatorId, amount: creatorFee }];
    }

    const legs = new Map<string, Decimal>();
    const add = (userId: string, amount: Decimal): void => {
      legs.set(userId, (legs.get(userId) ?? new Decimal(0)).plus(amount));
    };

    const organiserCut = creatorFee.times(syndicate.organiserBps).div(10_000);
    if (organiserCut.gt(0)) add(creatorId, organiserCut);

    const pool = creatorFee.minus(organiserCut);
    let allocated = new Decimal(0);
    for (const [index, member] of syndicate.members.entries()) {
      const last = index === syndicate.members.length - 1;
      const share = last
        ? pool.minus(allocated)
        : pool.times(new Decimal(member.feeSharePct.toString()));
      allocated = allocated.plus(share);
      add(member.userId, share);
    }

    return [...legs.entries()].map(([userId, amount]) => ({ userId, amount }));
  }
}

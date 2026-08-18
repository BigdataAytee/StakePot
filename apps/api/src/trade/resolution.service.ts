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
 * The scale money is stored at: `Decimal(38, 18)` on every money column.
 *
 * Postings are brought to it *before* they are balanced rather than being
 * rounded on the way into Postgres, so what the ledger asserts and what the
 * database holds are the same numbers.
 */
const STORAGE_DP = 18;

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
      const creatorFee = new Decimal(split.creator.toString()).toDecimalPlaces(
        STORAGE_DP,
        Decimal.ROUND_DOWN,
      );
      const platformFee = new Decimal(split.platform.toString()).toDecimalPlaces(
        STORAGE_DP,
        Decimal.ROUND_DOWN,
      );

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

      // Quantised to the storage scale on the way in.
      //
      // The columns hold `Decimal(38, 18)`, so anything finer is rounded when
      // it is written anyway — but until it *is* rounded, the postings span
      // forty-odd orders of magnitude (a 3.8e6 payout beside a 1e-37 tail), and
      // a sum across that range cannot be exact at any fixed precision. Once
      // every leg is a whole multiple of 1e-18 the sum is exact, because the
      // largest realistic pot still leaves the total well inside 40 significant
      // digits. This is also what makes the *stored* ledger balance to zero
      // rather than to within a quantum per row.
      const payouts = result.payouts.map((p) => ({
        userId: p.holderId,
        shares: new Decimal(p.shares.toString()),
        payout: new Decimal(p.payout.toString()).toDecimalPlaces(STORAGE_DP, Decimal.ROUND_DOWN),
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

      // The engine conserves the pot *within a scaled tolerance*, deliberately:
      // its arithmetic runs on a logarithmic cost curve at 40 significant
      // digits, and `pot − fee` then `+ fee` is not associative at fixed
      // precision — no arrangement of the operations makes it so. The ledger's
      // contract is stricter and has to be: `assertBalanced` requires postings
      // summing to zero *to the digit*, because money that does not balance is
      // money invented by a write.
      //
      // Those two contracts meet here, so this is where the gap is closed. The
      // largest payout leg absorbs the difference — largest so the adjustment is
      // relatively smallest, and chosen deterministically so the same market
      // resolved twice produces identical postings. The correction is bounded by
      // the engine's own tolerance: fractions of 1e-30 SPC, a dozen orders of
      // magnitude below the storage quantum and thirty below one kobo.
      //
      // Left unclosed this was not theoretical. A syndicated market has a dozen
      // holders, which gives the rounding a dozen chances to bite, and the
      // market would simply fail to resolve — intermittently, depending on the
      // share ratios the trading happened to produce.
      balanceOnLargestPayout(postings);

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
      // Every leg lands on the storage scale, for the same reason the payouts
      // do: a set of postings that are all whole multiples of 1e-18 can be
      // summed exactly, and one that is not, cannot.
      const quantised = amount.toDecimalPlaces(STORAGE_DP, Decimal.ROUND_DOWN);
      legs.set(userId, (legs.get(userId) ?? new Decimal(0)).plus(quantised));
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

/**
 * Fold a transaction's rounding residual into one payout leg.
 *
 * Only ever adjusts a `payout` posting landing in `user_available`: the escrow
 * releases are read from stored ledger rows and must not be restated, and the
 * fee legs are what the platform is owed under §2.3. The winner's share is the
 * one quantity that is a division in the first place, so it is the honest place
 * for a division's remainder to land.
 *
 * The **smallest** payout absorbs it, not the largest. That is counter-intuitive
 * — the relative adjustment is biggest there — but it is the only choice that
 * works: at 40 significant digits, subtracting ~1e-37 from a payout of ~3.8e6
 * is a no-op, so the correction silently does nothing and the transaction is
 * refused anyway. A smaller leg has the precision headroom to actually carry
 * it. The amounts involved are fractions of 1e-30 SPC, thirty orders of
 * magnitude below one kobo, so "biggest relative adjustment" is a rounding
 * error on a rounding error; being *effective* is what matters.
 *
 * Ties are broken by user id so the same market resolved twice produces
 * identical postings.
 *
 * A no-op when the postings already balance, which is the common case.
 */
export function balanceOnLargestPayout(postings: Posting[]): void {
  const residual = postings.reduce((acc, posting) => acc.plus(posting.amount), new Decimal(0));
  if (residual.isZero()) return;

  let target = -1;
  for (const [index, posting] of postings.entries()) {
    if (posting.type !== 'payout' || posting.fundClass !== 'user_available') continue;
    if (posting.amount.lte(0)) continue;
    const best = target === -1 ? undefined : postings[target];
    if (
      best === undefined ||
      posting.amount.lt(best.amount) ||
      (posting.amount.equals(best.amount) && posting.userId < best.userId)
    ) {
      target = index;
    }
  }

  // Nothing was paid out — a market where every winning share was already
  // exited. There is no leg that can absorb it, and `assertBalanced` should say
  // so loudly rather than have this quietly paper over a real imbalance.
  if (target === -1) return;

  const chosen = postings[target];
  if (chosen === undefined) return;
  postings[target] = { ...chosen, amount: chosen.amount.minus(residual) };
}

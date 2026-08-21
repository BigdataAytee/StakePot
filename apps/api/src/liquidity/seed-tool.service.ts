import { Injectable } from '@nestjs/common';
import type { LiquidityMode } from '@prisma/client';
import { Decimal, priceOf, topUpSymmetric } from '@stakeam/engine';

import { AdminAuditService } from '../audit/admin-audit.service';
import { SeedService } from '../community/seed.service';
import { toEngineState } from '../market/market-state';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformConfigService } from '../platform-config/platform-config.service';
import { largestWithinImpact } from '../trade/max-impact';
import { MarketMakerService } from './market-maker.service';
import { LiquidityModeService } from './mode.service';

export class SeedToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedToolError';
  }
}

export interface SeedPreview {
  readonly marketId: string;
  readonly perOutcome: string;
  readonly outcomes: number;
  readonly total: string;
  readonly potBefore: string;
  readonly potAfter: string;
  /** Price per outcome before and after. They are the same, and that is the point. */
  readonly pricesBefore: readonly string[];
  readonly pricesAfter: readonly string[];
  readonly priceMoved: boolean;
  /**
   * The most one trader can stake in a single trade under the impact ceiling,
   * before and after. **These are equal, always** — see `absorbsMore`.
   */
  readonly maxStakeBefore: string;
  readonly maxStakeAfter: string;
  /**
   * Whether the seed makes the market able to absorb a larger single stake.
   *
   * It is always `false`, and saying so on the screen is the point. A
   * symmetric seed adds money to the pot without changing the liquidity
   * constant L, and the LMSR's price — and therefore its sensitivity to the
   * next trade — depends only on L and on the *differences* between share
   * counts. Adding δ to every outcome cancels out of both:
   *
   *     p_i(q + δ·1) = e^((q_i+δ)/L) / Σ e^((q_j+δ)/L) = p_i(q)
   *
   * So a seed makes the pot bigger to win, and changes nothing whatsoever
   * about how far the next stake moves the price. An operator seeding a
   * jumpy market in the hope of steadying it is doing the wrong thing, and
   * would have no way of knowing unless the tool told them: the number they
   * are watching would go up, and the thing they wanted would not happen.
   *
   * The dial for that is L, set when the market is written (rule 24).
   */
  readonly absorbsMore: boolean;
  readonly mode: LiquidityMode;
}

export interface SeedRow {
  readonly marketId: string;
  readonly question: string;
  readonly shelf: string;
  readonly state: string;
  readonly pot: string;
  /** What the platform has put in through this tool. */
  readonly seedPlaced: string;
  readonly split: readonly { readonly label: string; readonly price: string }[];
  readonly maxStake: string;
  readonly hasMaker: boolean;
  readonly seedable: boolean;
}

/**
 * The seed tool's arithmetic and its table.
 *
 * The execution itself already exists — `SeedService.topUpOfficial` runs the
 * symmetric top-up through the engine, into the ledger, under the market's row
 * lock, with its guards. This service is what the *screen* needs: what would
 * happen if I did it, and what does every market look like now.
 *
 * The preview is computed by running the real engine function on a copy of the
 * real state. Nothing here approximates: a preview that models the outcome
 * with its own arithmetic is a preview that can differ from the thing it
 * previews, and the difference shows up as money.
 */
@Injectable()
export class SeedToolService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seeds: SeedService,
    private readonly config: PlatformConfigService,
    private readonly modes: LiquidityModeService,
    private readonly makers: MarketMakerService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * What a seed would do, before anybody commits to it.
   *
   * The prices before and after are both shown, and they are equal — that is
   * the claim the operator is being asked to believe, and showing both is how
   * they check it rather than trust it.
   */
  async preview(input: {
    marketId: string;
    perOutcome: string;
    mode?: LiquidityMode;
  }): Promise<SeedPreview> {
    const mode = await this.modes.resolve(input.mode);

    const perOutcome = new Decimal(input.perOutcome);
    if (perOutcome.lte(0)) throw new SeedToolError('a seed has to be more than nothing');

    const market = await this.prisma.market.findUnique({
      where: { id: input.marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    if (market === null) throw new SeedToolError('no such market');

    const loaded = toEngineState(market, market.outcomes, 0);
    const ceilingBps = Math.round(Number(await this.config.get('max_impact_bps')));

    const before = loaded.state.q.map((_, index) =>
      priceOf(loaded.state.q, loaded.state.liquidity, index),
    );
    // The real engine call, on a copy. Not a model of it.
    const result = topUpSymmetric(loaded.state, perOutcome.toString());
    const after = result.pricesAfter;

    const bound = new Decimal(10_000_000);
    return {
      marketId: market.id,
      perOutcome: perOutcome.toString(),
      outcomes: market.outcomes.length,
      total: result.total.toString(),
      potBefore: loaded.state.pot.toString(),
      potAfter: result.state.pot.toString(),
      pricesBefore: before.map((price) => price.toDecimalPlaces(6).toString()),
      pricesAfter: after.map((price) => price.toDecimalPlaces(6).toString()),
      priceMoved: before.some((price, index) =>
        price
          .minus(after[index] ?? price)
          .abs()
          .gt('1e-12'),
      ),
      maxStakeBefore: largestWithinImpact({
        state: loaded.state,
        index: 0,
        ceilingBps,
        upperBound: bound,
      })
        .toDecimalPlaces(0, Decimal.ROUND_DOWN)
        .toString(),
      maxStakeAfter: largestWithinImpact({
        state: result.state,
        index: 0,
        ceilingBps,
        upperBound: bound,
      })
        .toDecimalPlaces(0, Decimal.ROUND_DOWN)
        .toString(),
      // Computed rather than hardcoded to `false`: it is a claim about the
      // engine, and if the engine ever stops being translation-invariant this
      // should start saying so rather than keep asserting the old truth.
      absorbsMore: largestWithinImpact({
        state: result.state,
        index: 0,
        ceilingBps,
        upperBound: bound,
      }).gt(largestWithinImpact({ state: loaded.state, index: 0, ceilingBps, upperBound: bound })),
      mode,
    };
  }

  /**
   * Run it.
   *
   * Delegates the money entirely to `SeedService.topUpOfficial`, which is the
   * one place a symmetric top-up happens — the tool adds the mode to the audit
   * record and tells the maker that this market has been seeded, so §E's
   * stacking confirmation has something to check.
   */
  async execute(input: {
    marketId: string;
    perOutcome: string;
    reason: string;
    requestId: string;
    staffId: string;
    ip: string;
    mode?: LiquidityMode;
  }): Promise<{ marketId: string; added: string; potAfter: string; mode: LiquidityMode }> {
    const mode = await this.modes.resolve(input.mode);

    const reason = input.reason.trim();
    if (reason.length < 3) throw new SeedToolError('say why — it goes in the audit log');

    const before = await this.prisma.market.findUnique({
      where: { id: input.marketId },
      select: { potTotal: true, state: true },
    });
    if (before === null) throw new SeedToolError('no such market');

    const applied = await this.seeds.topUpOfficial({
      marketId: input.marketId,
      perOutcome: input.perOutcome,
      requestId: input.requestId,
    });

    await this.makers.noteSeed(input.marketId, input.staffId);

    await this.audit.record({
      staffId: input.staffId,
      action: 'liquidity.seed:execute',
      targetRef: `market:${input.marketId}`,
      before: { potTotal: before.potTotal.toString(), state: before.state },
      after: {
        mode,
        perOutcome: applied.perOutcome.toString(),
        added: applied.total.toString(),
        potTotal: applied.potAfter.toString(),
        reason,
      },
      ip: input.ip,
    });

    return {
      marketId: input.marketId,
      added: applied.total.toString(),
      potAfter: applied.potAfter.toString(),
      mode,
    };
  }

  /** Every market the tool can act on, with what an operator needs to choose. */
  async table(): Promise<SeedRow[]> {
    const [markets, seeded, ceilingRaw] = await Promise.all([
      this.prisma.market.findMany({
        where: { state: { in: ['draft', 'seeding', 'funding', 'active', 'frozen'] } },
        include: {
          outcomes: { orderBy: { ordinal: 'asc' } },
          maker: { select: { enabled: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      // What this tool has put in, read from the ledger rather than a column:
      // the ledger is what actually happened, and a stored total is a second
      // number that can disagree with it.
      this.prisma.ledgerEntry.groupBy({
        by: ['marketId'],
        where: { type: 'seed', fundClass: 'user_escrow', ref: { startsWith: 'official-topup:' } },
        _sum: { amount: true },
      }),
      this.config.get('max_impact_bps'),
    ]);

    const ceilingBps = Math.round(Number(ceilingRaw));
    const placed = new Map(
      seeded.map((row) => [row.marketId ?? '', new Decimal((row._sum.amount ?? 0).toString())]),
    );
    const bound = new Decimal(10_000_000);

    return markets.map((market) => {
      const loaded = toEngineState(market, market.outcomes, 0);
      return {
        marketId: market.id,
        question: market.question,
        shelf: market.shelf,
        state: market.state,
        pot: market.potTotal.toString(),
        seedPlaced: (placed.get(market.id) ?? new Decimal(0)).abs().toString(),
        split: market.outcomes.map((outcome, index) => ({
          label: outcome.label,
          price: priceOf(loaded.state.q, loaded.state.liquidity, index)
            .toDecimalPlaces(4)
            .toString(),
        })),
        maxStake: largestWithinImpact({
          state: loaded.state,
          index: 0,
          ceilingBps,
          upperBound: bound,
        })
          .toDecimalPlaces(0, Decimal.ROUND_DOWN)
          .toString(),
        hasMaker: market.maker !== null,
        // The tool only tops up official markets that are still open — the same
        // rule `topUpOfficial` enforces, shown so the button can be disabled
        // rather than fail on click.
        seedable:
          market.shelf === 'official' &&
          ['draft', 'seeding', 'funding', 'active'].includes(market.state),
      };
    });
  }
}

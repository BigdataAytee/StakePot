import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Market, MarketShelf, Outcome } from '@prisma/client';

import { PlatformConfigService } from '../platform-config/platform-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { toEngineState, type LoadedMarket } from './market-state';

export interface CreateMarketInput {
  readonly shelf: MarketShelf;
  readonly question: string;
  readonly sourceName: string;
  readonly sourceUrl: string;
  readonly criteria: Prisma.InputJsonValue;
  readonly edgeCases: Prisma.InputJsonValue;
  readonly eventDate: Date;
  readonly voidDate: Date;
  /** Liquidity constant L. §2.3: ~50× the typical stake for ~1-point moves. */
  readonly liquidityParam: string;
  /**
   * The complete outcome list. §2.5 requires community markets to declare one,
   * plus an "Any other" catch-all — a candidate list that cannot express the
   * result is how a market ends up in dispute.
   */
  readonly outcomeLabels: readonly string[];
  /**
   * Label of the catch-all bucket, appended last. Nothing stops a caller from
   * naming it something else, but it is always the final ordinal so the field
   * reads in rank order with the bucket at the bottom.
   */
  readonly otherLabel?: string;
  readonly creatorId?: string;
}

@Injectable()
export class MarketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PlatformConfigService,
  ) {}

  /**
   * Create a market. Official markets skip funding and open `active` (§2.4);
   * community markets start `draft` and go through the activation paths.
   */
  async create(input: CreateMarketInput): Promise<Market & { outcomes: Outcome[] }> {
    if (input.outcomeLabels.length < 2) {
      throw new Error('a market needs at least two outcomes');
    }
    const labels = [
      ...input.outcomeLabels.map((label) => ({ label, isOther: false })),
      ...(input.otherLabel === undefined ? [] : [{ label: input.otherLabel, isOther: true }]),
    ];
    const duplicate = labels.find((l, i) => labels.findIndex((o) => o.label === l.label) !== i);
    if (duplicate !== undefined) {
      throw new Error(`outcome "${duplicate.label}" is listed twice`);
    }
    if (input.voidDate <= input.eventDate) {
      throw new Error('void date must fall after the event date');
    }

    const feeBps = await this.config.get(
      input.shelf === 'official' ? 'official_fee_bps' : 'community_fee_bps',
    );

    return this.prisma.market.create({
      data: {
        shelf: input.shelf,
        question: input.question,
        sourceName: input.sourceName,
        sourceUrl: input.sourceUrl,
        criteriaJson: input.criteria,
        edgeCasesJson: input.edgeCases,
        eventDate: input.eventDate,
        voidDate: input.voidDate,
        liquidityParam: new Prisma.Decimal(input.liquidityParam),
        feeBps,
        ...(input.creatorId === undefined ? {} : { creatorId: input.creatorId }),
        state: input.shelf === 'official' ? 'active' : 'draft',
        outcomes: {
          create: labels.map((outcome, ordinal) => ({
            label: outcome.label,
            ordinal,
            isOther: outcome.isOther,
            // Opening prices are uniform; the first trade moves them.
            priceCurrent: new Prisma.Decimal(1).div(labels.length),
          })),
        },
        annotations: {
          create: { type: 'open', label: 'Market opened' },
        },
      },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
  }

  /** Load a market as engine state. */
  async load(marketId: string): Promise<LoadedMarket & { market: Market }> {
    const market = await this.prisma.market.findUniqueOrThrow({
      where: { id: marketId },
      include: { outcomes: { orderBy: { ordinal: 'asc' } } },
    });
    const exitFeeRate = await this.config.get('exit_fee_rate');
    return { ...toEngineState(market, market.outcomes, exitFeeRate), market };
  }

  /**
   * Freeze trading (§2.3: "markets freeze when the underlying event begins").
   *
   * Not merely cosmetic: it is what stops a near-certain outcome being exited at
   * the expense of everyone still holding.
   */
  async freeze(marketId: string, reason = 'Event started'): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.market.update({ where: { id: marketId }, data: { state: 'frozen' } });
      await tx.marketAnnotation.create({
        data: { marketId, type: 'freeze', label: reason },
      });
    });
  }
}

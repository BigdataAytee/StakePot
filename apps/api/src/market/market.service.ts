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
  readonly outcomeLabels: readonly string[];
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
          create: input.outcomeLabels.map((label, ordinal) => ({
            label,
            ordinal,
            // Opening prices are uniform; the first trade moves them.
            priceCurrent: new Prisma.Decimal(1).div(input.outcomeLabels.length),
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
